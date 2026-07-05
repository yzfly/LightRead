mod calibre;
mod edge_tts;
mod local_tts;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      edge_tts::edge_tts_synthesize,
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
