//! API 语音 (用户自带 Key): MiniMax 与火山豆包的语音合成.
//! 接口文档: platform.minimax.cn/docs/api-reference/speech-t2a-http、docs.volcengine.com/docs/6561/1598757
//! 错误统一成 `cloud_tts:<类别>:<服务商说明>`, 前端按类别显示 (见 src/services/cloudTts.ts); Key 不进错误信息和日志。

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const MINIMAX_CN: &str = "https://api.minimax.cn";
const MINIMAX_GLOBAL: &str = "https://api.minimax.io";
const DOUBAO: &str = "https://openspeech.bytedance.com";
const MINIMAX_PATH: &str = "/v1/t2a_v2";
const DOUBAO_PATH: &str = "/api/v3/tts/unidirectional";
const DOUBAO_OK: i64 = 20_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudTtsRequest {
    provider: String,
    api_key: String,
    voice: String,
    text: String,
    rate: f64,
    model: Option<String>,
    region: Option<String>,
    app_id: Option<String>,
    resource_id: Option<String>,
    proxy: Option<String>,
}

fn fail(code: &str, detail: impl std::fmt::Display) -> String {
    let detail: String = detail.to_string().chars().take(200).collect();
    format!("cloud_tts:{code}:{detail}")
}

fn status_error(status: u16, detail: &str) -> Option<String> {
    match status {
        200..=299 => None,
        401 | 403 => Some(fail("auth", detail)),
        402 => Some(fail("quota", detail)),
        429 => Some(fail("rate", detail)),
        500..=599 => Some(fail("server", detail)),
        _ => Some(fail("bad_response", format!("HTTP {status} {detail}"))),
    }
}

fn hex_decode(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    let digit = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
        .collect()
}

fn minimax_body(req: &CloudTtsRequest) -> Value {
    json!({
        "model": req.model.as_deref().unwrap_or("speech-2.8-turbo"),
        "text": req.text,
        "stream": false,
        "output_format": "hex",
        "voice_setting": { "voice_id": req.voice, "speed": req.rate.clamp(0.5, 2.0) },
        "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1 },
    })
}

fn minimax_audio(body: &[u8]) -> Result<Vec<u8>, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|e| fail("bad_response", format!("JSON: {e}")))?;
    let code = value["base_resp"]["status_code"].as_i64().unwrap_or(-1);
    let message = value["base_resp"]["status_msg"].as_str().unwrap_or("");
    match code {
        0 => {}
        1002 | 1039 => return Err(fail("rate", message)),
        1004 | 2049 => return Err(fail("auth", message)),
        1008 => return Err(fail("quota", message)),
        1042 => return Err(fail("text", message)),
        2013 | 2054 => return Err(fail("voice", message)),
        1000 | 1001 | 1024 | 1033 => return Err(fail("server", message)),
        _ => return Err(fail("bad_response", format!("{code} {message}"))),
    }
    let audio = value["data"]["audio"].as_str().unwrap_or("");
    let bytes = hex_decode(audio).ok_or_else(|| fail("bad_response", "音频不是有效的 hex"))?;
    if bytes.is_empty() {
        return Err(fail("bad_response", "服务未返回音频"));
    }
    Ok(bytes)
}

/// 豆包 speech_rate: -50 为 0.5 倍速, 0 为原速, 100 为 2 倍速
fn doubao_speech_rate(rate: f64) -> i64 {
    (((rate - 1.0) * 100.0).round() as i64).clamp(-50, 100)
}

fn doubao_body(req: &CloudTtsRequest) -> Value {
    json!({
        "user": { "uid": "lightread" },
        "req_params": {
            "text": req.text,
            "speaker": req.voice,
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": doubao_speech_rate(req.rate),
            },
        },
    })
}

fn doubao_error(code: i64, message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("quota") || lower.contains("balance") {
        return fail("quota", message);
    }
    if lower.contains("concurrency") || lower.contains("too many") {
        return fail("rate", message);
    }
    match code {
        40_402_003 => fail("text", message),
        45_000_000 => fail("voice", message),
        45_000_010 | 45_000_011 => fail("auth", message),
        55_000_000 => fail("server", message),
        _ => fail("bad_response", format!("{code} {message}")),
    }
}

/// 响应是一串相接的 JSON: 音频块 code 为 0, data 是 base64; 结束块 code 为 20000000
fn doubao_audio(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut audio = Vec::new();
    let mut finished = false;
    for item in serde_json::Deserializer::from_slice(body).into_iter::<Value>() {
        let item = item.map_err(|e| fail("bad_response", format!("JSON: {e}")))?;
        let code = item["code"].as_i64().unwrap_or(-1);
        let message = item["message"].as_str().unwrap_or("");
        if code == DOUBAO_OK {
            finished = true;
            break;
        }
        if code != 0 {
            return Err(doubao_error(code, message));
        }
        if let Some(data) = item["data"].as_str().filter(|d| !d.is_empty()) {
            let chunk = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| fail("bad_response", format!("base64: {e}")))?;
            audio.extend_from_slice(&chunk);
        }
    }
    if !finished {
        // 连接中途断开: 半截音频不能当成功, 否则这一块后面的内容会被直接跳过
        return Err(fail("network", "响应提前结束"));
    }
    if audio.is_empty() {
        return Err(fail("bad_response", "服务未返回音频"));
    }
    Ok(audio)
}

fn client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90));
    if let Some(proxy) = proxy.map(str::trim).filter(|p| !p.is_empty()) {
        let proxy = reqwest::Proxy::all(proxy).map_err(|e| fail("network", format!("代理地址无效: {e}")))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| fail("network", e))
}

async fn post(builder: reqwest::RequestBuilder, body: &Value) -> Result<Vec<u8>, String> {
    // without_url: reqwest 的错误不带地址, 日志里只留原因
    let response = builder
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| fail("network", e.without_url()))?;
    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| fail("network", e.without_url()))?;
    if let Some(error) = status_error(status, &String::from_utf8_lossy(&bytes)) {
        return Err(error);
    }
    Ok(bytes.to_vec())
}

async fn synthesize_at(req: &CloudTtsRequest, base: Option<&str>) -> Result<Vec<u8>, String> {
    if req.text.trim().is_empty() {
        return Err(fail("text", "文本为空"));
    }
    if req.api_key.trim().is_empty() {
        return Err(fail("missing_key", ""));
    }
    let http = client(req.proxy.as_deref())?;
    match req.provider.as_str() {
        "minimax" => {
            let host = base.unwrap_or(if req.region.as_deref() == Some("global") { MINIMAX_GLOBAL } else { MINIMAX_CN });
            let builder = http
                .post(format!("{host}{MINIMAX_PATH}"))
                .bearer_auth(req.api_key.trim());
            minimax_audio(&post(builder, &minimax_body(req)).await?)
        }
        "doubao" => {
            let host = base.unwrap_or(DOUBAO);
            let mut builder = http
                .post(format!("{host}{DOUBAO_PATH}"))
                .header("X-Api-Resource-Id", req.resource_id.as_deref().unwrap_or("seed-tts-2.0"));
            // 新版控制台只有 API Key; 旧版控制台是 App ID + Access Token
            builder = match req.app_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
                Some(app_id) => builder
                    .header("X-Api-App-Id", app_id)
                    .header("X-Api-Access-Key", req.api_key.trim()),
                None => builder.header("X-Api-Key", req.api_key.trim()),
            };
            doubao_audio(&post(builder, &doubao_body(req)).await?)
        }
        other => Err(fail("bad_response", format!("未知服务商 {other}"))),
    }
}

/// 合成一段文本, 返回 mp3 字节流
#[tauri::command]
pub async fn cloud_tts_synthesize(request: CloudTtsRequest) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(synthesize_at(&request, None).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn request(provider: &str) -> CloudTtsRequest {
        CloudTtsRequest {
            provider: provider.into(),
            api_key: "secret-key".into(),
            voice: "voice-a".into(),
            text: "夜色像一块墨布。".into(),
            rate: 1.5,
            model: Some("speech-2.8-hd".into()),
            region: None,
            app_id: None,
            resource_id: Some("seed-tts-2.0".into()),
            proxy: None,
        }
    }

    /// 回环服务: 收一个请求, 回固定响应, 把收到的原始请求交给断言
    async fn serve_once(status: &'static str, body: String) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut data = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                data.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&data);
                if let Some(at) = text.find("\r\n\r\n") {
                    let length = text[..at]
                        .lines()
                        .find_map(|l| l.to_lowercase().strip_prefix("content-length: ").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if data.len() >= at + 4 + length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&data).into_owned()
        });
        (base, handle)
    }

    #[test]
    fn hex_rejects_bad_input() {
        assert_eq!(hex_decode("ff00"), Some(vec![0xff, 0]));
        assert_eq!(hex_decode("f"), None);
        assert_eq!(hex_decode("zz"), None);
    }

    #[test]
    fn doubao_rate_matches_documented_scale() {
        assert_eq!(doubao_speech_rate(0.5), -50);
        assert_eq!(doubao_speech_rate(1.0), 0);
        assert_eq!(doubao_speech_rate(2.0), 100);
        assert_eq!(doubao_speech_rate(3.0), 100);
    }

    #[test]
    fn minimax_maps_status_codes() {
        let body = |code: i32| format!(r#"{{"data":null,"base_resp":{{"status_code":{code},"status_msg":"m"}}}}"#);
        assert!(minimax_audio(body(1004).as_bytes()).unwrap_err().starts_with("cloud_tts:auth:"));
        assert!(minimax_audio(body(1002).as_bytes()).unwrap_err().starts_with("cloud_tts:rate:"));
        assert!(minimax_audio(body(1008).as_bytes()).unwrap_err().starts_with("cloud_tts:quota:"));
        assert!(minimax_audio(body(2013).as_bytes()).unwrap_err().starts_with("cloud_tts:voice:"));
    }

    #[test]
    fn doubao_joins_chunks_and_requires_end_marker() {
        let joined = concat!(
            r#"{"code":0,"message":"","data":"AQI="}"#, "\n",
            r#"{"code":0,"message":"","data":null,"sentence":{"text":"x"}}"#, "\n",
            r#"{"code":0,"message":"","data":"Aw=="}"#, "\n",
            r#"{"code":20000000,"message":"OK","data":null}"#,
        );
        assert_eq!(doubao_audio(joined.as_bytes()).unwrap(), vec![1, 2, 3]);
        let cut = r#"{"code":0,"message":"","data":"AQI="}"#;
        assert!(doubao_audio(cut.as_bytes()).unwrap_err().starts_with("cloud_tts:network:"));
        let denied = r#"{"code":45000000,"message":"speaker permission denied"}"#;
        assert!(doubao_audio(denied.as_bytes()).unwrap_err().starts_with("cloud_tts:voice:"));
        let quota = r#"{"code":45000292,"message":"quota exceeded"}"#;
        assert!(doubao_audio(quota.as_bytes()).unwrap_err().starts_with("cloud_tts:quota:"));
    }

    #[tokio::test]
    async fn minimax_request_on_the_wire() {
        let body = r#"{"data":{"audio":"fffb"},"base_resp":{"status_code":0,"status_msg":"success"}}"#;
        let (base, seen) = serve_once("200 OK", body.into()).await;
        let audio = synthesize_at(&request("minimax"), Some(&base)).await.unwrap();
        assert_eq!(audio, vec![0xff, 0xfb]);
        let raw = seen.await.unwrap();
        assert!(raw.starts_with("POST /v1/t2a_v2 "));
        assert!(raw.to_lowercase().contains("authorization: bearer secret-key"));
        let json: Value = serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(json["model"], "speech-2.8-hd");
        assert_eq!(json["voice_setting"]["voice_id"], "voice-a");
        assert_eq!(json["voice_setting"]["speed"], 1.5);
        assert_eq!(json["stream"], false);
    }

    #[tokio::test]
    async fn doubao_uses_api_key_or_legacy_headers() {
        let ok = r#"{"code":0,"data":"AQ=="}{"code":20000000,"message":"OK"}"#;
        let (base, seen) = serve_once("200 OK", ok.into()).await;
        synthesize_at(&request("doubao"), Some(&base)).await.unwrap();
        let raw = seen.await.unwrap().to_lowercase();
        assert!(raw.starts_with("post /api/v3/tts/unidirectional "));
        assert!(raw.contains("x-api-key: secret-key"));
        assert!(raw.contains("x-api-resource-id: seed-tts-2.0"));
        assert!(!raw.contains("x-api-app-id"));

        let mut legacy = request("doubao");
        legacy.app_id = Some("12345".into());
        let (base, seen) = serve_once("200 OK", ok.into()).await;
        synthesize_at(&legacy, Some(&base)).await.unwrap();
        let raw = seen.await.unwrap().to_lowercase();
        assert!(raw.contains("x-api-app-id: 12345"));
        assert!(raw.contains("x-api-access-key: secret-key"));
        assert!(!raw.contains("x-api-key:"));
    }

    #[tokio::test]
    async fn errors_never_contain_the_key() {
        let (base, seen) = serve_once("401 Unauthorized", "invalid".into()).await;
        let error = synthesize_at(&request("minimax"), Some(&base)).await.unwrap_err();
        seen.await.unwrap();
        assert!(error.starts_with("cloud_tts:auth:"));
        assert!(!error.contains("secret-key"));
    }

    #[tokio::test]
    async fn missing_key_fails_before_any_request() {
        let mut req = request("doubao");
        req.api_key = "  ".into();
        let error = synthesize_at(&req, Some("http://127.0.0.1:9")).await.unwrap_err();
        assert!(error.starts_with("cloud_tts:missing_key:"));
    }
}
