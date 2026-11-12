//! llama.cpp (llama-cpp-2) 的进程内封装: 模型常驻一份, 每次请求新建上下文, 逐段吐出文本。
//! 所有函数都是阻塞的, 由 mod.rs 放到独立线程执行。

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// 一次解码送入的 token 数
const N_BATCH: usize = 512;

pub(crate) struct GenRequest {
    pub model_id: String,
    pub model_path: PathBuf,
    /// 用户消息; 套用模型自带的对话模板后送入
    pub prompt: String,
    pub max_tokens: u32,
    pub n_ctx: u32,
    pub threads: i32,
    pub use_gpu: bool,
    pub request_id: u64,
    pub sampling: Sampling,
}

#[derive(Clone, Copy)]
pub(crate) struct Sampling {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: i32,
    pub repeat_penalty: f32,
}

#[derive(Debug)]
pub(crate) struct GenStats {
    pub prompt_tokens: u32,
    pub tokens: u32,
    /// 模型加载耗时 (已在内存里时为 0)
    pub load_ms: u64,
    /// 读入原文的耗时
    pub prompt_ms: u64,
    /// 生成译文的耗时
    pub gen_ms: u64,
    pub gpu: bool,
    pub cancelled: bool,
}

pub(crate) const TOO_LONG_ERROR: &str = "LOCAL_LLM_TOO_LONG";

struct Loaded {
    id: String,
    model: LlamaModel,
    gpu: bool,
}

static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
static ENGINE: Mutex<Option<Loaded>> = Mutex::new(None);
/// 编号不大于它的请求都已取消 (前端编号单调递增)
static CANCEL_UPTO: AtomicU64 = AtomicU64::new(0);
/// 最近一次用完引擎的时刻 (毫秒, 相对 EPOCH), 0 = 没有加载
static LAST_USED_MS: AtomicU64 = AtomicU64::new(0);
static EPOCH: OnceLock<Instant> = OnceLock::new();

fn now_ms() -> u64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

fn backend() -> Result<&'static LlamaBackend, String> {
    BACKEND
        .get_or_init(|| {
            // llama.cpp 默认把加载日志写到 stderr; 关掉, 失败原因由返回值给出
            llama_cpp_2::send_logs_to_tracing(llama_cpp_2::LogOptions::default().with_logs_enabled(false));
            LlamaBackend::init().map_err(|e| format!("本机模型引擎启动失败: {e}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 这个构建能否把计算放到显卡 (macOS Metal / 开了 Vulkan 的构建)
pub(crate) fn gpu_supported() -> bool {
    backend().map(|b| b.supports_gpu_offload()).unwrap_or(false)
}

pub(crate) fn cancel(request_id: u64) {
    CANCEL_UPTO.fetch_max(request_id, Ordering::SeqCst);
}

fn cancelled(request_id: u64) -> bool {
    request_id <= CANCEL_UPTO.load(Ordering::SeqCst)
}

/// 释放模型 (删除文件前、长时间不用后)。`only` 给出时只释放这个模型。
pub(crate) fn unload(only: Option<&str>) {
    if let Ok(mut guard) = ENGINE.lock() {
        if only.is_none_or(|id| guard.as_ref().is_some_and(|l| l.id == id)) {
            *guard = None;
            LAST_USED_MS.store(0, Ordering::SeqCst);
        }
    }
}

/// 空闲超过 idle_ms 就释放模型; 正在使用 (锁被占) 时什么也不做。返回是否仍有模型在内存里。
pub(crate) fn unload_if_idle(idle_ms: u64) -> bool {
    let last = LAST_USED_MS.load(Ordering::SeqCst);
    if last == 0 {
        return false;
    }
    if now_ms().saturating_sub(last) < idle_ms {
        return true;
    }
    match ENGINE.try_lock() {
        Ok(mut guard) => {
            // 等锁期间可能刚用过
            if now_ms().saturating_sub(LAST_USED_MS.load(Ordering::SeqCst)) >= idle_ms {
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

fn load(backend: &LlamaBackend, path: &Path, gpu: bool) -> Result<LlamaModel, String> {
    let params = LlamaModelParams::default().with_n_gpu_layers(if gpu { 999 } else { 0 });
    LlamaModel::load_from_file(backend, path, &params).map_err(|e| format!("模型加载失败: {e}"))
}

/// 已完整的 UTF-8 前缀交给 `emit`, 半个字符留到下一段
fn flush_utf8(pending: &mut Vec<u8>, emit: &mut dyn FnMut(&str)) {
    let valid = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        Err(e) => e.valid_up_to(),
    };
    if valid > 0 {
        // valid 之前的字节已验证过
        emit(unsafe { std::str::from_utf8_unchecked(&pending[..valid]) });
        pending.drain(..valid);
    } else if pending.len() > 8 {
        // 不可能是半个字符了: 模型吐了非法字节, 丢掉免得一直卡住
        pending.clear();
    }
}

/// 生成一段回复, 文本逐段交给 `on_piece`。闪退标记要在加载之前就立好, 由调用方负责。
pub(crate) fn generate(req: &GenRequest, on_piece: &mut dyn FnMut(&str)) -> Result<GenStats, String> {
    let backend = backend()?;
    let mut guard = ENGINE.lock().map_err(|_| "本机模型引擎锁已损坏".to_string())?;
    let mut stats = GenStats { prompt_tokens: 0, tokens: 0, load_ms: 0, prompt_ms: 0, gen_ms: 0, gpu: false, cancelled: false };
    if cancelled(req.request_id) {
        stats.cancelled = true;
        return Ok(stats);
    }

    let want_gpu = req.use_gpu && backend.supports_gpu_offload();
    if guard.as_ref().is_none_or(|l| l.id != req.model_id || (l.gpu && !want_gpu)) {
        // 先释放旧模型再加载, 免得两份同时占内存
        *guard = None;
        let started = Instant::now();
        let (model, gpu) = match load(backend, &req.model_path, want_gpu) {
            Ok(m) => (m, want_gpu),
            // 显存不够等: 退回处理器
            Err(_) if want_gpu => (load(backend, &req.model_path, false)?, false),
            Err(e) => return Err(e),
        };
        stats.load_ms = started.elapsed().as_millis() as u64;
        *guard = Some(Loaded { id: req.model_id.clone(), model, gpu });
    }
    let loaded = guard.as_ref().expect("model loaded above");
    stats.gpu = loaded.gpu;
    let model = &loaded.model;
    let vocab = model.vocab();

    let template = model.chat_template(None).map_err(|e| format!("模型缺少对话模板: {e}"))?;
    let message = LlamaChatMessage::new("user".into(), req.prompt.clone()).map_err(|e| format!("文本无效: {e}"))?;
    let text = model.apply_chat_template(&template, &[message], true).map_err(|e| format!("套用对话模板失败: {e}"))?;
    let mut tokens = vocab.tokenize(text.as_bytes(), true, true);
    // 模板自己带了起始符时, 分词器再加一个会重复
    if tokens.len() >= 2 && tokens[0] == vocab.bos() && tokens[1] == vocab.bos() {
        tokens.remove(0);
    }
    let n_ctx = req.n_ctx.min(model.n_ctx_train()).max(256);
    let n_prompt = tokens.len() as u32;
    stats.prompt_tokens = n_prompt;
    if n_prompt + 16 > n_ctx {
        return Err(TOO_LONG_ERROR.into());
    }
    let max_new = req.max_tokens.min(n_ctx - n_prompt);

    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(n_ctx))
        .with_n_batch(N_BATCH as u32)
        .with_n_threads(req.threads)
        .with_n_threads_batch(req.threads);
    let mut ctx = model.new_context(backend, ctx_params).map_err(|e| format!("创建上下文失败（内存不足？）: {e}"))?;

    let started = Instant::now();
    let mut batch = LlamaBatch::new(N_BATCH, 1);
    let mut pos: i32 = 0;
    for chunk in tokens.chunks(N_BATCH) {
        if cancelled(req.request_id) {
            stats.cancelled = true;
            LAST_USED_MS.store(now_ms(), Ordering::SeqCst);
            return Ok(stats);
        }
        batch.clear();
        for (i, token) in chunk.iter().enumerate() {
            let last = pos as usize + 1 == tokens.len() && i + 1 == chunk.len();
            batch.add(*token, pos, &[0], last).map_err(|e| format!("送入文本失败: {e}"))?;
            pos += 1;
        }
        ctx.decode(&mut batch).map_err(|e| format!("推理失败: {e}"))?;
    }
    stats.prompt_ms = started.elapsed().as_millis() as u64;

    let s = req.sampling;
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::penalties(model.n_vocab(), 64, s.repeat_penalty, 0.0, 0.0),
        LlamaSampler::top_k(s.top_k),
        LlamaSampler::top_p(s.top_p, 1),
        LlamaSampler::temp(s.temperature),
        LlamaSampler::dist(req.request_id as u32),
    ]);
    let started = Instant::now();
    let mut pending: Vec<u8> = Vec::new();
    while stats.tokens < max_new {
        if cancelled(req.request_id) {
            stats.cancelled = true;
            break;
        }
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        if vocab.is_eog(token) {
            break;
        }
        stats.tokens += 1;
        pending.extend_from_slice(&vocab.token_to_piece(token, false, None));
        flush_utf8(&mut pending, on_piece);
        batch.clear();
        batch.add(token, pos, &[0], true).map_err(|e| format!("推理失败: {e}"))?;
        pos += 1;
        ctx.decode(&mut batch).map_err(|e| format!("推理失败: {e}"))?;
    }
    stats.gen_ms = started.elapsed().as_millis() as u64;
    LAST_USED_MS.store(now_ms(), Ordering::SeqCst);
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_pieces_are_only_emitted_whole() {
        let mut out = String::new();
        let mut pending = Vec::new();
        let bytes = "译文 ok".as_bytes();
        for b in bytes {
            pending.push(*b);
            flush_utf8(&mut pending, &mut |s| out.push_str(s));
        }
        assert_eq!(out, "译文 ok");
        assert!(pending.is_empty());
        // 非法字节不会一直占着缓冲
        let mut pending = vec![0xff; 9];
        flush_utf8(&mut pending, &mut |_| panic!("nothing valid to emit"));
        assert!(pending.is_empty());
    }

    #[test]
    fn cancelling_covers_earlier_requests_only() {
        cancel(41);
        assert!(cancelled(40) && cancelled(41) && !cancelled(42));
    }

    /// 真实模型: LOCAL_LLM_TEST_MODEL=<gguf 路径> cargo test local_llm::engine::tests::translates -- --ignored --nocapture
    #[test]
    #[ignore]
    fn translates_with_a_real_model() {
        let path = PathBuf::from(std::env::var("LOCAL_LLM_TEST_MODEL").expect("LOCAL_LLM_TEST_MODEL"));
        let threads = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 8) as i32;
        let run = |prompt: &str, use_gpu: bool, id: u64| {
            let mut out = String::new();
            let stats = generate(
                &GenRequest {
                    model_id: "test".into(),
                    model_path: path.clone(),
                    prompt: prompt.into(),
                    max_tokens: 400,
                    n_ctx: 4096,
                    threads,
                    use_gpu,
                    request_id: id,
                    sampling: Sampling { temperature: 0.2, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 },
                },
                &mut |s| out.push_str(s),
            )
            .expect("generate");
            println!("{stats:?}\n{out}\n");
            (out, stats)
        };
        let gpu = gpu_supported();
        let (zh, first) = run("Translate the following segment into Chinese, without additional explanation.\n\nI went down yesterday to the Piraeus with Glaucon the son of Ariston, that I might offer up my prayers to the goddess.", gpu, 100);
        assert!(zh.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)), "expected Chinese: {zh}");
        assert!(first.load_ms > 0 && first.tokens > 5);
        let (en, second) = run("把下面的文本翻译成英文，不要额外解释。\n\n满纸荒唐言，一把辛酸泪。都云作者痴，谁解其中味？", gpu, 101);
        assert!(en.is_ascii() || en.chars().filter(|c| c.is_ascii_alphabetic()).count() > 20, "expected English: {en}");
        assert_eq!(second.load_ms, 0, "model stays loaded between requests");
        // 上下文装不下时报明确的错
        let long = "word ".repeat(6000);
        let err = generate(
            &GenRequest {
                model_id: "test".into(),
                model_path: path.clone(),
                prompt: long,
                max_tokens: 100,
                n_ctx: 4096,
                threads,
                use_gpu: gpu,
                request_id: 102,
                sampling: Sampling { temperature: 0.2, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 },
            },
            &mut |_| {},
        )
        .unwrap_err();
        assert_eq!(err, TOO_LONG_ERROR);
        unload(None);
    }
}
