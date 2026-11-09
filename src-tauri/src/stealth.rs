//! 摸鱼模式 (桌面): 让阅读窗口尽量不显眼。
//!
//! - 去掉系统标题栏、边框与窗口阴影, 可选置顶与窗口标题伪装 (任务栏里显示的名字);
//! - 老板键: 注册一个全局快捷键, 轻阅不在前台时也能按, 按一下窗口立即隐藏 (连任务栏图标一起消失),
//!   再按一下原样恢复。隐藏 / 恢复都在原生层完成, 不依赖网页 (窗口隐藏后 WebView 可能被节流);
//!   同时向前端发 `stealth-boss` 事件 ({ hidden }), 前端据此暂停听书和背景音, 免得窗口藏了声音还在。
//! - 可选: 不在任务栏 / Alt+Tab 里显示 (Windows 另加 WS_EX_TOOLWINDOW 并用子类过程守住, 只删任务栏按钮挡不住 Alt+Tab);
//!   截图 / 录屏 / 共享屏幕时隐藏窗口 (set_content_protected, Windows 10 2004+ 为 WDA_EXCLUDEFROMCAPTURE)。
//! - 摸鱼与普通阅读各记一套窗口位置大小: 进入时套用上次摸鱼的位置 (须仍在某块屏幕上), 退出时把摸鱼位置交给前端保存,
//!   再恢复进入前的位置大小。
//! - 退出时恢复进入前的标题与窗口装饰, 并注销快捷键。
//! - 窗口藏起后忘了老板键: 再次启动轻阅 (单实例) 会把窗口找回来, 见 lib.rs。
//!
//! 窗口半透明由前端完成: 主窗口以透明窗口创建 (tauri.conf.json `transparent`), 平时页面背景不透明,
//! 摸鱼模式下把阅读区背景换成带透明度的颜色。移动端没有这些窗口概念, 命令直接报不支持。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthOptions {
  /// 窗口标题伪装; 为空时保持进入前的标题
  #[serde(default)]
  pub title: Option<String>,
  /// 窗口置顶
  #[serde(default)]
  pub always_on_top: bool,
  /// 老板键, 如 "Alt+Shift+Z"; 为空不注册
  #[serde(default)]
  pub boss_key: Option<String>,
  /// 不在任务栏和 Alt+Tab 里显示
  #[serde(default)]
  pub skip_taskbar: bool,
  /// 截图 / 录屏 / 共享屏幕时隐藏窗口
  #[serde(default)]
  pub hide_from_capture: bool,
  /// 上次摸鱼时的窗口位置大小 (物理像素); 不在任何屏幕上时忽略
  #[serde(default)]
  pub bounds: Option<Bounds>,
}

/// 窗口位置 (外框左上角) 与内容区大小 (物理像素)
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Bounds {
  pub x: i32,
  pub y: i32,
  pub w: u32,
  pub h: u32,
}

/// 窗口至少有一块 (边长 ≥ 80px 的) 区域落在某块屏幕里才算可用, 免得换了显示器后窗口跑到屏幕外找不回
fn bounds_visible(b: &Bounds, screens: &[Bounds]) -> bool {
  if b.w < 200 || b.h < 120 {
    return false;
  }
  screens.iter().any(|s| {
    let ix = (b.x + b.w as i32).min(s.x + s.w as i32) - b.x.max(s.x);
    let iy = (b.y + b.h as i32).min(s.y + s.h as i32) - b.y.max(s.y);
    ix >= 80 && iy >= 80
  })
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthResult {
  /// 老板键是否注册成功
  pub boss_key: bool,
  /// 注册失败的原因 (快捷键格式不对 / 已被其他软件占用 / Wayland 不支持全局快捷键)
  pub boss_key_error: Option<String>,
}

struct Saved {
  title: String,
  boss_key: Option<String>,
  /// 进入前的窗口位置大小与是否最大化
  normal: Option<Bounds>,
  maximized: bool,
  /// 当前生效的任务栏 / 截图设置 (只在变化时调原生接口, 免得反复闪)
  skip_taskbar: bool,
  hide_from_capture: bool,
}

/// 进入摸鱼模式前的窗口状态; None 表示未处于摸鱼模式
#[derive(Default)]
pub struct StealthState(Mutex<Option<Saved>>);

/// 规范化老板键: 去掉空白, 空串视为不注册
fn normalize_key(key: Option<&str>) -> Option<String> {
  let k: String = key?.chars().filter(|c| !c.is_whitespace()).collect();
  if k.is_empty() { None } else { Some(k) }
}

/// 伪装标题: 去掉首尾空白并限制长度, 空串视为不伪装
fn disguise_title(title: Option<&str>) -> Option<String> {
  let t = title?.trim();
  if t.is_empty() { None } else { Some(t.chars().take(80).collect()) }
}

#[cfg(desktop)]
mod imp {
  use super::*;
  use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
  use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

  #[derive(Clone, Serialize)]
  struct BossEvent {
    hidden: bool,
  }

  /// 老板键: 可见则隐藏, 隐藏则恢复并聚焦
  fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window("main") else { return };
    let visible = win.is_visible().unwrap_or(true) && !win.is_minimized().unwrap_or(false);
    if visible {
      let _ = app.emit("stealth-boss", BossEvent { hidden: true });
      let _ = win.hide();
    } else {
      let _ = win.show();
      let _ = win.unminimize();
      let _ = win.set_focus();
      let _ = app.emit("stealth-boss", BossEvent { hidden: false });
    }
  }

  fn register<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<(), String> {
    app
      .global_shortcut()
      .on_shortcut(key, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
          toggle_window(app);
        }
      })
      .map_err(|e| e.to_string())
  }

  fn unregister<R: Runtime>(app: &AppHandle<R>, key: &str) {
    let _ = app.global_shortcut().unregister(key);
  }

  /// 外框左上角 + 内容区大小: set_size 设的是内容区, 记外框大小再设回去会每次多出边框和标题栏
  /// (2026-11-08 Win10 实测每进出一次大 22×56)
  fn bounds_of<R: Runtime>(window: &WebviewWindow<R>) -> Option<Bounds> {
    let p = window.outer_position().ok()?;
    let s = window.inner_size().ok()?;
    Some(Bounds { x: p.x, y: p.y, w: s.width, h: s.height })
  }

  fn apply_bounds<R: Runtime>(window: &WebviewWindow<R>, b: Bounds) {
    let _ = window.set_position(tauri::PhysicalPosition::new(b.x, b.y));
    let _ = window.set_size(tauri::PhysicalSize::new(b.w, b.h));
  }

  fn screens<R: Runtime>(window: &WebviewWindow<R>) -> Vec<Bounds> {
    window
      .available_monitors()
      .unwrap_or_default()
      .iter()
      .map(|m| {
        let a = m.work_area();
        Bounds { x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height }
      })
      .collect()
  }

  /// 不在任务栏 / Alt+Tab 显示。任务栏按钮由 tao 经 ITaskbarList 删除; Alt+Tab 另要 WS_EX_TOOLWINDOW。
  fn set_skip_taskbar<R: Runtime>(window: &WebviewWindow<R>, skip: bool) {
    #[cfg(windows)]
    {
      if let Ok(hwnd) = window.hwnd() {
        tool_style::set(hwnd.0 as _, skip);
      }
    }
    let _ = window.set_skip_taskbar(skip);
  }

  /// tao 每次改窗口状态 (置顶 / 显示隐藏 / 最大化) 都按自己的标志重写整组扩展样式, 会冲掉直接加上的
  /// WS_EX_TOOLWINDOW (2026-11-08 Win10 实测: 任务栏没了, Ctrl+Alt+Tab 里还在)。所以给窗口挂一个子类过程:
  /// 开关打开期间拦 WM_STYLECHANGING, 不论谁改扩展样式都补上 TOOLWINDOW、去掉 APPWINDOW。
  /// 子类过程只能在窗口所在线程安装; 同步命令和全局快捷键回调都在主线程。
  #[cfg(windows)]
  mod tool_style {
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
      GetWindowLongPtrW, IsWindowVisible, SetWindowLongPtrW, ShowWindow, GWL_EXSTYLE, STYLESTRUCT, SW_HIDE, SW_SHOW, WM_NCDESTROY,
      WM_STYLECHANGING, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    static SKIP: AtomicBool = AtomicBool::new(false);
    static HOOKED: AtomicBool = AtomicBool::new(false);
    const ID: usize = 0x4C52_5354;

    unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
      if msg == WM_STYLECHANGING && wparam as i32 == GWL_EXSTYLE && SKIP.load(Ordering::Relaxed) && lparam != 0 {
        let ss = &mut *(lparam as *mut STYLESTRUCT);
        ss.styleNew = (ss.styleNew | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
      } else if msg == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(subclass), ID);
        HOOKED.store(false, Ordering::Relaxed);
      }
      DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    pub fn set(hwnd: HWND, skip: bool) {
      unsafe {
        if skip && !HOOKED.load(Ordering::Relaxed) {
          let ok = SetWindowSubclass(hwnd, Some(subclass), ID, 0) != 0;
          HOOKED.store(ok, Ordering::Relaxed);
          if !ok {
            log::warn!(target: "stealth", "SetWindowSubclass failed; Alt+Tab may still list the window");
          }
        }
        SKIP.store(skip, Ordering::Relaxed);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let next = if skip { (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW } else { (ex & !WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW };
        if next == ex {
          return;
        }
        // 扩展样式要在窗口隐藏时改, 任务栏和切换器才会重新读取; 直接用 Win32 隐藏 / 显示, 不经 tao 再重写一遍样式
        let visible = IsWindowVisible(hwnd) != 0;
        if visible {
          ShowWindow(hwnd, SW_HIDE);
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next as isize);
        if visible {
          ShowWindow(hwnd, SW_SHOW);
        }
        log::info!(target: "stealth", "tool window style {}", if skip { "on" } else { "off" });
      }
    }
  }

  pub fn enter<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, state: &StealthState, options: StealthOptions) -> Result<StealthResult, String> {
    let mut saved = state.0.lock().map_err(|e| e.to_string())?;
    let first = saved.is_none();
    if first {
      // 最大化的窗口去掉边框后会盖住任务栏, 先还原; 还原后的位置大小才是普通窗口的「向下还原」尺寸,
      // 记下它 (而不是最大化的边界), 退出时先设回它再最大化 —— 否则向下还原会落到摸鱼时拖到的位置
      let maximized = window.is_maximized().unwrap_or(false);
      if maximized {
        let _ = window.unmaximize();
      }
      *saved = Some(Saved {
        title: window.title().unwrap_or_default(),
        boss_key: None,
        normal: bounds_of(window),
        maximized,
        skip_taskbar: false,
        hide_from_capture: false,
      });
    }
    let s = saved.as_mut().expect("saved state");
    window.set_decorations(false).map_err(|e| e.to_string())?;
    let _ = window.set_shadow(false);
    if first {
      // 去掉边框之后再套用上次摸鱼的位置大小 (内容区大小, 无边框时即窗口大小)
      if let Some(b) = options.bounds.filter(|b| bounds_visible(b, &screens(window))) {
        apply_bounds(window, b);
      }
      log::info!(target: "stealth", "enter maximized={} normal={:?} restored={:?}", s.maximized, s.normal, options.bounds);
    }
    if s.hide_from_capture != options.hide_from_capture {
      let _ = window.set_content_protected(options.hide_from_capture);
      s.hide_from_capture = options.hide_from_capture;
    }
    if s.skip_taskbar != options.skip_taskbar {
      set_skip_taskbar(window, options.skip_taskbar);
      s.skip_taskbar = options.skip_taskbar;
    }
    let _ = window.set_always_on_top(options.always_on_top);
    let title = disguise_title(options.title.as_deref()).unwrap_or_else(|| s.title.clone());
    let _ = window.set_title(&title);

    // 老板键: 与已注册的相同就保留, 否则换新
    let next = normalize_key(options.boss_key.as_deref());
    let mut result = StealthResult::default();
    if s.boss_key != next {
      if let Some(old) = s.boss_key.take() {
        unregister(app, &old);
      }
      if let Some(key) = next {
        match register(app, &key) {
          Ok(()) => s.boss_key = Some(key),
          Err(e) => result.boss_key_error = Some(e),
        }
      }
    }
    result.boss_key = s.boss_key.is_some();
    Ok(result)
  }

  /// 退出摸鱼; 返回摸鱼时的窗口位置大小, 由前端保存给下次用
  pub fn exit<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, state: &StealthState) -> Result<Option<Bounds>, String> {
    let saved = state.0.lock().map_err(|e| e.to_string())?.take();
    let Some(saved) = saved else { return Ok(None) };
    if let Some(key) = saved.boss_key {
      unregister(app, &key);
    }
    // 老板键藏着时退出 (如关闭书): 先放回来, 再读位置
    let _ = window.show();
    let stealth_bounds = bounds_of(window);
    if saved.skip_taskbar {
      set_skip_taskbar(window, false);
    }
    if saved.hide_from_capture {
      let _ = window.set_content_protected(false);
    }
    let _ = window.set_always_on_top(false);
    let _ = window.set_title(&saved.title);
    // 回到普通窗口的装饰 (Windows 为自绘标题栏 + 圆角, 其他平台为系统标题栏)
    crate::window_chrome::apply_normal(window);
    // 装回边框之后再设位置大小, 内容区大小不受边框影响
    if let Some(b) = saved.normal {
      apply_bounds(window, b);
    }
    if saved.maximized {
      let _ = window.maximize();
    }
    log::info!(target: "stealth", "exit stealth={:?} normal={:?} maximized={}", stealth_bounds, saved.normal, saved.maximized);
    Ok(stealth_bounds)
  }

  /// 再次启动轻阅时 (单实例回调): 窗口被老板键藏着就放出来, 并通知前端
  pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    let Some(win) = app.get_webview_window("main") else {
      log::warn!(target: "stealth", "reveal: no main window");
      return;
    };
    let hidden = !win.is_visible().unwrap_or(true);
    log::info!(target: "stealth", "reveal on second launch, hidden={hidden}");
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    if hidden {
      let _ = app.emit("stealth-boss", BossEvent { hidden: false });
    }
  }
}

#[tauri::command]
pub fn stealth_enter<R: tauri::Runtime>(
  app: tauri::AppHandle<R>,
  window: tauri::WebviewWindow<R>,
  state: tauri::State<'_, StealthState>,
  options: StealthOptions,
) -> Result<StealthResult, String> {
  #[cfg(desktop)]
  {
    imp::enter(&app, &window, &state, options)
  }
  #[cfg(not(desktop))]
  {
    let _ = (app, window, state, options);
    Err("unsupported".into())
  }
}

#[tauri::command]
pub fn stealth_exit<R: tauri::Runtime>(
  app: tauri::AppHandle<R>,
  window: tauri::WebviewWindow<R>,
  state: tauri::State<'_, StealthState>,
) -> Result<Option<Bounds>, String> {
  #[cfg(desktop)]
  {
    imp::exit(&app, &window, &state)
  }
  #[cfg(not(desktop))]
  {
    let _ = (app, window, state);
    Ok(None)
  }
}

#[cfg(desktop)]
pub use imp::reveal;

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn boss_key_is_normalized() {
    assert_eq!(normalize_key(Some(" Alt + Shift + Z ")), Some("Alt+Shift+Z".into()));
    assert_eq!(normalize_key(Some("  ")), None);
    assert_eq!(normalize_key(None), None);
  }

  #[test]
  fn disguise_title_is_trimmed_and_bounded() {
    assert_eq!(disguise_title(Some("  文档1 ")), Some("文档1".into()));
    assert_eq!(disguise_title(Some("")), None);
    assert_eq!(disguise_title(Some(&"字".repeat(200))).map(|t| t.chars().count()), Some(80));
  }

  #[test]
  fn options_deserialize_from_frontend_json() {
    let o: StealthOptions = serde_json::from_str(r#"{"title":"文档1","alwaysOnTop":true,"bossKey":"Alt+Shift+Z"}"#).unwrap();
    assert_eq!(o.title.as_deref(), Some("文档1"));
    assert!(o.always_on_top);
    assert_eq!(o.boss_key.as_deref(), Some("Alt+Shift+Z"));
    let empty: StealthOptions = serde_json::from_str("{}").unwrap();
    assert!(empty.title.is_none() && !empty.always_on_top && empty.boss_key.is_none());
    assert!(!empty.skip_taskbar && !empty.hide_from_capture && empty.bounds.is_none());
    let full: StealthOptions =
      serde_json::from_str(r#"{"skipTaskbar":true,"hideFromCapture":true,"bounds":{"x":-10,"y":20,"w":640,"h":720}}"#).unwrap();
    assert!(full.skip_taskbar && full.hide_from_capture);
    assert_eq!(full.bounds, Some(Bounds { x: -10, y: 20, w: 640, h: 720 }));
  }

  #[test]
  fn saved_bounds_must_be_on_a_screen() {
    let screens = [Bounds { x: 0, y: 0, w: 1920, h: 1040 }, Bounds { x: 1920, y: 0, w: 1280, h: 1024 }];
    assert!(bounds_visible(&Bounds { x: 100, y: 100, w: 600, h: 700 }, &screens));
    assert!(bounds_visible(&Bounds { x: 2000, y: 50, w: 600, h: 700 }, &screens), "副屏上");
    assert!(bounds_visible(&Bounds { x: -500, y: 0, w: 600, h: 400 }, &screens), "左边露出 100px");
    assert!(!bounds_visible(&Bounds { x: 3300, y: 0, w: 600, h: 700 }, &screens), "拔掉的第三块屏");
    assert!(!bounds_visible(&Bounds { x: -560, y: 0, w: 600, h: 400 }, &screens), "只露出 40px");
    assert!(!bounds_visible(&Bounds { x: 100, y: 100, w: 100, h: 700 }, &screens), "太窄");
  }
}
