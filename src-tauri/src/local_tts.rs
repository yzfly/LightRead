//! 本地离线神经语音: sherpa-onnx + Kokoro multi-lang v1.1 (中英, 103 音色).
//! 模型 (~310MB) 由应用内下载到数据目录, 合成完全离线.
//! 移动端暂不支持 (sherpa-onnx 交叉编译限制), 命令返回明确错误.

#[cfg(any(target_os = "android", target_os = "ios"))]
mod stub {
    use serde::Serialize;
    use tauri::AppHandle;

    #[derive(Serialize)]
    pub struct LocalTtsStatus {
        pub installed: bool,
        pub path: String,
        pub crashed: bool,
    }

    #[tauri::command]
    pub fn local_tts_status(_app: AppHandle) -> Result<LocalTtsStatus, String> {
        Ok(LocalTtsStatus { installed: false, path: String::new(), crashed: false })
    }

    #[tauri::command]
    pub fn local_tts_clear_crash(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub fn clear_crash_marker_on_exit(_app: &AppHandle) {}

    #[tauri::command]
    pub async fn local_tts_download(_app: AppHandle, _proxy: Option<String>) -> Result<(), String> {
        Err("移动端暂不支持离线语音包".into())
    }

    #[derive(Serialize)]
    pub struct LocalTtsDownloadState {
        pub running: bool,
        pub downloaded: u64,
        pub total: u64,
        pub phase: String,
    }

    #[tauri::command]
    pub fn local_tts_download_state(_app: AppHandle) -> Result<LocalTtsDownloadState, String> {
        Ok(LocalTtsDownloadState { running: false, downloaded: 0, total: 0, phase: "idle".into() })
    }

    #[tauri::command]
    pub fn local_tts_remove(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn local_tts_warmup(_app: AppHandle, _sid: Option<i32>) -> Result<(), String> {
        Err("移动端暂不支持离线语音".into())
    }

    #[tauri::command]
    pub fn local_tts_synthesize(
        _app: AppHandle,
        _text: String,
        _sid: i32,
        _speed: f32,
    ) -> Result<tauri::ipc::Response, String> {
        Err("移动端暂不支持离线语音".into())
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub use stub::*;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
use serde::Serialize;
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig,
};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const MODEL_DIR: &str = "tts-models/kokoro-multi-lang-v1_1";
const MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2";
/// 国内镜像 (GitCode 上 yzfly/LightRead 的 tts-models release, 由发版工作流从 GitHub 原样复制);
/// 内容与 GitHub 完全一致, 同样按 SHA256 校验, 被替换的文件装不上
const MODEL_MIRROR_URLS: &[&str] = &[
    "https://gitcode.com/langgpt/LightRead/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2",
];

/// GitHub release 资产公布的摘要与大小 (2026-10-05 经 GitHub API 核对)
const MODEL_SHA256: &str = "a3f4c73d043860e3fd2e5b06f36795eb81de0fc8e8de6df703245edddd87dbad";
const MODEL_SIZE: u64 = 364_816_464;

pub(crate) use crate::model_download::{download_routes, Route};
use crate::model_download::{download_file, normalize_proxy};

#[cfg(test)]
pub(crate) async fn synthesize_for_test(root: PathBuf, text: String) -> Result<Vec<u8>, String> {
    synthesize_voice_for_test(root, text, DEFAULT_SID).await
}

#[cfg(test)]
pub(crate) async fn synthesize_voice_for_test(root: PathBuf, text: String, sid: i32) -> Result<Vec<u8>, String> {
    run_engine_task(move || synthesize_at(&root, &text, sid, 1.0)).await
}

#[cfg(test)]
pub(crate) async fn download_archive_for_test(path: &Path, route: &Route) -> Result<(), String> {
    download_archive(path, MODEL_URL, route, &std::sync::Arc::new(|_: u64, _: u64, _: &str| {})).await
}

/// 下载模型包到 path (断点续传 + SHA256 校验, 见 model_download), 通过后进入解压阶段。
async fn download_archive(
    path: &Path,
    url: &str,
    route: &Route,
    emit: &std::sync::Arc<impl Fn(u64, u64, &str) + Send + Sync + 'static>,
) -> Result<(), String> {
    download_file(path, url, MODEL_SIZE, MODEL_SHA256, route, emit.as_ref()).await?;
    emit(MODEL_SIZE, MODEL_SIZE, "extracting");
    Ok(())
}

/// 已加载的引擎及其文本规整配置; 规整配置变化 (切换中/英文音色) 时才重建。
struct LoadedEngine {
    tts: OfflineTts,
    rule_fsts: Option<String>,
}

static ENGINE: OnceLock<Mutex<Option<LoadedEngine>>> = OnceLock::new();

fn model_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(dir.join(MODEL_DIR))
}

/// 关键文件及其大小 (2026-10-05 从模型包实测)。只看「文件存在」不够: 解压被打断 (关闭应用、
/// 杀毒软件锁文件、磁盘满) 会留下截断的 model.onnx, 原生库加载它时会直接结束进程 (闪退),
/// 而且每次启动预加载都会再闪退一次。大小不对就当作没装好, 重新下载 / 解压。
const REQUIRED_FILES: &[(&str, u64)] = &[
    ("model.onnx", 325_631_784),
    ("voices.bin", 53_790_720),
    ("tokens.txt", 1_111),
    ("lexicon-zh.txt", 2_119_465),
    ("lexicon-us-en.txt", 5_956_885),
];

fn model_ready(root: &Path) -> bool {
    REQUIRED_FILES
        .iter()
        .all(|(name, size)| std::fs::metadata(root.join(name)).map(|m| m.len() == *size).unwrap_or(false))
        && root.join("espeak-ng-data").is_dir()
}

#[derive(Serialize)]
pub struct LocalTtsStatus {
    pub installed: bool,
    pub path: String,
    /// 上次加载 / 推理离线语音时应用意外退出, 已暂停使用
    pub crashed: bool,
}

#[tauri::command]
pub fn local_tts_status(app: AppHandle) -> Result<LocalTtsStatus, String> {
    let root = model_root(&app)?;
    Ok(LocalTtsStatus {
        installed: model_ready(&root),
        path: root.to_string_lossy().to_string(),
        crashed: crashed_before(&root),
    })
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    phase: String,
}

/// 下载任务在后台独立运行, 与发起它的页面无关: 离开页面不会中断;
/// 同一时间只有一个任务, 重复点击「下载」会接到正在进行的任务上, 不会开第二个去抢同一个文件。
type JobResult = Option<Result<(), String>>;
static DOWNLOAD_JOB: OnceLock<Mutex<Option<tokio::sync::watch::Receiver<JobResult>>>> = OnceLock::new();
/// 最近一次进度, 供页面重新打开时显示
static DOWNLOAD_PROGRESS: OnceLock<Mutex<Option<DownloadProgress>>> = OnceLock::new();

fn archive_path(root: &Path) -> Result<PathBuf, String> {
    Ok(root.parent().ok_or("路径异常")?.join("kokoro-download.tar.bz2"))
}

#[derive(Serialize)]
pub struct LocalTtsDownloadState {
    /// 后台是否正在下载 / 解压
    pub running: bool,
    pub downloaded: u64,
    pub total: u64,
    pub phase: String,
}

/// 当前下载状态: 正在下载时给出实时进度; 否则给出上次留下的半截文件大小 (可续传)
#[tauri::command]
pub fn local_tts_download_state(app: AppHandle) -> Result<LocalTtsDownloadState, String> {
    let running = DOWNLOAD_JOB
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "下载状态锁已损坏")?
        .as_ref()
        .is_some_and(|rx| rx.borrow().is_none());
    if running {
        let last = DOWNLOAD_PROGRESS.get_or_init(|| Mutex::new(None)).lock().ok().and_then(|p| p.clone());
        let p = last.unwrap_or(DownloadProgress { downloaded: 0, total: MODEL_SIZE, phase: "connecting".into() });
        return Ok(LocalTtsDownloadState { running, downloaded: p.downloaded, total: p.total, phase: p.phase });
    }
    let partial = std::fs::metadata(archive_path(&model_root(&app)?)?)
        .map(|m| m.len())
        .unwrap_or(0)
        .min(MODEL_SIZE);
    Ok(LocalTtsDownloadState { running, downloaded: partial, total: MODEL_SIZE, phase: "idle".into() })
}

/// 把已校验的安装包解压到 root 同级的临时目录, 关键文件大小都对再整体换到 root。
/// 失败时保留安装包 (已通过 SHA256), 重试不必重新下载。
pub(crate) fn install_archive(archive: &Path, root: &Path) -> Result<(), String> {
    let parent = root.parent().ok_or("路径异常")?;
    let staging = parent.join("kokoro-unpack.partial");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("创建目录失败: {e}"))?;
    let file = std::fs::File::open(archive).map_err(|e| format!("读取包失败: {e}"))?;
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(file));
    let unpacked = staging.join(MODEL_DIR.rsplit('/').next().unwrap_or("kokoro-multi-lang-v1_1"));
    let result = tar
        .unpack(&staging)
        .map_err(|e| format!("解压失败：{e}（磁盘空间不足或被杀毒软件拦截？）"))
        .and_then(|()| {
            if model_ready(&unpacked) {
                Ok(())
            } else {
                Err("解压后文件不完整（磁盘空间不足或被杀毒软件拦截？）".to_string())
            }
        })
        .and_then(|()| {
            if root.exists() {
                std::fs::remove_dir_all(root).map_err(|e| format!("清理旧文件失败: {e}"))?;
            }
            std::fs::rename(&unpacked, root).map_err(|e| format!("安装失败: {e}"))
        });
    let _ = std::fs::remove_dir_all(&staging);
    result?;
    let _ = std::fs::remove_file(archive);
    Ok(())
}

/// 下载并解压模型包; 进度经 `local-tts-progress` 事件推送。已有任务时等待它的结果。
#[tauri::command]
pub async fn local_tts_download(app: AppHandle, proxy: Option<String>) -> Result<(), String> {
    if model_ready(&model_root(&app)?) {
        return Ok(());
    }
    let mut rx = {
        let mut job = DOWNLOAD_JOB.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "下载状态锁已损坏")?;
        match job.as_ref() {
            Some(rx) if rx.borrow().is_none() => rx.clone(),
            _ => {
                let (tx, rx) = tokio::sync::watch::channel(None);
                *job = Some(rx.clone());
                tauri::async_runtime::spawn(async move {
                    let result = run_download(app, proxy).await;
                    if let Ok(mut p) = DOWNLOAD_PROGRESS.get_or_init(|| Mutex::new(None)).lock() {
                        *p = None;
                    }
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

async fn run_download(app: AppHandle, proxy: Option<String>) -> Result<(), String> {
    let root = model_root(&app)?;
    let parent = root
        .parent()
        .ok_or("路径异常")?
        .to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| format!("创建目录失败: {e}"))?;

    let emit = {
        let app = app.clone();
        std::sync::Arc::new(move |downloaded: u64, total: u64, phase: &str| {
            let progress = DownloadProgress { downloaded, total, phase: phase.into() };
            if let Ok(mut p) = DOWNLOAD_PROGRESS.get_or_init(|| Mutex::new(None)).lock() {
                *p = Some(progress.clone());
            }
            let _ = app.emit("local-tts-progress", progress);
        })
    };
    emit(0, MODEL_SIZE, "connecting");

    // 下载: 先走设置里的代理, 代理连不上再直连 (未设代理时 reqwest 自动用系统代理);
    // 边下边算 SHA256, 与 GitHub 公布的摘要不一致就丢弃 (被劫持的内容装不上);
    // 每次尝试都从已下载的位置接着下, 换线路、换来源、重启应用后都不必从头来
    let archive_path = archive_path(&root)?;
    let proxy = proxy.as_deref().and_then(normalize_proxy);
    let mut errors: Vec<String> = Vec::new();
    let mut ok = false;
    // 先 GitHub, 再国内镜像; 每个来源都按「代理 → 直连」各试一次
    'sources: for (si, url) in std::iter::once(MODEL_URL).chain(MODEL_MIRROR_URLS.iter().copied()).enumerate() {
        let source = if si == 0 { "GitHub" } else { "国内镜像" };
        for route in download_routes(proxy.clone()) {
            match download_archive(&archive_path, url, &route, &emit).await {
                Ok(()) => {
                    ok = true;
                    break 'sources;
                }
                Err(e) => errors.push(match &route {
                    Route::Proxy(p) => format!("{source} 经代理 {p}: {e}"),
                    Route::System => format!("{source} 经系统代理: {e}"),
                    Route::Direct => format!("{source} 直连: {e}"),
                }),
            }
        }
    }
    if !ok {
        let hint = if proxy.is_some() {
            "请检查「设置 › 网络」里的代理地址，或清空后重试"
        } else {
            "请检查网络；GitHub 不稳定时，可在「设置 › 网络」填写代理"
        };
        let kept = std::fs::metadata(&archive_path).map(|m| m.len()).unwrap_or(0);
        let resume = if kept > 0 { format!("，已下的 {} MB 会保留，重试接着下", kept >> 20) } else { String::new() };
        // 每条线路的原始报错只进日志, 界面只给结论和下一步
        eprintln!("[local_tts] 下载失败: {}", errors.join("; "));
        return Err(format!("下载没完成{resume}。{hint}"));
    }

    // 解压 (tar.bz2, 顶层目录即 kokoro-multi-lang-v1_1) 到临时目录, 校验关键文件大小后再整体换到正式位置:
    // 解压中断不会留下「看起来装好了、实际是坏的」模型。blocking IO 放独立线程。
    let archive = archive_path.clone();
    tokio::task::spawn_blocking(move || install_archive(&archive, &root))
        .await
        .map_err(|e| format!("任务失败: {e}"))??;
    emit(MODEL_SIZE, MODEL_SIZE, "done");

    if !model_ready(&model_root(&app)?) {
        return Err("解压后未找到模型文件".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn local_tts_remove(app: AppHandle) -> Result<(), String> {
    let root = model_root(&app)?;
    run_engine_task(move || {
        // 等待合成、释放模型和删除文件都不能占用 UI 线程。
        // 删除完成前持有同一把锁，避免新的合成重新打开模型。
        let lock = ENGINE.get_or_init(|| Mutex::new(None));
        let mut guard = lock.lock().map_err(|_| "语音引擎锁已损坏")?;
        *guard = None;
        let _ = std::fs::remove_file(crash_marker(&root));
        std::fs::remove_dir_all(&root).map_err(|e| format!("删除失败: {e}"))
    })
    .await
}

/// 中文文本规整规则 (电话号码 / 日期 / 数字 → 汉字读法), 按此顺序从左到右应用。
/// 与 sherpa-onnx 官方 TTS APK 给 kokoro-multi-lang-v1_1 的配置一致
/// (scripts/apk/generate-tts-apk-script.py); 模型包里自带这三个文件。
const ZH_RULE_FSTS: [&str; 3] = ["phone-zh.fst", "date-zh.fst", "number-zh.fst"];

/// sid 0–2 是英文音色 (af_maple / af_sol / bf_vale), 3–102 是中文音色
/// (见 sherpa 文档 kokoro-multi-lang-v1_1 的 sid 表, 前端目录 src/services/kokoroVoices.ts)。
const FIRST_ZH_SID: i32 = 3;

/// 前端未传 sid 时 (旧版 warmup 调用) 按默认中文音色预加载, 与 DEFAULT_KOKORO_SID 一致。
const DEFAULT_SID: i32 = 50;

/// sherpa-onnx 把规则 FST 应用到整段文本 (csrc/offline-tts-kokoro-impl.h), 英文句子里的
/// 数字也会被改写成汉字 ("Chapter 12" → "Chapter 十二"), 所以只给中文音色启用。
fn rule_fsts_for(root: &Path, sid: i32) -> Option<String> {
    if sid >= FIRST_ZH_SID {
        existing_rule_fsts(root)
    } else {
        None
    }
}

/// 只拼接模型目录里真实存在的规则 FST, 用逗号分隔 (sherpa-onnx 的 `rule_fsts` 格式)。
/// sherpa-onnx 校验配置时任何一个 FST 缺失都会让引擎初始化失败, 所以旧版/残缺的
/// 安装要跳过缺失的文件, 全部缺失时返回 None (等同于不做规整, 即之前的行为)。
/// 路径里带逗号会被 sherpa 误拆, 这种文件同样跳过。
fn existing_rule_fsts(root: &Path) -> Option<String> {
    let found: Vec<String> = ZH_RULE_FSTS
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().into_owned())
        .filter(|path| !path.contains(','))
        .collect();
    if found.is_empty() {
        None
    } else {
        Some(found.join(","))
    }
}

fn build_engine(root: &PathBuf, rule_fsts: Option<String>) -> Result<OfflineTts, String> {
    let root = &crate::tts_device::engine_path(root)?;
    // 规整规则也要按 (可能换成短路径的) 实际目录重新拼接
    let rule_fsts = rule_fsts.and_then(|_| existing_rule_fsts(root));
    let p = |name: &str| Some(root.join(name).to_string_lossy().to_string());
    let lexicon = format!(
        "{},{}",
        root.join("lexicon-us-en.txt").to_string_lossy(),
        root.join("lexicon-zh.txt").to_string_lossy()
    );
    let config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: p("model.onnx"),
                voices: p("voices.bin"),
                tokens: p("tokens.txt"),
                data_dir: p("espeak-ng-data"),
                // sherpa-onnx >= 1.12.15 已内置 jieba 词典, Kokoro 的 dict_dir 被忽略,
                // 传了只会在每次加载时打一条错误日志 (csrc/offline-tts-kokoro-model-config.cc)。
                dict_dir: None,
                lexicon: Some(lexicon),
                lang: None,
                length_scale: 1.0,
            },
            num_threads: inference_threads(),
            ..Default::default()
        },
        rule_fsts,
        ..Default::default()
    };
    OfflineTts::create(&config).ok_or_else(|| "语音引擎启动失败，模型文件可能已损坏".to_string())
}

/// 推理线程数: 用一半逻辑核 (1–4)。2 核的低配 Windows 机器上占满全部核心
/// 会让 WebView 渲染进程抢不到 CPU, 表现为朗读时窗口「无响应」。
fn inference_threads() -> i32 {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2);
    (cores / 2).clamp(1, 4) as i32
}

/// 防闪退: 加载 / 推理期间在数据目录留一个标记文件, 正常结束 (含 Rust panic) 时删除。
/// 原生库直接崩溃时标记会留下; 下次启动发现它, 就不再自动加载模型, 免得每次打开都闪退。
/// 用户在听书面板点「再试一次」(local_tts_clear_crash) 或删除语音包后才解除。
pub(crate) const CRASHED_ERROR: &str = "LOCAL_TTS_CRASHED";
static ENGINE_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn crash_marker(root: &Path) -> PathBuf {
    root.with_file_name("kokoro-engine.running")
}

/// 上次加载 / 推理时应用是否意外退出 (本进程正在用引擎时不算)
fn crashed_before(root: &Path) -> bool {
    !ENGINE_BUSY.load(std::sync::atomic::Ordering::SeqCst) && crash_marker(root).exists()
}

struct CrashGuard(PathBuf);

impl CrashGuard {
    fn arm(root: &Path) -> Result<Self, String> {
        let path = crash_marker(root);
        if path.exists() {
            return Err(CRASHED_ERROR.into());
        }
        ENGINE_BUSY.store(true, std::sync::atomic::Ordering::SeqCst);
        // 写失败 (只读目录等) 不影响朗读, 只是少了这层保护
        let _ = std::fs::write(&path, b"1");
        Ok(Self(path))
    }
}

impl Drop for CrashGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        ENGINE_BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 用户确认再试一次: 清除闪退标记
#[tauri::command]
pub fn local_tts_clear_crash(app: AppHandle) -> Result<(), String> {
    let path = crash_marker(&model_root(&app)?);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("清除失败: {e}"))?;
    }
    Ok(())
}

/// 应用正常退出 (RunEvent::Exit) 时调用: 退出时恰好在合成的标记不算闪退
pub fn clear_crash_marker_on_exit(app: &AppHandle) {
    if ENGINE_BUSY.load(std::sync::atomic::Ordering::SeqCst) {
        if let Ok(root) = model_root(app) {
            let _ = std::fs::remove_file(crash_marker(&root));
        }
    }
}

/// 在引擎锁内取得 (必要时加载) 模型并执行 `f`; 模型只加载一次, 之后每段复用。
/// 只有在中文/英文音色之间切换导致规整配置变化时才重新加载 (先释放旧模型再加载)。
fn with_engine<T>(
    root: &PathBuf,
    sid: i32,
    f: impl FnOnce(&OfflineTts) -> Result<T, String>,
) -> Result<T, String> {
    let lock = ENGINE.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|_| "语音引擎锁已损坏")?;
    if !model_ready(root) {
        return Err("离线语音包未安装".into());
    }
    let _crash_guard = CrashGuard::arm(root)?;
    let rule_fsts = rule_fsts_for(root, sid);
    if guard.as_ref().map_or(true, |loaded| loaded.rule_fsts != rule_fsts) {
        *guard = None;
        let tts = build_engine(root, rule_fsts.clone())?;
        *guard = Some(LoadedEngine { tts, rule_fsts });
    }
    f(&guard.as_ref().unwrap().tts)
}

/// f32 采样 → 16-bit PCM WAV
fn to_wav(samples: &[f32], sample_rate: i32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + samples.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    wav.extend_from_slice(&(sample_rate as u32 * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        wav.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    wav
}

fn synthesize_at(root: &PathBuf, text: &str, sid: i32, speed: f32) -> Result<Vec<u8>, String> {
    with_engine(root, sid, |engine| {
        let audio = engine
            .generate_with_config(
                text,
                &GenerationConfig {
                    sid,
                    speed,
                    ..Default::default()
                },
                None::<fn(&[f32], f32) -> bool>,
            )
            .ok_or("合成失败")?;
        Ok(to_wav(audio.samples(), audio.sample_rate()))
    })
}

/// 模型加载、推理及锁等待必须在 blocking pool 执行；async 命令本身不会转移 CPU 工作。
/// 用独立线程并给足 8MB 栈: 原生库分词用递归正则, 长句在默认 2MB 的线程栈上可能栈溢出 (直接闪退)。
async fn run_engine_task<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("lightread-tts".into())
        .stack_size(8 << 20)
        .spawn(move || {
            let _ = tx.send(std::panic::catch_unwind(std::panic::AssertUnwindSafe(task)));
        })
        .map_err(|e| format!("离线语音任务失败: {e}"))?;
    match rx.await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("离线语音任务失败: 语音引擎内部错误".into()),
        Err(e) => Err(format!("离线语音任务失败: {e}")),
    }
}

/// 预加载模型 (首次约 10–20s), 让前端在开始朗读前就能提示「正在加载」并提前完成加载。
/// `sid` 可选: 传入将要使用的音色可避免英文音色首段再按另一套规整配置重载一次。
#[tauri::command]
pub async fn local_tts_warmup(app: AppHandle, sid: Option<i32>) -> Result<(), String> {
    let root = model_root(&app)?;
    let sid = sid.unwrap_or(DEFAULT_SID);
    run_engine_task(move || with_engine(&root, sid, |_| Ok(()))).await
}

/// 合成一段文本，返回 wav 字节流；Tauri 同步命令会阻塞窗口的 IPC 调用线程。
#[tauri::command]
pub async fn local_tts_synthesize(
    app: AppHandle,
    text: String,
    sid: i32,
    speed: f32,
) -> Result<tauri::ipc::Response, String> {
    let root = model_root(&app)?;
    let wav = run_engine_task(move || synthesize_at(&root, &text, sid, speed)).await?;
    Ok(tauri::ipc::Response::new(wav))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_task_runs_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = tauri::async_runtime::block_on(run_engine_task(|| {
            Ok(std::thread::current().id())
        }))
        .expect("worker should succeed");
        assert_ne!(caller, worker, "model work must not run on the IPC caller");
    }

    #[test]
    fn engine_task_preserves_errors_and_catches_worker_panics() {
        let result = tauri::async_runtime::block_on(run_engine_task(|| {
            Err::<(), _>("离线语音包未安装".to_string())
        }));
        assert_eq!(result.unwrap_err(), "离线语音包未安装");
        let result = tauri::async_runtime::block_on(run_engine_task(|| -> Result<(), String> {
            panic!("simulated inference failure");
        }));
        assert!(result.unwrap_err().starts_with("离线语音任务失败:"));
    }

    #[test]
    fn crash_marker_blocks_engine_until_cleared() {
        let dir = std::env::temp_dir().join(format!("lightread-crash-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.join("kokoro-multi-lang-v1_1");
        {
            let _g = CrashGuard::arm(&root).expect("first arm");
            assert!(crash_marker(&root).exists());
            assert!(!crashed_before(&root), "own in-flight work is not a crash");
        }
        assert!(!crash_marker(&root).exists(), "normal exit clears the marker");
        // 模拟原生崩溃: 标记留下
        std::fs::write(crash_marker(&root), b"1").unwrap();
        assert!(crashed_before(&root));
        assert_eq!(CrashGuard::arm(&root).err().as_deref(), Some(CRASHED_ERROR));
        // panic 也会清除标记
        std::fs::remove_file(crash_marker(&root)).unwrap();
        let r = std::panic::catch_unwind(|| {
            let _g = CrashGuard::arm(&root).unwrap();
            panic!("boom");
        });
        assert!(r.is_err());
        assert!(!crash_marker(&root).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inference_leaves_cores_for_the_ui() {
        let n = inference_threads();
        assert!((1..=4).contains(&n));
        if let Ok(cores) = std::thread::available_parallelism() {
            assert!(n as usize <= cores.get().max(1));
        }
    }

    #[test]
    fn rule_fsts_only_list_files_that_exist() {
        let root = std::env::temp_dir().join(format!("lightread-rule-fsts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // 旧版/残缺安装: 一个都没有 → 不设置, 引擎照旧初始化
        assert_eq!(existing_rule_fsts(&root), None);

        std::fs::write(root.join("number-zh.fst"), b"").unwrap();
        std::fs::write(root.join("phone-zh.fst"), b"").unwrap();
        // 同名目录不算文件
        std::fs::create_dir_all(root.join("date-zh.fst")).unwrap();
        let expected = format!(
            "{},{}",
            root.join("phone-zh.fst").to_string_lossy(),
            root.join("number-zh.fst").to_string_lossy()
        );
        assert_eq!(existing_rule_fsts(&root).as_deref(), Some(expected.as_str()));

        std::fs::remove_dir_all(root.join("date-zh.fst")).unwrap();
        std::fs::write(root.join("date-zh.fst"), b"").unwrap();
        let all = existing_rule_fsts(&root).unwrap();
        let names: Vec<_> = all
            .split(',')
            .map(|f| Path::new(f).file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["phone-zh.fst", "date-zh.fst", "number-zh.fst"]);
        // 英文音色不做中文规整, 中文音色才带上 FST
        assert_eq!(rule_fsts_for(&root, 0), None);
        assert_eq!(rule_fsts_for(&root, 2), None);
        assert_eq!(rule_fsts_for(&root, 3).as_deref(), Some(all.as_str()));
        assert_eq!(rule_fsts_for(&root, DEFAULT_SID).as_deref(), Some(all.as_str()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn warmup_without_model_reports_not_installed() {
        let root = std::env::temp_dir().join("lightread-no-kokoro-model");
        let err = with_engine(&root, DEFAULT_SID, |_| Ok(())).unwrap_err();
        assert_eq!(err, "离线语音包未安装");
    }

    #[test]
    fn synthesizes_with_downloaded_model() {
        let Ok(root) = std::env::var("KOKORO_MODEL_DIR") else {
            eprintln!("跳过: 未设置 KOKORO_MODEL_DIR");
            return;
        };
        let root = PathBuf::from(root);
        // 可用 KOKORO_TEST_TEXT / KOKORO_TEST_SID 换文本和音色做试听
        let text = std::env::var("KOKORO_TEST_TEXT").unwrap_or_else(|_| {
            "夜色像一块浸了水的墨布，慢慢压下来。2026年10月4日，电话13800138000，圆周率约3.14。".into()
        });
        let sid = std::env::var("KOKORO_TEST_SID")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_SID);
        let wav = synthesize_at(&root, &text, sid, 1.0).expect("synthesis should succeed");
        assert!(wav.len() > 40_000, "audio too small: {}", wav.len());
        assert_eq!(&wav[..4], b"RIFF");
        std::fs::write("/tmp/kokoro-test.wav", &wav).ok();
    }
}
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop::*;

/// 真实网络: 先走一个连不上的代理, 应自动回退直连, 下完整包并通过 SHA256 校验。
/// 约 365MB, 默认跳过: cargo test local_tts::download_live -- --ignored
#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod download_live {
    use super::desktop::{download_archive_for_test, download_routes};

    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn falls_back_to_direct_and_verifies() {
        let dir = std::env::temp_dir().join("lightread-kokoro-dl-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pack.tar.bz2");
        let mut errors = Vec::new();
        let mut ok = false;
        for route in download_routes(Some("http://127.0.0.1:9".into())) {
            match download_archive_for_test(&path, &route).await {
                Ok(()) => { ok = true; break; }
                Err(e) => errors.push(format!("{route:?}: {e}")),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        println!("errors before success: {errors:?}");
        assert!(ok, "download failed: {errors:?}");
        assert_eq!(errors.len(), 1, "bad proxy should fail once, then direct succeeds");
    }

    /// 完整安装: 下载 → 解压到含中文的目录 → 合成一句 (经独立大栈线程与闪退标记)。
    /// cargo test local_tts::download_live -- --ignored
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn installs_into_unicode_dir_and_synthesizes() {
        use super::desktop::{install_archive, synthesize_for_test, Route};
        let dir = std::env::temp_dir().join("轻阅 测试").join("tts-models");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        std::fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("kokoro-download.tar.bz2");
        download_archive_for_test(&archive, &Route::Direct).await.expect("download");
        let root = dir.join("kokoro-multi-lang-v1_1");
        // 模拟上次解压中断留下的残缺目录: 应被替换
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("model.onnx"), b"truncated").unwrap();
        install_archive(&archive, &root).expect("install");
        assert!(!archive.exists(), "archive removed after install");
        let wav = synthesize_for_test(root.clone(), "离线语音安装测试。".into()).await.expect("synthesize");
        assert_eq!(&wav[..4], b"RIFF");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// 重新生成本机语音 (Qwen3-TTS) 的参考音色 src-tauri/resources/voices/*.wav:
    /// 用 Kokoro 的两个推荐音色各读一句话 (Kokoro 模型 Apache-2.0, 合成的音频可随应用分发)。
    /// LIGHTREAD_REF_VOICE_OUT=<输出目录> cargo test local_tts::download_live::makes_reference_voices -- --ignored
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn makes_reference_voices() {
        use super::desktop::{install_archive, synthesize_voice_for_test, Route};
        let out = std::path::PathBuf::from(std::env::var("LIGHTREAD_REF_VOICE_OUT").expect("LIGHTREAD_REF_VOICE_OUT"));
        let dir = std::env::temp_dir().join("lightread-ref-voices").join("tts-models");
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.join("kokoro-multi-lang-v1_1");
        if !root.join("model.onnx").exists() {
            let archive = dir.join("kokoro-download.tar.bz2");
            download_archive_for_test(&archive, &Route::Direct).await.expect("download");
            install_archive(&archive, &root).expect("install");
        }
        // sid 3 = zf_001 (女声), sid 59 = zm_010 (男声): 模型卡给出示例的两个音色
        for (name, sid) in [("female", 3), ("male", 59)] {
            let text = "阅读是一场安静的旅行，每翻开一页，都有新的风景在等着你。";
            let wav = synthesize_voice_for_test(root.clone(), text.into(), sid).await.expect("synthesize");
            assert_eq!(&wav[..4], b"RIFF");
            std::fs::write(out.join(format!("{name}.wav")), &wav).unwrap();
            println!("{name}: {} bytes", wav.len());
        }
    }

    /// 下到一半中断 (模拟离开 / 断网), 再次下载应从已下载的位置续传并通过校验。
    /// cargo test local_tts::download_live -- --ignored
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn resumes_after_interruption() {
        use super::desktop::Route;
        let dir = std::env::temp_dir().join("lightread-kokoro-resume-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pack.tar.bz2");
        let first = tokio::time::timeout(std::time::Duration::from_secs(4), download_archive_for_test(&path, &Route::Direct)).await;
        assert!(first.is_err(), "first attempt should be cut off by the timeout");
        let partial = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        assert!(partial > 0, "partial file should be kept");
        let started = std::time::Instant::now();
        download_archive_for_test(&path, &Route::Direct).await.expect("resume should finish and verify");
        println!("partial before resume: {partial} bytes; resume took {:?}", started.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
