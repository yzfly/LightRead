//! 大文件 (离线语音包、本机模型) 的下载: 代理 → 直连回退, 断点续传, 边下边算 SHA-256。
//! 离线语音 (local_tts) 与本机模型 (local_llm) 共用; 全平台可用。
#![cfg_attr(target_os = "ios", allow(dead_code))]

use std::io::Write as _;
use std::path::Path;

/// 代理地址规范化: 去掉空白与末尾斜杠, 没写协议的按 http:// (如 127.0.0.1:7890); 空串视为未设置。
/// socks5 / socks5h / http / https 原样保留 (reqwest 开了 socks 特性)。
pub(crate) fn normalize_proxy(raw: &str) -> Option<String> {
    let p = raw.trim().trim_end_matches('/');
    if p.is_empty() {
        return None;
    }
    let lower = p.to_ascii_lowercase();
    if ["http://", "https://", "socks5://", "socks5h://", "socks4://", "socks4a://"].iter().any(|s| lower.starts_with(s)) {
        Some(p.to_string())
    } else if lower.starts_with("socks://") {
        Some(format!("socks5://{}", &p["socks://".len()..]))
    } else {
        Some(format!("http://{p}"))
    }
}

/// 把 reqwest 的错误说成人话
fn describe_error(e: &reqwest::Error, via_proxy: bool) -> String {
    if e.is_connect() {
        if via_proxy { "连不上代理".into() } else { "连不上服务器".into() }
    } else if e.is_timeout() {
        "连接超时".into()
    } else {
        e.to_string()
    }
}

/// 一次下载走哪条路: 设置里的代理 / 系统代理 (reqwest 默认读取) / 完全直连
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Route {
    Proxy(String),
    System,
    Direct,
}

/// 下载尝试顺序: 设了代理 → 代理, 再直连; 没设 → 系统代理, 再直连 (系统代理本身坏了也能下)
pub(crate) fn download_routes(proxy: Option<String>) -> Vec<Route> {
    match proxy {
        Some(p) => vec![Route::Proxy(p), Route::Direct],
        None => vec![Route::System, Route::Direct],
    }
}

/// 已下载的半截文件: 返回其长度与对这些字节的 SHA256 状态 (续传时接着算)。
/// 比完整文件还大的是坏的, 清空重来。
fn resume_state(path: &Path, size: u64) -> Result<(u64, sha2::Sha256), String> {
    use sha2::Digest;
    use std::io::Read as _;
    let mut hasher = sha2::Sha256::new();
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if len == 0 || len > size {
        let _ = std::fs::remove_file(path);
        return Ok((0, hasher));
    }
    let mut file = std::fs::File::open(path).map_err(|e| format!("读取已下载部分失败: {e}"))?;
    let mut buf = vec![0u8; 1 << 20];
    let mut read: u64 = 0;
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取已下载部分失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        read += n as u64;
    }
    Ok((read, hasher))
}

/// 服务器的 Content-Range (`bytes 123-456/789`) 是否从 start 开始
pub(crate) fn content_range_starts_at(header: Option<&str>, start: u64) -> bool {
    header
        .and_then(|v| v.trim().strip_prefix("bytes "))
        .and_then(|v| v.split('-').next())
        .and_then(|v| v.trim().parse::<u64>().ok())
        == Some(start)
}

/// 下载到 path, 期间以 `emit(已下载, 总量, "downloading")` 推送进度; 校验大小与 SHA256。
/// 断点续传: path 已有半截文件时用 Range 请求接着下 (各来源内容相同, 可以互相接);
/// 服务器不支持 Range 就从头下。失败时保留半截文件, 下次接着下; 只有校验不通过才删掉。
pub(crate) async fn download_file(
    path: &Path,
    url: &str,
    size: u64,
    sha256: &str,
    route: &Route,
    emit: &(dyn Fn(u64, u64, &str) + Send + Sync),
) -> Result<(), String> {
    use sha2::Digest;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60));
    let via_proxy = !matches!(route, Route::Direct);
    match route {
        Route::Proxy(p) => {
            let proxy = reqwest::Proxy::all(p).map_err(|e| format!("代理地址无效（{e}）"))?;
            builder = builder.proxy(proxy);
        }
        Route::System => {}
        // 完全直连: 不读系统代理, 避免坏掉的系统代理把两次尝试都拖垮
        Route::Direct => builder = builder.no_proxy(),
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let owned = path.to_path_buf();
    let (mut downloaded, mut hasher) = tokio::task::spawn_blocking(move || resume_state(&owned, size))
        .await
        .map_err(|e| format!("任务失败: {e}"))??;
    emit(downloaded, size, "downloading");

    if downloaded < size {
        let mut req = client.get(url);
        if downloaded > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={downloaded}-"));
        }
        let mut resp = req.send().await.map_err(|e| describe_error(&e, via_proxy))?;
        let status = resp.status();
        let resumed = downloaded > 0
            && status == reqwest::StatusCode::PARTIAL_CONTENT
            && content_range_starts_at(
                resp.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()),
                downloaded,
            );
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            // 半截文件和服务器上的对不上, 丢掉, 下一次尝试从头下
            let _ = std::fs::remove_file(path);
            return Err("已下载部分与服务器不一致，已清除，请重试".into());
        }
        if !status.is_success() {
            return Err(format!("服务器返回 {status}"));
        }
        let mut file = if resumed {
            std::fs::OpenOptions::new().append(true).open(path)
        } else {
            // 服务器不支持续传 (返回整包): 从头开始
            downloaded = 0;
            hasher = sha2::Sha256::new();
            std::fs::File::create(path)
        }
        .map_err(|e| format!("写入失败: {e}"))?;
        emit(downloaded, size, "downloading");
        let mut last_emit = std::time::Instant::now();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("下载中断（{}）", describe_error(&e, via_proxy)))? {
            if downloaded + chunk.len() as u64 > size {
                drop(file);
                let _ = std::fs::remove_file(path);
                return Err("文件比预期大，已丢弃".into());
            }
            file.write_all(&chunk).map_err(|e| format!("写入失败: {e}"))?;
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;
            if last_emit.elapsed().as_millis() > 200 {
                emit(downloaded, size, "downloading");
                last_emit = std::time::Instant::now();
            }
        }
        file.flush().map_err(|e| format!("写入失败: {e}"))?;
        drop(file);
        emit(downloaded, size, "downloading");
    }
    if downloaded != size {
        return Err(format!("下载中断，已保存 {} / {} MB，重试会接着下", downloaded >> 20, size >> 20));
    }
    let digest = format!("{:x}", hasher.finalize());
    if digest != sha256 {
        let _ = std::fs::remove_file(path);
        return Err("文件校验失败，已删除，重试会重新下载".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_must_continue_from_offset() {
        assert!(content_range_starts_at(Some("bytes 100-999/1000"), 100));
        assert!(content_range_starts_at(Some(" bytes 0-9/10"), 0));
        assert!(!content_range_starts_at(Some("bytes 0-999/1000"), 100));
        assert!(!content_range_starts_at(Some("bytes */1000"), 100));
        assert!(!content_range_starts_at(None, 100));
    }

    #[test]
    fn proxy_is_normalized() {
        assert_eq!(normalize_proxy(""), None);
        assert_eq!(normalize_proxy("   "), None);
        assert_eq!(normalize_proxy("127.0.0.1:7890"), Some("http://127.0.0.1:7890".into()));
        assert_eq!(normalize_proxy(" http://127.0.0.1:7890/ "), Some("http://127.0.0.1:7890".into()));
        assert_eq!(normalize_proxy("socks5h://127.0.0.1:7891"), Some("socks5h://127.0.0.1:7891".into()));
        assert_eq!(normalize_proxy("SOCKS5://host:1080"), Some("SOCKS5://host:1080".into()));
        assert_eq!(normalize_proxy("socks://host:1080"), Some("socks5://host:1080".into()));
    }

    #[test]
    fn routes_fall_back_to_direct() {
        assert_eq!(download_routes(Some("http://p:1".into())), vec![Route::Proxy("http://p:1".into()), Route::Direct]);
        assert_eq!(download_routes(None), vec![Route::System, Route::Direct]);
    }

    #[test]
    fn partial_file_is_hashed_and_oversized_one_is_dropped() {
        use sha2::Digest;
        let dir = std::env::temp_dir().join(format!("lightread-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("part");
        std::fs::write(&path, b"abc").unwrap();
        let (len, hasher) = resume_state(&path, 10).unwrap();
        assert_eq!(len, 3);
        assert_eq!(format!("{:x}", hasher.finalize()), format!("{:x}", sha2::Sha256::digest(b"abc")));
        let (len, _) = resume_state(&path, 2).unwrap();
        assert_eq!(len, 0);
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
