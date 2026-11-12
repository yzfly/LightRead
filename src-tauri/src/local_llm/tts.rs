//! 本机语音 Qwen3-TTS: llama.cpp 的实验性语音生成接口 (libmtmd 的 `mtmd_helper_gen_audio_*`)。
//! 流程与 llama.cpp 的 tools/tts 相同: 主干模型读入文本 → 逐帧采样语义码 → mmproj 里的声码器出波形。
//! llama-cpp-2 的安全封装不暴露底层指针, 这里直接用 llama-cpp-sys-2; 所有指针只在引擎锁内使用。
//! 所有函数都是阻塞的, 由 mod.rs 放到独立线程执行。

use llama_cpp_sys_2 as sys;
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

/// 一段文字用到的上下文: 文本 + 每帧一格。按 12 帧/秒算, 2048 够一分多钟, 实际一次只合成一两句
const N_CTX: u32 = 2048;
const N_BATCH: i32 = 512;
/// 每秒的帧数 (Qwen3-TTS 12Hz 编码)
const FRAMES_PER_SECOND: i32 = 12;

pub(crate) struct TtsRequest {
    pub model_id: String,
    pub model_path: PathBuf,
    pub mmproj_path: PathBuf,
    /// 参考音色 (wav / mp3); 没有就用模型的默认声音
    pub speaker_path: Option<PathBuf>,
    pub text: String,
    /// zh / en / ja … (llama.cpp 的 --tts-lang)
    pub lang: String,
    pub threads: i32,
    pub use_gpu: bool,
    pub request_id: u64,
    /// 内存不宽裕: 加载前先释放翻译模型
    pub exclusive: bool,
}

#[derive(Debug)]
pub(crate) struct TtsStats {
    pub frames: i32,
    pub load_ms: u64,
    pub gen_ms: u64,
    /// 生成的音频时长
    pub audio_ms: u64,
    pub gpu: bool,
    pub cancelled: bool,
}

/// 一次合成最多多少帧: 按字数估 (中文约 4 字/秒, 西文约 15 字符/秒), 留一倍余量;
/// 模型没有自己停下来时不至于一直生成到上下文用完。
pub(crate) fn frame_budget(text: &str) -> i32 {
    let mut seconds = 0.0f32;
    for ch in text.chars() {
        seconds += if ch.is_ascii() { 1.0 / 15.0 } else { 1.0 / 4.0 };
    }
    let frames = (seconds * 2.0 * FRAMES_PER_SECOND as f32) as i32 + 3 * FRAMES_PER_SECOND;
    frames.clamp(4 * FRAMES_PER_SECOND, N_CTX as i32 - 600)
}

struct Loaded {
    id: String,
    gpu: bool,
    speaker_path: Option<PathBuf>,
    model: *mut sys::llama_model,
    ctx: *mut sys::llama_context,
    mctx: *mut sys::mtmd_context,
    speaker: *mut sys::mtmd_bitmap,
    gen: *mut sys::mtmd_helper_gen_audio,
    sampler: *mut sys::llama_sampler,
}

// 指针只在持有 ENGINE 锁时使用
unsafe impl Send for Loaded {}

impl Drop for Loaded {
    fn drop(&mut self) {
        // 与创建顺序相反
        unsafe {
            if !self.sampler.is_null() {
                sys::llama_sampler_free(self.sampler);
            }
            if !self.gen.is_null() {
                sys::mtmd_helper_gen_audio_free(self.gen);
            }
            if !self.speaker.is_null() {
                sys::mtmd_bitmap_free(self.speaker);
            }
            if !self.mctx.is_null() {
                sys::mtmd_free(self.mctx);
            }
            if !self.ctx.is_null() {
                sys::llama_free(self.ctx);
            }
            if !self.model.is_null() {
                sys::llama_model_free(self.model);
            }
        }
    }
}

static ENGINE: Mutex<Option<Loaded>> = Mutex::new(None);
static CANCEL_UPTO: AtomicU64 = AtomicU64::new(0);
static LAST_USED_MS: AtomicU64 = AtomicU64::new(0);

pub(crate) fn cancel(request_id: u64) {
    CANCEL_UPTO.fetch_max(request_id, Ordering::SeqCst);
}

/// 应用退出: 让正在合成的那一段尽快停下
pub(crate) fn cancel_all() {
    CANCEL_UPTO.store(u64::MAX, Ordering::SeqCst);
}

fn cancelled(request_id: u64) -> bool {
    request_id <= CANCEL_UPTO.load(Ordering::SeqCst)
}

pub(crate) fn unload(only: Option<&str>) {
    if let Ok(mut guard) = ENGINE.lock() {
        if only.is_none_or(|id| guard.as_ref().is_some_and(|l| l.id == id)) {
            *guard = None;
            LAST_USED_MS.store(0, Ordering::SeqCst);
        }
    }
}

/// 空闲超过 idle_ms 就释放; 正在使用时什么也不做。返回是否仍有模型在内存里。
pub(crate) fn unload_if_idle(idle_ms: u64) -> bool {
    let last = LAST_USED_MS.load(Ordering::SeqCst);
    if last == 0 {
        return false;
    }
    if super::engine::now_ms().saturating_sub(last) < idle_ms {
        return true;
    }
    match ENGINE.try_lock() {
        Ok(mut guard) => {
            if super::engine::now_ms().saturating_sub(LAST_USED_MS.load(Ordering::SeqCst)) >= idle_ms {
                *guard = None;
                LAST_USED_MS.store(0, Ordering::SeqCst);
                false
            } else {
                true
            }
        }
        Err(_) => true,
    }
}

fn c_path(path: &Path) -> Result<CString, String> {
    CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "路径无效".to_string())
}

fn load_speaker(mctx: *mut sys::mtmd_context, path: &Path) -> Result<*mut sys::mtmd_bitmap, String> {
    let c = c_path(path)?;
    let wrapper = unsafe { sys::mtmd_helper_bitmap_init_from_file(mctx, c.as_ptr(), false, sys::mtmd_helper_init_opt_default()) };
    if wrapper.bitmap.is_null() {
        return Err("参考音色文件读取失败".into());
    }
    Ok(wrapper.bitmap)
}

fn load(req: &TtsRequest, gpu: bool) -> Result<Loaded, String> {
    // 字段逐个填进一个空壳, 中途失败时由 Drop 释放已创建的部分
    let mut loaded = Loaded {
        id: req.model_id.clone(),
        gpu,
        speaker_path: None,
        model: ptr::null_mut(),
        ctx: ptr::null_mut(),
        mctx: ptr::null_mut(),
        speaker: ptr::null_mut(),
        gen: ptr::null_mut(),
        sampler: ptr::null_mut(),
    };
    unsafe {
        let mut model_params = sys::llama_model_default_params();
        model_params.n_gpu_layers = if gpu { 999 } else { 0 };
        loaded.model = sys::llama_model_load_from_file(c_path(&req.model_path)?.as_ptr(), model_params);
        if loaded.model.is_null() {
            return Err("语音模型加载失败".into());
        }

        let mut ctx_params = sys::llama_context_default_params();
        ctx_params.n_ctx = N_CTX;
        ctx_params.n_batch = N_BATCH as u32;
        ctx_params.n_threads = req.threads;
        ctx_params.n_threads_batch = req.threads;
        // 声码器要用主干的隐藏状态
        ctx_params.embeddings = true;
        loaded.ctx = sys::llama_init_from_model(loaded.model, ctx_params);
        if loaded.ctx.is_null() {
            return Err("创建语音上下文失败（内存不足？）".into());
        }

        let mut mtmd_params = sys::mtmd_context_params_default();
        mtmd_params.use_gpu = gpu;
        mtmd_params.print_timings = false;
        mtmd_params.n_threads = req.threads;
        loaded.mctx = sys::mtmd_init_from_file(c_path(&req.mmproj_path)?.as_ptr(), loaded.model, mtmd_params);
        if loaded.mctx.is_null() {
            return Err("语音模型的声码器加载失败".into());
        }
        if sys::mtmd_gen_audio_get_info(loaded.mctx).type_ == sys::MTMD_GEN_AUDIO_TYPE_NONE {
            return Err("这个模型不支持语音生成".into());
        }
        loaded.gen = sys::mtmd_helper_gen_audio_init(loaded.ctx, loaded.mctx);
        if loaded.gen.is_null() {
            return Err("语音生成器初始化失败".into());
        }

        // 语义码的采样: Qwen3-TTS 官方生成参数 (top_k 50 / temperature 0.9 / 重复惩罚 1.05; top_p 为 1.0 即不裁剪)
        let chain = sys::llama_sampler_chain_init(sys::llama_sampler_chain_default_params());
        let n_vocab = sys::llama_vocab_n_tokens(sys::llama_model_get_vocab(loaded.model));
        sys::llama_sampler_chain_add(chain, sys::llama_sampler_init_penalties(n_vocab, 64, 1.05, 0.0, 0.0));
        sys::llama_sampler_chain_add(chain, sys::llama_sampler_init_top_k(50));
        sys::llama_sampler_chain_add(chain, sys::llama_sampler_init_temp(0.9));
        // 固定种子: 各段之间音色与语气更一致
        sys::llama_sampler_chain_add(chain, sys::llama_sampler_init_dist(7));
        loaded.sampler = chain;
    }
    Ok(loaded)
}

/// 合成一段文字, 返回 16-bit 单声道 WAV。闪退标记由调用方在加载前立好。
pub(crate) fn synthesize(req: &TtsRequest) -> Result<(Vec<u8>, TtsStats), String> {
    let backend = super::engine::backend()?;
    let _slot = super::engine::SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let mut guard = ENGINE.lock().map_err(|_| "本机语音引擎锁已损坏".to_string())?;
    let mut stats = TtsStats { frames: 0, load_ms: 0, gen_ms: 0, audio_ms: 0, gpu: false, cancelled: false };
    if cancelled(req.request_id) {
        stats.cancelled = true;
        return Ok((Vec::new(), stats));
    }
    let text = req.text.trim();
    if text.is_empty() {
        return Err("没有可朗读的文字".into());
    }

    let want_gpu = req.use_gpu && backend.supports_gpu_offload();
    if guard.as_ref().is_none_or(|l| l.id != req.model_id || (l.gpu && !want_gpu)) {
        // 先释放旧模型再加载, 免得几份同时占内存
        *guard = None;
        if req.exclusive {
            super::engine::unload(None);
        }
        let started = Instant::now();
        let loaded = match load(req, want_gpu) {
            Ok(l) => l,
            Err(_) if want_gpu => load(req, false)?,
            Err(e) => return Err(e),
        };
        stats.load_ms = started.elapsed().as_millis() as u64;
        *guard = Some(loaded);
    }
    let loaded = guard.as_mut().expect("tts model loaded above");
    stats.gpu = loaded.gpu;

    // 参考音色换了才重新读文件
    if loaded.speaker_path != req.speaker_path {
        unsafe {
            if !loaded.speaker.is_null() {
                sys::mtmd_bitmap_free(loaded.speaker);
                loaded.speaker = ptr::null_mut();
            }
        }
        loaded.speaker_path = None;
        if let Some(path) = &req.speaker_path {
            loaded.speaker = load_speaker(loaded.mctx, path)?;
            loaded.speaker_path = Some(path.clone());
        }
    }

    let prompt = CString::new(text.replace('\0', " ")).map_err(|_| "文字无效".to_string())?;
    let lang = CString::new(req.lang.as_str()).map_err(|_| "语言无效".to_string())?;
    let started = Instant::now();
    let wav = unsafe {
        // 上一段留下的上下文全部清掉: 每段从头开始
        sys::llama_memory_clear(sys::llama_get_memory(loaded.ctx), true);
        sys::mtmd_helper_gen_audio_reset(loaded.gen);
        sys::llama_sampler_reset(loaded.sampler);

        let mut inp: sys::mtmd_helper_gen_audio_inp = std::mem::zeroed();
        inp.seq_id = 0;
        inp.prompt = prompt.as_ptr();
        inp.prompt_len = prompt.as_bytes().len();
        inp.speaker_ref = loaded.speaker;
        inp.lang = lang.as_ptr();
        // 0 = 用这条管线的默认值 (top_k 50 / top_p 1.0)
        inp.top_k = 0;
        inp.top_p = 0.0;
        inp.seed = 7;
        inp.out_type = sys::MTMD_HELPER_GEN_AUDIO_OUTTYPE_WAV;
        if sys::mtmd_helper_gen_audio_set_input(loaded.gen, &inp) != 0 {
            return Err("语音输入无效（不支持的语言或文字过长）".into());
        }
        loop {
            let left = sys::mtmd_helper_gen_audio_step_prompt(loaded.gen, N_BATCH);
            if left < 0 {
                return Err("语音模型读入文字失败".into());
            }
            if left == 0 {
                break;
            }
            if cancelled(req.request_id) {
                stats.cancelled = true;
                LAST_USED_MS.store(super::engine::now_ms(), Ordering::SeqCst);
                return Ok((Vec::new(), stats));
            }
        }

        let budget = frame_budget(text);
        let mut sampled = sys::llama_sampler_sample(loaded.sampler, loaded.ctx, -1);
        let mut h_state: *const f32 = sys::llama_get_embeddings_ith(loaded.ctx, -1);
        if h_state.is_null() {
            return Err("语音模型没有给出隐藏状态".into());
        }
        let mut stop = false;
        while !stop && stats.frames < budget {
            if cancelled(req.request_id) {
                stats.cancelled = true;
                LAST_USED_MS.store(super::engine::now_ms(), Ordering::SeqCst);
                return Ok((Vec::new(), stats));
            }
            let mut h_next: *const f32 = ptr::null();
            if sys::mtmd_helper_gen_audio_step_gen(loaded.gen, sampled, h_state, &mut h_next, &mut stop) != 0 {
                return Err(format!("语音生成在第 {} 帧失败", stats.frames));
            }
            if h_next.is_null() {
                break;
            }
            stats.frames += 1;
            h_state = h_next;
            sampled = sys::llama_sampler_sample(loaded.sampler, loaded.ctx, -1);
        }

        let mut sample_rate: i32 = 0;
        let mut data: *const std::os::raw::c_char = ptr::null();
        let mut len: usize = 0;
        let mut n_samples: i64 = 0;
        if sys::mtmd_helper_gen_audio_get_output(loaded.gen, &mut sample_rate, &mut data, &mut len, &mut n_samples) != 0 || data.is_null() || len == 0 {
            return Err("语音波形生成失败".into());
        }
        if sample_rate > 0 {
            stats.audio_ms = (n_samples.max(0) as u64) * 1000 / sample_rate as u64;
        }
        // data 只在下一次调用前有效: 复制出来
        std::slice::from_raw_parts(data as *const u8, len).to_vec()
    };
    stats.gen_ms = started.elapsed().as_millis() as u64;
    LAST_USED_MS.store(super::engine::now_ms(), Ordering::SeqCst);
    Ok((wav, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_budget_scales_with_text_and_stays_inside_the_context() {
        // 20 个汉字约 5 秒: 预算约 10 秒 + 3 秒
        let zh = frame_budget("满纸荒唐言，一把辛酸泪。都云作者痴，谁解其中味");
        assert!((120..=220).contains(&zh), "{zh}");
        let en = frame_budget("I went down yesterday to the Piraeus with Glaucon the son of Ariston.");
        assert!((100..=200).contains(&en), "{en}");
        assert_eq!(frame_budget("好"), 4 * FRAMES_PER_SECOND, "很短的也给足起码的帧数");
        assert_eq!(frame_budget(&"长".repeat(5000)), N_CTX as i32 - 600, "不会超过上下文");
    }

    #[test]
    fn cancelling_covers_earlier_requests_only() {
        cancel(7);
        assert!(cancelled(7) && !cancelled(8));
    }

    /// 真实模型:
    /// LOCAL_TTS_TEST_DIR=<含 model.gguf / mmproj.gguf / 可选 speaker.wav 的目录> [LOCAL_TTS_TEST_OUT=<目录>] \
    ///   cargo test --lib -- --ignored speaks_with_a_real_model --nocapture
    #[test]
    #[ignore]
    fn speaks_with_a_real_model() {
        let dir = PathBuf::from(std::env::var("LOCAL_TTS_TEST_DIR").expect("LOCAL_TTS_TEST_DIR"));
        let speaker = Some(dir.join("speaker.wav")).filter(|p| p.exists());
        let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 8) as i32;
        let gpu = std::env::var("LOCAL_TTS_TEST_CPU").is_err();
        let run = |text: &str, lang: &str, id: u64| {
            let (wav, stats) = synthesize(&TtsRequest {
                model_id: "test".into(),
                model_path: dir.join("model.gguf"),
                mmproj_path: dir.join("mmproj.gguf"),
                speaker_path: speaker.clone(),
                text: text.into(),
                lang: lang.into(),
                threads,
                use_gpu: gpu,
                request_id: id,
                exclusive: false,
            })
            .expect("synthesize");
            println!("{stats:?} wav={} bytes  realtime x{:.2}", wav.len(), stats.audio_ms as f32 / stats.gen_ms.max(1) as f32);
            assert_eq!(&wav[..4], b"RIFF");
            assert!(stats.frames > 12 && stats.audio_ms > 1000, "{stats:?}");
            // 模型给出的 WAV 能被变速那一步认出来 (单声道 16-bit), 加快后变短
            let (rate, samples) = crate::local_llm::stretch::parse_wav(&wav).expect("16-bit mono wav");
            assert_eq!(samples.len() as u64 * 1000 / rate as u64, stats.audio_ms);
            let (_, faster) = crate::local_llm::stretch::parse_wav(&crate::local_llm::stretch::stretch_wav(wav.clone(), 1.25)).unwrap();
            let ratio = samples.len() as f32 / faster.len() as f32;
            assert!((ratio - 1.25).abs() < 0.06, "stretch ratio {ratio}");
            if let Ok(out) = std::env::var("LOCAL_TTS_TEST_OUT") {
                std::fs::write(Path::new(&out).join(format!("qwen-{id}.wav")), &wav).unwrap();
            }
            stats
        };
        let first = run("满纸荒唐言，一把辛酸泪。都云作者痴，谁解其中味？", "zh", 100);
        assert!(first.load_ms > 0);
        // 20 个字不该读出半分钟: 模型自己停了下来, 没有撞到帧数预算
        assert!(first.audio_ms < 15_000, "{first:?}");
        let second = run("I went down yesterday to the Piraeus with Glaucon the son of Ariston.", "en", 101);
        assert_eq!(second.load_ms, 0, "model stays loaded between sentences");
        // 同一句再读一遍: 时长相近 (声码器内部的随机数不随每段重置, 不保证逐帧相同)
        let again = run("满纸荒唐言，一把辛酸泪。都云作者痴，谁解其中味？", "zh", 102);
        assert!((again.frames - first.frames).abs() <= first.frames / 4, "{again:?} vs {first:?}");
        unsafe {
            let mut usage: libc::rusage = std::mem::zeroed();
            libc::getrusage(libc::RUSAGE_SELF, &mut usage);
            println!("max rss: {} MB", usage.ru_maxrss as u64 / if cfg!(target_os = "macos") { 1 << 20 } else { 1 << 10 });
        }
        unload(None);
    }
}
