//! 主窗口外观。
//!
//! Windows 与 macOS 对齐 (2026-11-08 用户要求): 不用系统标题栏和那圈深色细边框, 窗口四角为圆角。
//! - 标题栏由前端绘制 (components/WindowTitleBar.vue: 拖动区 + 最小化 / 最大化 / 关闭), 窗口无系统装饰。
//! - Windows 11: 无装饰窗口开启阴影后, 系统 (DWM) 自己画圆角与阴影, 前端不再裁圆角。
//! - Windows 10: 系统不支持圆角, 开阴影还会多出一圈 1px 白边; 所以关阴影, 由透明窗口里的页面画圆角
//!   (`html.lr-chrome-round`)。
//! - macOS / Linux 保持系统标题栏, 不受影响。
//!
//! 另外, 默认窗口 1180×780 在 1080p + 150% 缩放的屏幕上比工作区还高, 底边会跑到任务栏下面
//! (2026-11-08 Win10 实测外框 1792×1106), 启动时缩到工作区以内并居中。

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChromeInfo {
  /// 前端自绘标题栏 (窗口无系统装饰)
  pub custom: bool,
  /// 系统已画圆角 (Windows 11), 页面不必再裁
  pub native_round: bool,
}

/// Windows 内部版本号; 22000 起为 Windows 11
#[cfg(windows)]
fn windows_build() -> u32 {
  use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
  use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
  // RtlGetVersion 不受兼容性清单影响, 总是返回真实版本
  let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
  info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
  if unsafe { RtlGetVersion(&mut info) } == 0 {
    info.dwBuildNumber
  } else {
    0
  }
}

pub fn info() -> ChromeInfo {
  #[cfg(windows)]
  {
    ChromeInfo { custom: true, native_round: windows_build() >= 22000 }
  }
  #[cfg(not(windows))]
  {
    ChromeInfo { custom: false, native_round: false }
  }
}

/// 窗口工作区放不下时缩到 92% 并居中 (纯函数, 便于测试); 放得下返回 None
pub fn fit_rect(size: (u32, u32), work: (i32, i32, u32, u32)) -> Option<(i32, i32, u32, u32)> {
  let (w, h) = size;
  let (wx, wy, ww, wh) = work;
  if ww == 0 || wh == 0 || (w <= ww && h <= wh) {
    return None;
  }
  let nw = w.min(ww * 92 / 100);
  let nh = h.min(wh * 92 / 100);
  Some((wx + ((ww - nw) / 2) as i32, wy + ((wh - nh) / 2) as i32, nw, nh))
}

#[cfg(desktop)]
mod imp {
  use super::*;
  use tauri::{Runtime, WebviewWindow};

  /// 普通 (非摸鱼) 窗口的装饰: 启动时与退出摸鱼时调用
  pub fn apply_normal<R: Runtime>(window: &WebviewWindow<R>) {
    let chrome = info();
    if chrome.custom {
      let _ = window.set_decorations(false);
      let _ = window.set_shadow(chrome.native_round);
    } else {
      let _ = window.set_decorations(true);
      let _ = window.set_shadow(true);
    }
  }

  /// 启动时: 设好装饰, 窗口超出所在屏幕工作区就缩进来
  pub fn setup<R: Runtime>(window: &WebviewWindow<R>) {
    apply_normal(window);
    let (Ok(size), Ok(Some(monitor))) = (window.outer_size(), window.current_monitor()) else { return };
    let area = monitor.work_area();
    if let Some((x, y, w, h)) = fit_rect((size.width, size.height), (area.position.x, area.position.y, area.size.width, area.size.height)) {
      log::info!(target: "window", "fit to work area: {}x{} -> {w}x{h}", size.width, size.height);
      let _ = window.set_size(tauri::PhysicalSize::new(w, h));
      let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
  }
}

#[cfg(desktop)]
pub use imp::{apply_normal, setup};

#[tauri::command]
pub fn window_chrome() -> ChromeInfo {
  info()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn window_larger_than_work_area_is_shrunk_and_centered() {
    // 1080p 屏, 任务栏 40px; 150% 缩放下的默认窗口 1792×1176
    assert_eq!(fit_rect((1792, 1176), (0, 0, 1920, 1040)), Some((77, 42, 1766, 956)));
    // 只是高度超出: 宽度不变
    assert_eq!(fit_rect((1200, 1100), (0, 0, 1920, 1040)), Some((360, 42, 1200, 956)));
  }

  #[test]
  fn window_that_fits_is_left_alone() {
    assert_eq!(fit_rect((1200, 850), (0, 0, 1920, 1040)), None);
    assert_eq!(fit_rect((1200, 850), (0, 0, 0, 0)), None);
  }

  #[test]
  fn chrome_info_serializes_camel_case() {
    let json = serde_json::to_string(&ChromeInfo { custom: true, native_round: false }).unwrap();
    assert_eq!(json, r#"{"custom":true,"nativeRound":false}"#);
  }
}
