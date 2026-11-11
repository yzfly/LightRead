// 没有直接暴露给网页的命令: 网页只调主程序的 `ios_shell` 命令 (src-tauri/src/ios_shell.rs),
// 所以不需要插件权限, 桌面与 Android 的 capabilities 也不受影响。
fn main() {
  tauri_plugin::Builder::new(&[]).ios_path("ios").build();
}
