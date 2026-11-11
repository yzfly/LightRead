//! LightRead 的 iOS 原生壳, 与 Android 的 `src-tauri/android/MainActivity.kt` 对应。
//! Swift 实现在 `ios/Sources/ShellPlugin.swift`; 只在 iOS 目标编译进主程序。
#![cfg(target_os = "ios")]
use serde_json::Value;
use tauri::{
  plugin::{Builder, PluginHandle, TauriPlugin},
  Manager, Runtime,
};

tauri::ios_plugin_binding!(init_plugin_lightread_shell);

pub struct Shell<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Shell<R> {
  /// 调 Swift 侧的同名方法; 参数与返回值都是 JSON 对象。
  pub fn call(&self, command: &str, args: Value) -> Result<Value, String> {
    self.0.run_mobile_plugin::<Value>(command, args).map_err(|e| e.to_string())
  }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("lightread-shell")
    .setup(|app, api| {
      let handle = api.register_ios_plugin(init_plugin_lightread_shell)?;
      app.manage(Shell(handle));
      Ok(())
    })
    .build()
}
