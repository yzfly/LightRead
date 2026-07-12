//! 系统字体枚举: 供阅读排版设置选择本机已安装字体

#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut names: Vec<String> = db
        .faces()
        .filter_map(|face| face.families.first().map(|(name, _)| name.clone()))
        .collect();
    names.sort();
    names.dedup();
    names
}
