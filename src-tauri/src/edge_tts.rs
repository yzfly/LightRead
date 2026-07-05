//! Edge TTS: 微软 Edge 浏览器"大声朗读"的神经网络语音合成.
//! 端点要求特定的 Origin / User-Agent 握手头, 浏览器 JS 无法设置, 故在 Rust 侧实现.

use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION: &str = "143.0.3650.75";
const OUTPUT_FORMAT: &str = "audio-24khz-48kbitrate-mono-mp3";

/// Sec-MS-GEC: Windows 文件时间 ticks 按 5 分钟窗口取整后与 token 拼接做 SHA-256
fn sec_ms_gec() -> String {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let win_seconds = unix + 11_644_473_600;
    let rounded = win_seconds - (win_seconds % 300);
    let ticks = rounded * 10_000_000;
    let digest = Sha256::digest(format!("{ticks}{TRUSTED_CLIENT_TOKEN}").as_bytes());
    digest
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<String>()
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn timestamp() -> String {
    // 端点不校验精确格式, ISO 即可
    chrono_lite_now()
}

fn chrono_lite_now() -> String {
    // 避免引入 chrono: 用 SystemTime 粗略生成 RFC3339 风格时间戳
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{secs}")
}

async fn synthesize_inner(text: &str, voice: &str, rate_percent: i32) -> Result<Vec<u8>, String> {
    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1\
         ?TrustedClientToken={TRUSTED_CLIENT_TOKEN}\
         &Sec-MS-GEC={}\
         &Sec-MS-GEC-Version=1-{CHROMIUM_VERSION}\
         &ConnectionId={connection_id}",
        sec_ms_gec()
    );

    let major = CHROMIUM_VERSION.split('.').next().unwrap_or("143");
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("构造请求失败: {e}"))?;
    let headers = request.headers_mut();
    headers.insert(
        "Origin",
        "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"
            .parse()
            .unwrap(),
    );
    headers.insert(
        "User-Agent",
        format!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36 Edg/{major}.0.0.0"
        )
        .parse()
        .unwrap(),
    );
    headers.insert("Pragma", "no-cache".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());
    headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());

    let (mut ws, _) = connect_async(request)
        .await
        .map_err(|e| format!("连接语音服务失败: {e}"))?;

    let ts = timestamp();
    let config = format!(
        "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\
         \"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"}},\
         \"outputFormat\":\"{OUTPUT_FORMAT}\"}}}}}}}}"
    );
    ws.send(Message::Text(config.into()))
        .await
        .map_err(|e| format!("发送配置失败: {e}"))?;

    let sign = if rate_percent >= 0 { "+" } else { "" };
    let ssml = format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
         <voice name='{voice}'><prosody pitch='+0Hz' rate='{sign}{rate_percent}%' volume='+0%'>\
         {}</prosody></voice></speak>",
        escape_xml(text)
    );
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let ssml_message = format!(
        "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\n\
         X-Timestamp:{ts}\r\nPath:ssml\r\n\r\n{ssml}"
    );
    ws.send(Message::Text(ssml_message.into()))
        .await
        .map_err(|e| format!("发送合成请求失败: {e}"))?;

    let mut audio: Vec<u8> = Vec::new();
    while let Some(frame) = ws.next().await {
        match frame.map_err(|e| format!("接收音频失败: {e}"))? {
            Message::Text(text_frame) => {
                if text_frame.contains("Path:turn.end") {
                    break;
                }
            }
            Message::Binary(data) => {
                if data.len() < 2 {
                    continue;
                }
                let header_len = u16::from_be_bytes([data[0], data[1]]) as usize;
                if data.len() < 2 + header_len {
                    continue;
                }
                let header = String::from_utf8_lossy(&data[2..2 + header_len]);
                if header.contains("Path:audio") {
                    audio.extend_from_slice(&data[2 + header_len..]);
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = ws.close(None).await;

    if audio.is_empty() {
        return Err("语音服务未返回音频".into());
    }
    Ok(audio)
}

/// 合成一段文本, 返回 mp3 字节流
#[tauri::command]
pub async fn edge_tts_synthesize(
    text: String,
    voice: String,
    rate_percent: i32,
) -> Result<tauri::ipc::Response, String> {
    let audio = synthesize_inner(&text, &voice, rate_percent).await?;
    Ok(tauri::ipc::Response::new(audio))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn synthesizes_chinese_mp3() {
        let audio = synthesize_inner("夜色像一块浸了水的墨布。", "zh-CN-XiaoxiaoNeural", 0)
            .await
            .expect("synthesis should succeed");
        assert!(audio.len() > 4000, "audio too small: {}", audio.len());
        // MP3 帧同步字 0xFFEx 或 ID3 头
        let is_mp3 = audio[0] == 0xFF || &audio[..3] == b"ID3";
        assert!(is_mp3, "not mp3: {:02X?}", &audio[..4.min(audio.len())]);
    }
}
