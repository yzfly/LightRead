//! 系统媒体控制 (Windows SMTC): 听书时让耳机线控、键盘媒体键、音量浮窗能暂停和继续 (issue #25)。
//!
//! 听书用 Web Audio 出声。WebView2 只在 AudioContext 出声时给页面挂一个系统媒体会话, 暂停时
//! AudioContext 挂起, 会话随即从系统里消失, 之后的媒体键哪里也送不到, 只能暂停不能继续。
//! 所以会话由原生层按主窗口持有: 前端上报听书状态 (播放 / 暂停 / 停止) 与书名章节, 暂停时会话保留为「已暂停」;
//! 系统按键以 `media-controls-button` 事件交给阅读页, 动作名与 navigator.mediaSession 相同。
//! WebView2 自己的媒体键处理在 tauri.windows.conf.json 里关掉 (HardwareMediaKeyHandling), 免得系统里出现两个会话。
//! 其他平台命令什么都不做。

use serde::Deserialize;
use tauri::{Runtime, WebviewWindow};

pub const BUTTON_EVENT: &str = "media-controls-button";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListenState {
  Playing,
  Paused,
  Stopped,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub struct MediaInfo {
  pub state: ListenState,
  #[serde(default)]
  pub title: String,
  #[serde(default)]
  pub artist: String,
  #[serde(default)]
  pub album: String,
}

/// SMTC 按键 (SystemMediaTransportControlsButton 的值) → 前端动作名
pub fn button_action(button: i32) -> Option<&'static str> {
  match button {
    0 => Some("play"),
    1 => Some("pause"),
    2 => Some("stop"),
    6 => Some("nexttrack"),
    7 => Some("previoustrack"),
    _ => None,
  }
}

/// 同步命令在主线程执行, 会话对象只在主线程上建立和使用
#[tauri::command]
pub fn media_controls_update<R: Runtime>(window: WebviewWindow<R>, info: MediaInfo) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  return win::update(&window, &info).map_err(|e| e.to_string());
  #[cfg(not(target_os = "windows"))]
  {
    let _ = (window, info);
    Ok(())
  }
}

#[cfg(target_os = "windows")]
mod win {
  use super::{button_action, ListenState, MediaInfo, BUTTON_EVENT};
  use std::cell::RefCell;
  use tauri::{Emitter, Runtime, WebviewWindow};
  use windows::core::{factory, HSTRING};
  use windows::Foundation::TypedEventHandler;
  use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs,
  };
  use windows::Win32::Foundation::HWND;
  use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;

  thread_local! {
    static CONTROLS: RefCell<Option<SystemMediaTransportControls>> = const { RefCell::new(None) };
  }

  fn create<R: Runtime>(window: &WebviewWindow<R>) -> Result<SystemMediaTransportControls, Box<dyn std::error::Error>> {
    let hwnd = HWND(window.hwnd()?.0 as _);
    let interop = factory::<SystemMediaTransportControls, ISystemMediaTransportControlsInterop>()?;
    let controls: SystemMediaTransportControls = unsafe { interop.GetForWindow(hwnd)? };
    controls.SetIsPlayEnabled(true)?;
    controls.SetIsPauseEnabled(true)?;
    controls.SetIsStopEnabled(true)?;
    controls.SetIsNextEnabled(true)?;
    controls.SetIsPreviousEnabled(true)?;
    let target = window.clone();
    controls.ButtonPressed(&TypedEventHandler::<SystemMediaTransportControls, SystemMediaTransportControlsButtonPressedEventArgs>::new(
      move |_, args| {
        if let Some(action) = button_action(args.ok()?.Button()?.0) {
          let _ = target.emit(BUTTON_EVENT, action);
        }
        Ok(())
      },
    ))?;
    Ok(controls)
  }

  pub fn update<R: Runtime>(window: &WebviewWindow<R>, info: &MediaInfo) -> Result<(), Box<dyn std::error::Error>> {
    CONTROLS.with(|cell| {
      let mut slot = cell.borrow_mut();
      if slot.is_none() {
        if info.state == ListenState::Stopped {
          return Ok(());
        }
        *slot = Some(create(window)?);
      }
      let controls = slot.as_ref().expect("created above");
      let display = controls.DisplayUpdater()?;
      if info.state == ListenState::Stopped {
        controls.SetPlaybackStatus(MediaPlaybackStatus::Stopped)?;
        display.ClearAll()?;
        controls.SetIsEnabled(false)?;
        return Ok(());
      }
      controls.SetIsEnabled(true)?;
      controls.SetPlaybackStatus(if info.state == ListenState::Playing { MediaPlaybackStatus::Playing } else { MediaPlaybackStatus::Paused })?;
      display.SetType(MediaPlaybackType::Music)?;
      let music = display.MusicProperties()?;
      music.SetTitle(&HSTRING::from(info.title.as_str()))?;
      music.SetArtist(&HSTRING::from(info.artist.as_str()))?;
      music.SetAlbumTitle(&HSTRING::from(info.album.as_str()))?;
      display.Update()?;
      Ok(())
    })
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn smtc_buttons_map_to_media_session_actions() {
    assert_eq!(button_action(0), Some("play"));
    assert_eq!(button_action(1), Some("pause"));
    assert_eq!(button_action(2), Some("stop"));
    assert_eq!(button_action(6), Some("nexttrack"));
    assert_eq!(button_action(7), Some("previoustrack"));
    // 快进 / 快退 / 录音等不处理
    assert_eq!(button_action(3), None);
    assert_eq!(button_action(4), None);
  }

  #[test]
  fn info_parses_the_frontend_payload() {
    let info: MediaInfo = serde_json::from_str(r#"{"state":"paused","title":"第一回","artist":"曹雪芹","album":"红楼梦"}"#).unwrap();
    assert_eq!(info.state, ListenState::Paused);
    assert_eq!(info.album, "红楼梦");
    let stopped: MediaInfo = serde_json::from_str(r#"{"state":"stopped"}"#).unwrap();
    assert_eq!(stopped.state, ListenState::Stopped);
    assert!(serde_json::from_str::<MediaInfo>(r#"{"state":"none"}"#).is_err());
  }
}
