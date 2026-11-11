mod agent;
mod app_update;
mod background_process;
mod backup_zip;
mod babeldoc;
mod calibre;
mod comic;
mod cloud_tts;
mod edge_tts;
mod sapi_tts;
mod stealth;
mod window_chrome;
mod epub_meta;
mod folder_scan;
mod fonts;
mod http_upload;
mod ios_shell;
// 不在 Windows 编译: mock 运行时会链接菜单代码, 它导入 Common Controls v6 的函数, 而测试 exe 没有应用清单,
// 加载时绑定到系统的 comctl32 v5, 整个测试程序以 STATUS_ENTRYPOINT_NOT_FOUND 启动失败 (v2.2.0 CI 实测)。
// 契约只校验 IPC 参数映射, 与平台无关, Linux / macOS 覆盖即可。
#[cfg(all(test, not(windows)))]
mod ipc_contract_tests;
mod library_files;
mod library_import;
mod local_tts;
mod diagnostics;
mod tts_device;
mod txt_epub;

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
  let bytes = std::fs::read(file).map_err(|error| format!("读取文件失败: {error}"))?;
  // iOS「用轻阅打开」交来的是系统拷进 Documents/Inbox 的副本, 读完即删, 否则每打开一次多占一份空间
  if is_ios_inbox_copy(file) {
    state.0.lock().unwrap().allowed.remove(&path);
    let _ = std::fs::remove_file(file);
  }
  Ok(tauri::ipc::Response::new(bytes))
}

fn is_ios_inbox_copy(path: &Path) -> bool {
  cfg!(target_os = "ios") && is_inbox_path(path)
}

fn is_inbox_path(path: &Path) -> bool {
  let mut parents = path.parent().into_iter().flat_map(Path::ancestors);
  parents.next().and_then(Path::file_name) == Some("Inbox".as_ref())
    && parents.next().and_then(Path::file_name) == Some("Documents".as_ref())
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

  #[test]
  fn only_direct_children_of_documents_inbox_count_as_inbox_copies() {
    use super::is_inbox_path;
    assert!(is_inbox_path(Path::new("/var/mobile/Containers/Data/Application/X/Documents/Inbox/book.epub")));
    assert!(!is_inbox_path(Path::new("/var/mobile/Containers/Data/Application/X/Documents/book.epub")));
    assert!(!is_inbox_path(Path::new("/Users/me/Inbox/book.epub")));
    assert!(!is_inbox_path(Path::new("/x/Documents/Inbox/sub/book.epub")));
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Windows/Linux 会把关联文件作为新进程参数传入；把它转交给已经运行的主实例。
  #[cfg(desktop)]
  let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
    // 再次启动轻阅: 把窗口找回来 (包括被摸鱼模式老板键藏起的窗口), 再处理要打开的文件
    stealth::reveal(app);
    queue_open_files(app, supported_paths(args));
  }))
  // 摸鱼模式的老板键 (stealth.rs)
  .plugin(tauri_plugin_global_shortcut::Builder::new().build());
  #[cfg(not(desktop))]
  let builder = tauri::Builder::default();

  let app = builder
    .manage(OpenFilesState::default())
    .manage(agent::ContextState::default())
    .manage(agent::AgentSupervisor::default())
    .manage(babeldoc::BabeldocState::default())
    .manage(stealth::StealthState::default())
    .invoke_handler(tauri::generate_handler![
      diagnostics::diagnostics_append,
      ios_shell::ios_shell,
      diagnostics::diagnostics_read_logs,
      diagnostics::diagnostics_system_info,
      take_open_files,
      read_open_file,
      agent::context::agent_snapshot_begin,
      agent::context::agent_snapshot_append_text,
      agent::context::agent_snapshot_finalize,
      agent::context::agent_snapshot_abort,
      agent::context::agent_cleanup_paper,
      agent::context::agent_workspace_path,
      agent::supervisor::agent_active_turn,
      agent::supervisor::agent_replay_events,
      agent::supervisor::agent_stop_turn,
      agent::supervisor::agent_respond_interaction,
      agent::engines::agent_engine_status,
      agent::engines::agent_start_turn,
      agent::engines::agent_reset_session,
      agent::worksheet::agent_worksheet_load,
      agent::worksheet::agent_worksheet_save_draft,
      agent::worksheet::agent_worksheet_commit_human,
      cloud_tts::cloud_tts_synthesize,
      edge_tts::edge_tts_synthesize,
      sapi_tts::sapi_tts_voices,
      sapi_tts::sapi_tts_synthesize,
      stealth::stealth_enter,
      window_chrome::window_chrome,
      stealth::stealth_exit,
      fonts::list_system_fonts,
      folder_scan::folder_scan,
      http_upload::http_upload,
      http_upload::http_upload_file,
      library_import::library_import_scan,
      library_import::library_import_copy,
      library_files::library_file_sha256,
      library_files::library_file_download,
      library_files::library_file_rename,
      library_files::library_file_remove,
      library_files::library_file_size,
      library_files::library_file_remove_derived,
      library_files::library_file_write_chunk,
      library_files::library_migrate,
      backup_zip::library_files_describe,
      backup_zip::backup_write_zip,
      backup_zip::backup_open,
      backup_zip::backup_verify,
      backup_zip::backup_extract,
      backup_zip::backup_read_entry,
      app_update::update_download,
      app_update::update_finish,
      calibre::calibre_list_books,
      comic::comic_cbr_cache,
      txt_epub::txt_epub_cache,
      epub_meta::epub_metadata,
      epub_meta::epub_read_entry,
      calibre::calibre_read_file,
      local_tts::local_tts_status,
      local_tts::local_tts_download,
      local_tts::local_tts_download_state,
      local_tts::local_tts_clear_crash,
      tts_device::local_tts_device_check,
      local_tts::local_tts_remove,
      local_tts::local_tts_warmup,
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
    .plugin(tauri_plugin_opener::init());
  // iOS 原生壳 (plugins/ios-shell): 状态栏 / 沉浸 / 分享 / 存相册
  #[cfg(target_os = "ios")]
  let app = app.plugin(tauri_plugin_lightread_shell::init());
  let app = app
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
      diagnostics::install(app.handle())?;
      // Windows: 无系统标题栏 + 圆角 (与 macOS 对齐), 超出工作区的窗口缩进来
      #[cfg(desktop)]
      if let Some(window) = app.get_webview_window("main") {
        window_chrome::setup(&window);
      }
      // Windows/Linux 冷启动时，关联文件路径直接出现在进程参数中。
      queue_open_files(app.handle(), supported_paths(std::env::args().skip(1)));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if matches!(&event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
      app_handle.state::<agent::AgentSupervisor>().stop_all();
    }
    // 正常退出时正在朗读不算闪退
    if matches!(&event, tauri::RunEvent::Exit) {
      local_tts::clear_crash_marker_on_exit(app_handle);
    }
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
