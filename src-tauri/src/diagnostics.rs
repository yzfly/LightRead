//! 诊断日志: 滚动日志文件 + 前端日志入口 + 导出时读取。
//! 文件在应用日志目录, 只留本机; 用户在设置里主动导出才会离开设备。
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const MAX_FILE_BYTES: u128 = 1024 * 1024;
/// 当前文件之外再留 4 份历史
const KEEP_ROTATED: usize = 4;
/// 导出上限: 正常不会到, 防止目录里混入大文件
const MAX_EXPORT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_LINES_PER_CALL: usize = 500;
const MAX_LINE_CHARS: usize = 8000;

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
  let mut builder = tauri_plugin_log::Builder::default()
    .clear_targets()
    .target(Target::new(TargetKind::LogDir {
      file_name: Some("lightread".into()),
    }))
    .level(log::LevelFilter::Info)
    .max_file_size(MAX_FILE_BYTES)
    .rotation_strategy(RotationStrategy::KeepSome(KEEP_ROTATED))
    .timezone_strategy(TimezoneStrategy::UseLocal);
  if cfg!(debug_assertions) {
    builder = builder.target(Target::new(TargetKind::Stdout));
  }
  app.plugin(builder.build())?;

  let previous = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
    log::error!(target: "panic", "{info}");
    previous(info);
  }));
  log::info!(
    target: "app",
    "start v{} {} {}",
    app.package_info().version,
    std::env::consts::OS,
    std::env::consts::ARCH
  );
  Ok(())
}

#[derive(Debug, Deserialize)]
pub struct AppendLine {
  level: String,
  area: String,
  message: String,
}

fn truncate_chars(text: &str, limit: usize) -> &str {
  match text.char_indices().nth(limit) {
    Some((index, _)) => &text[..index],
    None => text,
  }
}

/// 前端日志写入同一文件。前端已脱敏, 导出时还会再脱敏一次
#[tauri::command]
pub fn diagnostics_append(lines: Vec<AppendLine>) {
  for line in lines.iter().take(MAX_LINES_PER_CALL) {
    let area = truncate_chars(&line.area, 32);
    let message = truncate_chars(&line.message, MAX_LINE_CHARS);
    match line.level.as_str() {
      "error" => log::error!(target: "ui", "[{area}] {message}"),
      "warn" => log::warn!(target: "ui", "[{area}] {message}"),
      _ => log::info!(target: "ui", "[{area}] {message}"),
    }
  }
}

#[derive(Debug, Serialize)]
pub struct LogFile {
  name: String,
  text: String,
}

/// 目录下 .log 文件, 新的优先, 总量不超过上限
fn read_logs_from(dir: &Path) -> std::io::Result<Vec<LogFile>> {
  let mut entries: Vec<_> = fs::read_dir(dir)?
    .filter_map(Result::ok)
    .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "log"))
    .filter_map(|entry| {
      let meta = entry.metadata().ok()?;
      meta.is_file().then(|| (meta.modified().ok(), meta.len(), entry))
    })
    .collect();
  entries.sort_by(|a, b| b.0.cmp(&a.0));
  let mut remaining = MAX_EXPORT_BYTES;
  let mut files = Vec::new();
  for (_, len, entry) in entries {
    if len > remaining {
      continue;
    }
    let Ok(bytes) = fs::read(entry.path()) else { continue };
    remaining -= len;
    files.push(LogFile {
      name: entry.file_name().to_string_lossy().into_owned(),
      text: String::from_utf8_lossy(&bytes).into_owned(),
    });
  }
  Ok(files)
}

#[tauri::command]
pub async fn diagnostics_read_logs<R: Runtime>(app: AppHandle<R>) -> Result<Vec<LogFile>, String> {
  let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
  tauri::async_runtime::spawn_blocking(move || read_logs_from(&dir).map_err(|e| e.to_string()))
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
  os: &'static str,
  arch: &'static str,
  webview: Option<String>,
  total_memory_mb: Option<u64>,
  free_memory_mb: Option<u64>,
}

#[cfg(windows)]
fn memory_mb() -> (Option<u64>, Option<u64>) {
  use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
  let mut status = MEMORYSTATUSEX {
    dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
    ..Default::default()
  };
  // SAFETY: status 是本函数持有的有效结构, dwLength 已按要求设置
  match unsafe { GlobalMemoryStatusEx(&mut status) } {
    Ok(()) => (
      Some(status.ullTotalPhys / 1024 / 1024),
      Some(status.ullAvailPhys / 1024 / 1024),
    ),
    Err(_) => (None, None),
  }
}

#[cfg(not(windows))]
fn memory_mb() -> (Option<u64>, Option<u64>) {
  (None, None)
}

#[tauri::command]
pub fn diagnostics_system_info() -> SystemInfo {
  let (total_memory_mb, free_memory_mb) = memory_mb();
  SystemInfo {
    os: std::env::consts::OS,
    arch: std::env::consts::ARCH,
    webview: tauri::webview_version().ok(),
    total_memory_mb,
    free_memory_mb,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn truncates_on_char_boundary() {
    assert_eq!(truncate_chars("轻阅日志", 2), "轻阅");
    assert_eq!(truncate_chars("ab", 5), "ab");
  }

  #[test]
  fn reads_only_log_files_newest_first_within_limit() {
    let dir = std::env::temp_dir().join(format!("lightread-diag-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("lightread.log"), "current").unwrap();
    fs::write(dir.join("notes.txt"), "ignored").unwrap();
    let files = read_logs_from(&dir).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "lightread.log");
    assert_eq!(files[0].text, "current");
    fs::remove_dir_all(&dir).unwrap();
  }
}
