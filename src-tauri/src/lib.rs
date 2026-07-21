mod babeldoc;
mod calibre;
mod edge_tts;
mod fonts;
mod local_tts;

use std::{collections::HashSet, path::Path, sync::Mutex};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct OpenFilesData {
  pending: Vec<String>,
  allowed: HashSet<String>,
}

#[derive(Default)]
struct OpenFilesState(Mutex<OpenFilesData>);

const SUPPORTED_EXTENSIONS: &[&str] = &[
  "epub", "mobi", "azw", "azw3", "fb2", "fbz", "cbz", "cbr", "djvu", "djv", "pdf",
  "txt", "html", "htm", "xhtml", "md", "markdown",
];

fn is_supported_path(path: &Path) -> bool {
  let name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or_default()
    .to_ascii_lowercase();
  name.ends_with(".fb2.zip")
    || path
      .extension()
      .and_then(|ext| ext.to_str())
      .is_some_and(|ext| SUPPORTED_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

fn supported_paths(args: impl IntoIterator<Item = String>) -> Vec<String> {
  args
    .into_iter()
    .filter(|arg| {
      let path = Path::new(arg);
      path.is_file() && is_supported_path(path)
    })
    .collect()
}

fn queue_open_files(app: &tauri::AppHandle, paths: Vec<String>) {
  if paths.is_empty() {
    return;
  }
  let state = app.state::<OpenFilesState>();
  let mut data = state.0.lock().unwrap();
  for path in paths {
    data.allowed.insert(path.clone());
    if !data.pending.contains(&path) {
      data.pending.push(path);
    }
  }
  drop(data);
  let _ = app.emit("open-files", ());
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[tauri::command]
fn take_open_files(state: tauri::State<'_, OpenFilesState>) -> Vec<String> {
  std::mem::take(&mut state.0.lock().unwrap().pending)
}

#[tauri::command]
fn read_open_file(
  state: tauri::State<'_, OpenFilesState>,
  path: String,
) -> Result<tauri::ipc::Response, String> {
  if !state.0.lock().unwrap().allowed.contains(&path) {
    return Err("未获授权的文件".into());
  }
  let file = Path::new(&path);
  if !file.is_file() || !is_supported_path(file) {
    return Err("无效或不支持的文件".into());
  }
  std::fs::read(file)
    .map(tauri::ipc::Response::new)
    .map_err(|error| format!("读取文件失败: {error}"))
}

#[cfg(test)]
mod tests {
  use super::is_supported_path;
  use std::path::Path;

  #[test]
  fn recognizes_all_reader_file_extensions() {
    for name in [
      "book.epub",
      "book.mobi",
      "book.azw",
      "book.azw3",
      "book.fb2",
      "book.fbz",
      "book.fb2.zip",
      "book.cbz",
      "book.cbr",
      "book.djvu",
      "book.djv",
      "book.pdf",
      "book.txt",
      "book.html",
      "book.htm",
      "book.xhtml",
      "book.md",
      "book.markdown",
    ] {
      assert!(is_supported_path(Path::new(name)), "{name}");
    }
    assert!(!is_supported_path(Path::new("archive.zip")));
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  // Windows/Linux 会把关联文件作为新进程参数传入；把它转交给已经运行的主实例。
  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      queue_open_files(app, supported_paths(args));
    }));
  }

  let app = builder
    .manage(OpenFilesState::default())
    .manage(babeldoc::BabeldocState::default())
    .invoke_handler(tauri::generate_handler![
      take_open_files,
      read_open_file,
      edge_tts::edge_tts_synthesize,
      fonts::list_system_fonts,
      calibre::calibre_list_books,
      calibre::calibre_read_file,
      local_tts::local_tts_status,
      local_tts::local_tts_download,
      local_tts::local_tts_remove,
      local_tts::local_tts_synthesize,
      babeldoc::babeldoc_status,
      babeldoc::babeldoc_translate,
      babeldoc::babeldoc_cancel,
      babeldoc::babeldoc_read_output
    ])
    .plugin(tauri_plugin_sql::Builder::new().build())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .setup(|app| {
      // 老版本 (≤0.2.2) 的 PWA Service Worker 把旧界面缓存在 WebView2 数据目录;
      // WebView2 不把 SW 脚本更新请求交给 tauri.localhost 协议拦截器 (走真实网络
      // 必然失败), 前端侧的自毁 SW 永远送不到 — 只能在 webview 启动前从 Rust 侧
      // 直接删除 Service Worker 存储 (含 CacheStorage 里的旧界面缓存)。
      // 设置 (Local Storage)、书籍与进度 (SQLite/文件) 在其他目录, 不受影响。
      #[cfg(target_os = "windows")]
      {
        use tauri::Manager as _;
        if let Ok(dir) = app.path().app_local_data_dir() {
          let sw_dir = dir.join("EBWebView").join("Default").join("Service Worker");
          if sw_dir.exists() {
            let _ = std::fs::remove_dir_all(&sw_dir);
          }
        }
      }
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // Windows/Linux 冷启动时，关联文件路径直接出现在进程参数中。
      queue_open_files(app.handle(), supported_paths(std::env::args().skip(1)));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    // macOS/移动端通过系统 Opened 事件交付关联文件；冷启动事件同样先进入队列。
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
    if let tauri::RunEvent::Opened { urls } = event {
      let paths = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned());
      queue_open_files(app_handle, supported_paths(paths));
    }
  });
}
