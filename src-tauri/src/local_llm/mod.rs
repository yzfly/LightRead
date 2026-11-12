//! 本机模型 (llama.cpp): 离线翻译, 之后的本机语音也走这里。
//!
//! - 模型不随安装包分发, 由用户在应用内下载到数据目录 `llm-models/<id>/`, 固定版本并校验 SHA-256;
//! - 下载前先评估设备 (device.rs), 明显带不动的不提供;
//! - llama.cpp 内存不足等错误会直接结束进程, Rust 捕获不了: 加载 / 推理期间留闪退标记。
//!   显卡上闪退过一次, 下次自动改用处理器; 处理器上也闪退, 就停用到用户确认再试;
//! - 模型空闲几分钟后自动释放内存。
//!
//! 引擎只进 macOS / Windows / Android 的包 (build.rs 的 `llm_engine`):
//! - Linux 桌面不带: 预编译的 sherpa-onnx 静态库与 llama.cpp 各带一份 `std::regex` 的模板实例, 由不同版本的
//!   GCC 编出、内存布局不同, 静态链接时被合并成一份, 加载模型时就 `free(): invalid pointer` (2026-11-12 t9 实测)。
//!   要在 Linux 上用, 得先把其中一方隔离成独立的动态库或进程;
//! - iOS 还没有验证过构建;
//! - 关掉 `local-llm` 特性的构建同样没有引擎。这些情况下命令返回「不支持」, 界面不出现入口。

#![cfg_attr(not(llm_engine), allow(dead_code, unused_imports))]

pub(crate) mod device;
#[cfg(llm_engine)]
mod engine;

use crate::model_download::{download_file, download_routes, normalize_proxy, Route};
use device::Device;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// `llm_engine` 由 build.rs 按平台与特性给出
const ENGINE_BUILT: bool = cfg!(llm_engine);
const MOBILE: bool = cfg!(any(target_os = "android", target_os = "ios"));
const MODELS_DIR: &str = "llm-models";
pub(crate) const CRASHED_ERROR: &str = "LOCAL_LLM_CRASHED";
/// 桌面空闲 5 分钟、手机空闲 2 分钟后释放模型
const IDLE_UNLOAD_MS: u64 = if MOBILE { 120_000 } else { 300_000 };
/// 生成不少于这么多 token 才记录速度 (太短的不准)
const MIN_TOKENS_FOR_SPEED: u32 = 12;

pub(crate) struct ModelFile {
    pub name: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// 国内来源在前; 各来源内容相同, 都按 SHA-256 校验
    pub urls_cn: &'static [&'static str],
    pub urls_global: &'static [&'static str],
}

pub(crate) struct ModelSpec {
    pub id: &'static str,
    pub kind: &'static str,
    pub n_ctx: u32,
    pub files: &'static [ModelFile],
}

/// 腾讯混元翻译 Hy-MT2 1.8B (Apache-2.0), Q4_K_M 量化。
/// 2026-11-11 在 M5 MacBook Air 实测: 显卡约 95 token/s、内存 1.5GB; 仅处理器约 61 token/s、2.4GB。
/// 大小与摘要取自 Hugging Face tencent/Hy-MT2-1.8B-GGUF 的 a0c709d 版本 (ModelScope 同一文件)。
const HY_MT2: ModelSpec = ModelSpec {
    id: "hy-mt2-1.8b-q4",
    kind: "translate",
    n_ctx: 4096,
    files: &[ModelFile {
        name: "Hy-MT2-1.8B-Q4_K_M.gguf",
        size: 1_133_080_448,
        sha256: "dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699",
        urls_cn: &[
            "https://modelscope.cn/models/Tencent-Hunyuan/Hy-MT2-1.8B-GGUF/resolve/master/Hy-MT2-1.8B-Q4_K_M.gguf",
            "https://hf-mirror.com/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q4_K_M.gguf",
        ],
        urls_global: &[
            "https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q4_K_M.gguf",
        ],
    }],
};

pub(crate) const MODELS: &[&ModelSpec] = &[&HY_MT2];

fn spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS.iter().copied().find(|m| m.id == id).ok_or_else(|| format!("未知的模型: {id}"))
}

impl ModelSpec {
    fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

/// 下载来源顺序: 中文界面先国内来源, 其他语言先 Hugging Face; 另一组作后备
pub(crate) fn source_urls(file: &ModelFile, prefer_cn: bool) -> Vec<&'static str> {
    let (first, second) = if prefer_cn { (file.urls_cn, file.urls_global) } else { (file.urls_global, file.urls_cn) };
    first.iter().chain(second).copied().collect()
}

// ---- 文件布局 ----

fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(dir.join(MODELS_DIR))
}

fn model_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

fn part_path(dir: &Path, file: &ModelFile) -> PathBuf {
    dir.join(format!("{}.part", file.name))
}

/// 文件存在且大小对得上才算装好 (截断的模型文件会让原生库直接结束进程)
pub(crate) fn installed(root: &Path, spec: &ModelSpec) -> bool {
    let dir = model_dir(root, spec.id);
    spec.files.iter().all(|f| std::fs::metadata(dir.join(f.name)).is_ok_and(|m| m.len() == f.size))
}

fn downloaded_bytes(root: &Path, spec: &ModelSpec) -> u64 {
    let dir = model_dir(root, spec.id);
    spec
        .files
        .iter()
        .map(|f| {
            let done = std::fs::metadata(dir.join(f.name)).map(|m| m.len()).unwrap_or(0);
            if done == f.size { done } else { std::fs::metadata(part_path(&dir, f)).map(|m| m.len()).unwrap_or(0).min(f.size) }
        })
        .sum()
}

// ---- 闪退标记与速度记录 ----

static ENGINE_BUSY: AtomicBool = AtomicBool::new(false);

fn marker_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.running"))
}

fn cpu_only_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.cpu-only"))
}

fn speed_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.speed"))
}

#[derive(Debug, PartialEq)]
pub(crate) enum CrashState {
    Clean,
    /// 上次在显卡上闪退: 已改用处理器, 可以继续用
    SteppedDown,
    /// 处理器上也闪退了: 停用到用户确认
    Crashed,
}

/// 检查上次留下的闪退标记 (本进程正在用引擎时不算)。显卡上的闪退自动降到处理器并清掉标记。
pub(crate) fn settle_crash(root: &Path, id: &str) -> CrashState {
    if ENGINE_BUSY.load(Ordering::SeqCst) {
        return CrashState::Clean;
    }
    let marker = marker_path(root, id);
    let Ok(content) = std::fs::read_to_string(&marker) else { return CrashState::Clean };
    if content.trim() == "gpu" && !cpu_only_path(root, id).exists() {
        let _ = std::fs::write(cpu_only_path(root, id), b"1");
        let _ = std::fs::remove_file(&marker);
        // 显卡上的速度不再适用
        let _ = std::fs::remove_file(speed_path(root, id));
        return CrashState::SteppedDown;
    }
    CrashState::Crashed
}

struct CrashGuard(PathBuf);

impl CrashGuard {
    fn arm(root: &Path, id: &str, gpu: bool) -> Self {
        let path = marker_path(root, id);
        ENGINE_BUSY.store(true, Ordering::SeqCst);
        // 写失败 (只读目录等) 不影响使用, 只是少了这层保护
        let _ = std::fs::write(&path, if gpu { "gpu" } else { "cpu" });
        Self(path)
    }
}

impl Drop for CrashGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        ENGINE_BUSY.store(false, Ordering::SeqCst);
    }
}

/// 应用正常退出时调用: 退出时恰好在推理的标记不算闪退
pub fn clear_crash_marker_on_exit(app: &AppHandle) {
    if ENGINE_BUSY.load(Ordering::SeqCst) {
        if let Ok(root) = models_root(app) {
            for m in MODELS {
                let _ = std::fs::remove_file(marker_path(&root, m.id));
            }
        }
    }
}

/// 记录的速度: `<token/秒> <gpu|cpu>`
fn read_speed(root: &Path, id: &str) -> Option<(f32, bool)> {
    let text = std::fs::read_to_string(speed_path(root, id)).ok()?;
    let mut parts = text.split_whitespace();
    let tps: f32 = parts.next()?.parse().ok()?;
    (tps.is_finite() && tps > 0.0).then_some((tps, parts.next() == Some("gpu")))
}

/// 新测得的速度与旧值各占一半 (单次测量会受其他程序影响)
pub(crate) fn blend_speed(old: Option<f32>, new: f32) -> f32 {
    old.map_or(new, |o| (o + new) / 2.0)
}

// ---- 设备 ----

#[cfg(target_os = "android")]
fn perf_cores() -> usize {
    let freqs: Vec<u64> = (0..64)
        .map_while(|i| std::fs::read_to_string(format!("/sys/devices/system/cpu/cpu{i}/cpufreq/cpuinfo_max_freq")).ok())
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    device::perf_cores_from_freqs(&freqs)
}

#[cfg(target_os = "macos")]
fn perf_cores() -> usize {
    // Apple 芯片的性能核数; Intel Mac 没有这一项
    let mut n: i32 = 0;
    let mut len = std::mem::size_of::<i32>();
    let name = b"hw.perflevel0.physicalcpu\0";
    let rc = unsafe { libc::sysctlbyname(name.as_ptr() as *const _, &mut n as *mut i32 as *mut _, &mut len, std::ptr::null_mut(), 0) };
    if rc == 0 && n > 0 { n as usize } else { 0 }
}

#[cfg(not(any(target_os = "android", target_os = "macos")))]
fn perf_cores() -> usize {
    0
}

fn this_device(root: &Path) -> Device {
    #[cfg(target_arch = "x86_64")]
    let avx2 = Some(std::arch::is_x86_feature_detected!("avx2"));
    #[cfg(not(target_arch = "x86_64"))]
    let avx2: Option<bool> = None;
    Device {
        ram: crate::tts_device::total_memory(),
        logical_cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        perf_cores: perf_cores(),
        avx2,
        mobile: MOBILE,
        free_disk: crate::tts_device::free_disk(root),
    }
}

// ---- 状态 ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: &'static str,
    kind: &'static str,
    size: u64,
    installed: bool,
    /// 已下载的字节 (含未完成的半截文件, 可续传)
    downloaded: u64,
    /// 后台正在下载
    running: bool,
    /// 这台设备能否使用; 不能时 reasons 给出原因
    supported: bool,
    reasons: Vec<String>,
    /// 上次使用时应用意外退出, 已停用, 需用户确认再试
    crashed: bool,
    /// 实测生成速度 (token/秒); 还没用过为空
    tokens_per_second: Option<f32>,
    /// 实测时是否用了显卡
    gpu: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLlmStatus {
    /// 这个构建带不带引擎 (iOS 不带)
    available: bool,
    models: Vec<ModelStatus>,
}

#[tauri::command]
pub fn local_llm_status(app: AppHandle, lang: Option<String>) -> Result<LocalLlmStatus, String> {
    if !ENGINE_BUILT {
        return Ok(LocalLlmStatus { available: false, models: Vec::new() });
    }
    let en = lang.as_deref() == Some("en");
    let root = models_root(&app)?;
    let dev = this_device(&root);
    let running = running_download();
    let models = MODELS
        .iter()
        .map(|m| {
            let is_installed = installed(&root, m);
            let concerns = device::assess(&dev, m.total_size(), m.n_ctx, is_installed);
            let speed = read_speed(&root, m.id);
            ModelStatus {
                id: m.id,
                kind: m.kind,
                size: m.total_size(),
                installed: is_installed,
                downloaded: downloaded_bytes(&root, m),
                running: running.as_deref() == Some(m.id),
                supported: concerns.is_empty(),
                reasons: concerns.iter().map(|c| c.describe(en)).collect(),
                crashed: is_installed && settle_crash(&root, m.id) == CrashState::Crashed,
                tokens_per_second: speed.map(|s| s.0),
                gpu: speed.map(|s| s.1),
            }
        })
        .collect();
    Ok(LocalLlmStatus { available: true, models })
}

/// 用户确认再试一次: 清除闪退标记 (保留「只用处理器」的降级)
#[tauri::command]
pub fn local_llm_clear_crash(app: AppHandle, model: String) -> Result<(), String> {
    let root = models_root(&app)?;
    let path = marker_path(&root, spec(&model)?.id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("清除失败: {e}"))?;
    }
    Ok(())
}

// ---- 下载 ----

#[derive(Serialize, Clone)]
struct Progress {
    model: String,
    downloaded: u64,
    total: u64,
    phase: String,
}

type JobResult = Option<Result<(), String>>;
/// 同一时间只有一个下载任务 (模型都是 GB 级, 并行只会互相拖慢); 重复点击接到正在进行的任务上
static DOWNLOAD_JOB: OnceLock<Mutex<Option<(String, tokio::sync::watch::Receiver<JobResult>)>>> = OnceLock::new();

fn running_download() -> Option<String> {
    let job = DOWNLOAD_JOB.get_or_init(|| Mutex::new(None)).lock().ok()?;
    job.as_ref().filter(|(_, rx)| rx.borrow().is_none()).map(|(id, _)| id.clone())
}

/// 下载模型; 进度经 `local-llm-progress` 事件推送。后台独立运行, 离开页面不中断。
#[tauri::command]
pub async fn local_llm_download(app: AppHandle, model: String, proxy: Option<String>, prefer_cn: Option<bool>) -> Result<(), String> {
    if !ENGINE_BUILT {
        return Err("此版本不支持本机模型".into());
    }
    let spec = spec(&model)?;
    let root = models_root(&app)?;
    if installed(&root, spec) {
        return Ok(());
    }
    let mut rx = {
        let mut job = DOWNLOAD_JOB.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "下载状态锁已损坏")?;
        match job.as_ref() {
            Some((id, rx)) if rx.borrow().is_none() => {
                if id != spec.id {
                    return Err("另一个模型正在下载，请等它完成".into());
                }
                rx.clone()
            }
            _ => {
                let (tx, rx) = tokio::sync::watch::channel(None);
                *job = Some((spec.id.to_string(), rx.clone()));
                tauri::async_runtime::spawn(async move {
                    let result = run_download(app, spec, root, proxy, prefer_cn.unwrap_or(true)).await;
                    let _ = tx.send(Some(result));
                });
                rx
            }
        }
    };
    let waited = rx.wait_for(|r| r.is_some()).await.ok().map(|r| r.clone());
    let result = waited.unwrap_or_else(|| rx.borrow().clone());
    result.unwrap_or_else(|| Err("下载任务意外结束".into()))
}

async fn run_download(app: AppHandle, spec: &'static ModelSpec, root: PathBuf, proxy: Option<String>, prefer_cn: bool) -> Result<(), String> {
    let dir = model_dir(&root, spec.id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let total = spec.total_size();
    let proxy = proxy.as_deref().and_then(normalize_proxy);
    let emit_progress = |downloaded: u64, phase: &str| {
        let _ = app.emit("local-llm-progress", Progress { model: spec.id.into(), downloaded, total, phase: phase.into() });
    };
    emit_progress(downloaded_bytes(&root, spec), "connecting");

    let mut done_before: u64 = 0;
    for file in spec.files {
        let target = dir.join(file.name);
        if std::fs::metadata(&target).is_ok_and(|m| m.len() == file.size) {
            done_before += file.size;
            continue;
        }
        let part = part_path(&dir, file);
        let base = done_before;
        let emit = {
            let app = app.clone();
            move |downloaded: u64, _file_total: u64, phase: &str| {
                let _ = app.emit("local-llm-progress", Progress { model: spec.id.into(), downloaded: base + downloaded, total, phase: phase.into() });
            }
        };
        // 每个来源都按「代理 → 直连」各试一次; 每次尝试都从已下载的位置接着下
        let mut errors: Vec<String> = Vec::new();
        let mut ok = false;
        'sources: for url in source_urls(file, prefer_cn) {
            let host = url.split('/').nth(2).unwrap_or(url);
            for route in download_routes(proxy.clone()) {
                match download_file(&part, url, file.size, file.sha256, &route, &emit).await {
                    Ok(()) => {
                        ok = true;
                        break 'sources;
                    }
                    Err(e) => errors.push(match &route {
                        Route::Proxy(_) => format!("{host} 经代理: {e}"),
                        Route::System => format!("{host} 经系统代理: {e}"),
                        Route::Direct => format!("{host} 直连: {e}"),
                    }),
                }
            }
        }
        if !ok {
            log::warn!("[local_llm] download failed: {}", errors.join("; "));
            let kept = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
            let resume = if kept > 0 { format!("，已下的 {} MB 会保留，重试接着下", kept >> 20) } else { String::new() };
            let hint = if proxy.is_some() { "请检查「设置 › 网络」里的代理地址，或清空后重试" } else { "请检查网络后重试；也可在「设置 › 网络」填写代理" };
            return Err(format!("下载没完成{resume}。{hint}"));
        }
        // 已校验的文件改成正式名字; 新下载的模型重新测速、重新允许用显卡
        std::fs::rename(&part, &target).map_err(|e| format!("安装失败: {e}"))?;
        done_before += file.size;
    }
    let _ = std::fs::remove_file(cpu_only_path(&root, spec.id));
    let _ = std::fs::remove_file(speed_path(&root, spec.id));
    let _ = std::fs::remove_file(marker_path(&root, spec.id));
    emit_progress(total, "done");
    Ok(())
}

#[tauri::command]
pub async fn local_llm_remove(app: AppHandle, model: String) -> Result<(), String> {
    let spec = spec(&model)?;
    if running_download().as_deref() == Some(spec.id) {
        return Err("正在下载，完成后才能删除".into());
    }
    let root = models_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(llm_engine)]
        engine::unload(Some(spec.id));
        for path in [marker_path(&root, spec.id), cpu_only_path(&root, spec.id), speed_path(&root, spec.id)] {
            let _ = std::fs::remove_file(path);
        }
        let dir = model_dir(&root, spec.id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("删除失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))?
}

// ---- 生成 ----

/// 经通道送回前端的事件: 若干段文本, 最后一条是统计。
/// 统计也走通道 (而不是命令的返回值): 通道消息与命令返回之间没有先后保证, 这样前端不会漏掉末尾的文本。
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum GenEvent {
    Piece { text: String },
    Done { tokens: u32, prompt_tokens: u32, load_ms: u64, prompt_ms: u64, gen_ms: u64, gpu: bool, cancelled: bool },
}

/// 取消编号不大于 request_id 的生成 (前端编号单调递增)
#[tauri::command]
pub fn local_llm_cancel(request_id: u64) {
    #[cfg(llm_engine)]
    engine::cancel(request_id);
    #[cfg(not(llm_engine))]
    let _ = request_id;
}

/// 立刻释放内存里的模型 (应用退到后台等)
#[tauri::command]
pub async fn local_llm_unload() -> Result<(), String> {
    #[cfg(llm_engine)]
    tauri::async_runtime::spawn_blocking(|| engine::unload(None)).await.map_err(|e| format!("任务失败: {e}"))?;
    Ok(())
}

/// 用本机模型生成一段回复, 文本经 `on_event` 逐段送回。`prompt` 是完整的用户消息 (提示词由前端拼)。
#[cfg(llm_engine)]
#[tauri::command]
pub async fn local_llm_generate(
    app: AppHandle,
    model: String,
    prompt: String,
    max_tokens: u32,
    request_id: u64,
    on_event: tauri::ipc::Channel<GenEvent>,
) -> Result<(), String> {
    let spec = spec(&model)?;
    let root = models_root(&app)?;
    if !installed(&root, spec) {
        return Err("模型还没有下载".into());
    }
    if settle_crash(&root, spec.id) == CrashState::Crashed {
        return Err(CRASHED_ERROR.into());
    }
    let dev = this_device(&root);
    let request = engine::GenRequest {
        model_id: spec.id.into(),
        model_path: model_dir(&root, spec.id).join(spec.files[0].name),
        prompt,
        max_tokens: max_tokens.clamp(16, spec.n_ctx),
        n_ctx: spec.n_ctx,
        threads: device::inference_threads(&dev),
        use_gpu: !cpu_only_path(&root, spec.id).exists(),
        request_id,
        // 混元翻译模型卡片推荐的采样参数
        sampling: engine::Sampling { temperature: 0.2, top_p: 0.6, top_k: 20, repeat_penalty: 1.05 },
    };
    let pieces = on_event.clone();
    let stats = run_engine_task(move || {
        let _guard = CrashGuard::arm(&root, spec.id, request.use_gpu && engine::gpu_supported());
        let stats = engine::generate(&request, &mut |piece| {
            let _ = pieces.send(GenEvent::Piece { text: piece.to_string() });
        })?;
        if !stats.cancelled && stats.tokens >= MIN_TOKENS_FOR_SPEED && stats.gen_ms > 0 {
            let tps = stats.tokens as f32 * 1000.0 / stats.gen_ms as f32;
            let old = read_speed(&root, spec.id).filter(|(_, gpu)| *gpu == stats.gpu).map(|s| s.0);
            let _ = std::fs::write(speed_path(&root, spec.id), format!("{:.1} {}", blend_speed(old, tps), if stats.gpu { "gpu" } else { "cpu" }));
        }
        Ok(stats)
    })
    .await?;
    schedule_idle_unload();
    let _ = on_event.send(GenEvent::Done {
        tokens: stats.tokens,
        prompt_tokens: stats.prompt_tokens,
        load_ms: stats.load_ms,
        prompt_ms: stats.prompt_ms,
        gen_ms: stats.gen_ms,
        gpu: stats.gpu,
        cancelled: stats.cancelled,
    });
    Ok(())
}

#[cfg(not(llm_engine))]
#[tauri::command]
pub async fn local_llm_generate(
    _app: AppHandle,
    _model: String,
    _prompt: String,
    _max_tokens: u32,
    _request_id: u64,
    _on_event: tauri::ipc::Channel<GenEvent>,
) -> Result<(), String> {
    Err("此版本不支持本机模型".into())
}

/// 模型加载与推理放独立线程 (不占异步运行时), 原生库里的 panic 转成错误
#[cfg(llm_engine)]
async fn run_engine_task<T: Send + 'static>(task: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("lightread-llm".into())
        .stack_size(8 << 20)
        .spawn(move || {
            let _ = tx.send(std::panic::catch_unwind(std::panic::AssertUnwindSafe(task)));
        })
        .map_err(|e| format!("本机模型任务失败: {e}"))?;
    match rx.await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("本机模型任务失败: 引擎内部错误".into()),
        Err(e) => Err(format!("本机模型任务失败: {e}")),
    }
}

/// 起一个看门线程 (全程最多一个): 模型空闲够久就释放内存, 释放后线程结束
#[cfg(llm_engine)]
fn schedule_idle_unload() {
    static WATCHING: AtomicBool = AtomicBool::new(false);
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new().name("lightread-llm-idle".into()).spawn(|| {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            if !engine::unload_if_idle(IDLE_UNLOAD_MS) {
                break;
            }
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
    if spawned.is_err() {
        WATCHING.store(false, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 闪退标记的测试共用进程级的「引擎正在用」标志, 不能并行
    static BUSY_TESTS: Mutex<()> = Mutex::new(());

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lightread-llm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn registry_is_well_formed() {
        for m in MODELS {
            assert!(!m.files.is_empty() && m.n_ctx >= 1024, "{}", m.id);
            assert!(m.id.is_ascii(), "id 用作文件名");
            for f in m.files {
                assert_eq!(f.sha256.len(), 64);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
                assert!(f.size > 1 << 20);
                let urls = source_urls(f, true);
                assert!(urls.len() >= 2, "至少两个来源");
                assert!(urls.iter().all(|u| u.starts_with("https://") && u.ends_with(f.name)));
                // Hugging Face 与其镜像固定到提交, 不跟着 main 变
                assert!(urls.iter().filter(|u| u.contains("hf-mirror.com") || u.contains("huggingface.co")).all(|u| !u.contains("/resolve/main/")));
            }
        }
        assert!(spec("hy-mt2-1.8b-q4").is_ok());
        assert!(spec("nope").is_err());
    }

    #[test]
    fn source_order_follows_the_interface_language() {
        let f = &HY_MT2.files[0];
        assert!(source_urls(f, true)[0].contains("modelscope.cn"));
        assert!(source_urls(f, false)[0].contains("huggingface.co"));
        assert_eq!(source_urls(f, true).len(), source_urls(f, false).len());
    }

    #[test]
    fn installed_needs_the_exact_size() {
        const TINY: ModelSpec = ModelSpec {
            id: "tiny",
            kind: "translate",
            n_ctx: 1024,
            files: &[ModelFile { name: "a.gguf", size: 4, sha256: "", urls_cn: &[], urls_global: &[] }],
        };
        let root = temp_root();
        assert!(!installed(&root, &TINY));
        std::fs::create_dir_all(root.join("tiny")).unwrap();
        std::fs::write(root.join("tiny/a.gguf.part"), b"ab").unwrap();
        assert!(!installed(&root, &TINY));
        assert_eq!(downloaded_bytes(&root, &TINY), 2);
        std::fs::write(root.join("tiny/a.gguf"), b"abc").unwrap();
        assert!(!installed(&root, &TINY), "截断的文件不算装好");
        std::fs::write(root.join("tiny/a.gguf"), b"abcd").unwrap();
        assert!(installed(&root, &TINY));
        assert_eq!(downloaded_bytes(&root, &TINY), 4);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gpu_crash_steps_down_to_cpu_then_cpu_crash_disables() {
        let _serial = BUSY_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_root();
        assert_eq!(settle_crash(&root, "m"), CrashState::Clean);
        // 显卡上闪退: 留下标记
        std::fs::write(marker_path(&root, "m"), "gpu").unwrap();
        std::fs::write(speed_path(&root, "m"), "90.0 gpu").unwrap();
        assert_eq!(settle_crash(&root, "m"), CrashState::SteppedDown);
        assert!(cpu_only_path(&root, "m").exists());
        assert!(!marker_path(&root, "m").exists());
        assert!(read_speed(&root, "m").is_none(), "显卡的速度不再适用");
        assert_eq!(settle_crash(&root, "m"), CrashState::Clean);
        // 处理器上又闪退: 停用
        std::fs::write(marker_path(&root, "m"), "cpu").unwrap();
        assert_eq!(settle_crash(&root, "m"), CrashState::Crashed);
        assert_eq!(settle_crash(&root, "m"), CrashState::Crashed, "重复检查不会自己解除");
        // 已经降级过, 显卡标记也算闪退 (不会无限降级)
        std::fs::write(marker_path(&root, "m"), "gpu").unwrap();
        assert_eq!(settle_crash(&root, "m"), CrashState::Crashed);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn guard_marks_and_clears() {
        let _serial = BUSY_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let root = temp_root();
        {
            let _guard = CrashGuard::arm(&root, "g", true);
            assert_eq!(std::fs::read_to_string(marker_path(&root, "g")).unwrap(), "gpu");
            assert_eq!(settle_crash(&root, "g"), CrashState::Clean, "本进程正在用时不算闪退");
        }
        assert!(!marker_path(&root, "g").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn speed_is_read_back_and_blended() {
        let root = temp_root();
        assert!(read_speed(&root, "s").is_none());
        std::fs::write(speed_path(&root, "s"), "61.5 cpu").unwrap();
        assert_eq!(read_speed(&root, "s"), Some((61.5, false)));
        std::fs::write(speed_path(&root, "s"), "garbage").unwrap();
        assert!(read_speed(&root, "s").is_none());
        assert_eq!(blend_speed(None, 40.0), 40.0);
        assert_eq!(blend_speed(Some(60.0), 40.0), 50.0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
