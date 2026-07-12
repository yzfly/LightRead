mod calibre;
mod edge_tts;
mod fonts;
mod local_tts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      edge_tts::edge_tts_synthesize,
      fonts::list_system_fonts,
      calibre::calibre_list_books,
      calibre::calibre_read_file,
      local_tts::local_tts_status,
      local_tts::local_tts_download,
      local_tts::local_tts_remove,
      local_tts::local_tts_synthesize
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
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
