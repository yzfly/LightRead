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
    }

    #[tauri::command]
    pub fn local_tts_status(_app: AppHandle) -> Result<LocalTtsStatus, String> {
        Ok(LocalTtsStatus { installed: false, path: String::new() })
    }

    #[tauri::command]
    pub async fn local_tts_download(_app: AppHandle, _proxy: Option<String>) -> Result<(), String> {
        Err("移动端暂不支持离线语音包".into())
    }

    #[tauri::command]
    pub fn local_tts_remove(_app: AppHandle) -> Result<(), String> {
        Ok(())
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
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

const MODEL_DIR: &str = "tts-models/kokoro-multi-lang-v1_1";
const MODEL_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_1.tar.bz2";

static ENGINE: OnceLock<Mutex<Option<OfflineTts>>> = OnceLock::new();

fn model_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(dir.join(MODEL_DIR))
}

fn model_ready(root: &PathBuf) -> bool {
    root.join("model.onnx").exists()
        && root.join("voices.bin").exists()
        && root.join("tokens.txt").exists()
}

#[derive(Serialize)]
pub struct LocalTtsStatus {
    pub installed: bool,
    pub path: String,
}

#[tauri::command]
pub fn local_tts_status(app: AppHandle) -> Result<LocalTtsStatus, String> {
    let root = model_root(&app)?;
    Ok(LocalTtsStatus {
        installed: model_ready(&root),
        path: root.to_string_lossy().to_string(),
    })
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    phase: String,
}

/// 下载并解压模型包; 进度经 `local-tts-progress` 事件推送
#[tauri::command]
pub async fn local_tts_download(app: AppHandle, proxy: Option<String>) -> Result<(), String> {
    let root = model_root(&app)?;
    if model_ready(&root) {
        return Ok(());
    }
    let parent = root
        .parent()
        .ok_or("路径异常")?
        .to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| format!("创建目录失败: {e}"))?;

    let emit = {
        let app = app.clone();
        move |downloaded: u64, total: u64, phase: &str| {
            let _ = app.emit(
                "local-tts-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    phase: phase.into(),
                },
            );
        }
    };

    // 下载 (blocking IO 放独立线程)
    let archive_path = parent.join("kokoro-download.tar.bz2");
    let archive = archive_path.clone();
    let proxy_url = proxy.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut agent_builder = ureq::AgentBuilder::new();
        if !proxy_url.is_empty() {
            let p = ureq::Proxy::new(&proxy_url).map_err(|e| format!("代理无效: {e}"))?;
            agent_builder = agent_builder.proxy(p);
        }
        let agent = agent_builder.build();
        let resp = agent
            .get(MODEL_URL)
            .call()
            .map_err(|e| format!("下载失败: {e}"))?;
        let total: u64 = resp
            .header("content-length")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let mut reader = resp.into_reader();
        let mut file =
            std::fs::File::create(&archive).map_err(|e| format!("写入失败: {e}"))?;
        let mut buf = [0u8; 256 * 1024];
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        loop {
            let n = std::io::Read::read(&mut reader, &mut buf)
                .map_err(|e| format!("下载中断: {e}"))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| format!("写入失败: {e}"))?;
            downloaded += n as u64;
            if last_emit.elapsed().as_millis() > 200 {
                emit(downloaded, total, "downloading");
                last_emit = std::time::Instant::now();
            }
        }
        emit(downloaded, total, "extracting");

        // 解压 (tar.bz2), 顶层目录即 kokoro-multi-lang-v1_1
        let file = std::fs::File::open(&archive).map_err(|e| format!("读取包失败: {e}"))?;
        let bz = bzip2::read::BzDecoder::new(file);
        let mut tar = tar::Archive::new(bz);
        tar.unpack(&parent).map_err(|e| format!("解压失败: {e}"))?;
        let _ = std::fs::remove_file(&archive);
        emit(downloaded, total, "done");
        Ok(())
    })
    .await
    .map_err(|e| format!("任务失败: {e}"))??;

    let root = model_root(&app)?;
    if !model_ready(&root) {
        return Err("解压后未找到模型文件".into());
    }
    Ok(())
}

#[tauri::command]
pub fn local_tts_remove(app: AppHandle) -> Result<(), String> {
    // 卸载前释放引擎
    if let Some(lock) = ENGINE.get() {
        *lock.lock().unwrap() = None;
    }
    let root = model_root(&app)?;
    std::fs::remove_dir_all(&root).map_err(|e| format!("删除失败: {e}"))?;
    Ok(())
}

fn build_engine(root: &PathBuf) -> Result<OfflineTts, String> {
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
                dict_dir: p("dict"),
                lexicon: Some(lexicon),
                lang: None,
                length_scale: 1.0,
            },
            num_threads: 2,
            ..Default::default()
        },
        ..Default::default()
    };
    OfflineTts::create(&config).ok_or_else(|| "初始化语音引擎失败 (模型文件可能损坏)".to_string())
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
    if !model_ready(root) {
        return Err("离线语音包未安装".into());
    }
    let lock = ENGINE.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().map_err(|_| "引擎忙")?;
    if guard.is_none() {
        *guard = Some(build_engine(root)?);
    }
    let engine = guard.as_ref().unwrap();
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
}

/// 合成一段文本, 返回 wav 字节流 (同步命令, tauri 自动放线程池)
#[tauri::command]
pub fn local_tts_synthesize(
    app: AppHandle,
    text: String,
    sid: i32,
    speed: f32,
) -> Result<tauri::ipc::Response, String> {
    let root = model_root(&app)?;
    Ok(tauri::ipc::Response::new(synthesize_at(&root, &text, sid, speed)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthesizes_with_downloaded_model() {
        let Ok(root) = std::env::var("KOKORO_MODEL_DIR") else {
            eprintln!("跳过: 未设置 KOKORO_MODEL_DIR");
            return;
        };
        let root = PathBuf::from(root);
        let wav = synthesize_at(&root, "夜色像一块浸了水的墨布，慢慢压下来。", 50, 1.0)
            .expect("synthesis should succeed");
        assert!(wav.len() > 40_000, "audio too small: {}", wav.len());
        assert_eq!(&wav[..4], b"RIFF");
        std::fs::write("/tmp/kokoro-test.wav", &wav).ok();
    }
}
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop::*;
