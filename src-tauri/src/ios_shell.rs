//! iOS 原生壳的入口: 网页调 `ios_shell`, 转给 Swift 插件 (plugins/ios-shell)。
//! 其他平台没有这个壳, 命令照常注册但直接报错, 前端只在 iOS 构建里调用。
use serde_json::Value;

/// 允许网页调用的方法, 与 ShellPlugin.swift 的 @objc 方法一一对应。
const COMMANDS: &[&str] = &[
  "setBarsDark",
  "setImmersive",
  "setKeepScreenOn",
  "setSelectionMenu",
  "saveImage",
  "shareFile",
  "shareText",
  "haptic",
];

fn allowed(command: &str) -> bool {
  COMMANDS.contains(&command)
}

#[tauri::command]
pub async fn ios_shell(app: tauri::AppHandle, command: String, args: Option<Value>) -> Result<Value, String> {
  if !allowed(&command) {
    return Err(format!("unknown ios_shell command: {command}"));
  }
  let args = args.unwrap_or_else(|| Value::Object(Default::default()));
  #[cfg(target_os = "ios")]
  {
    use tauri::Manager as _;
    app.state::<tauri_plugin_lightread_shell::Shell<tauri::Wry>>().call(&command, args)
  }
  #[cfg(not(target_os = "ios"))]
  {
    let _ = (app, args);
    Err("ios_shell is only available on iOS".into())
  }
}

#[cfg(test)]
mod tests {
  use super::allowed;

  #[test]
  fn ios_shell_only_forwards_known_commands() {
    assert!(allowed("setBarsDark"));
    assert!(allowed("shareFile"));
    assert!(!allowed("openInstaller"));
    assert!(!allowed(""));
  }
}
