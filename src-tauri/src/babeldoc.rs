//! BabelDOC 集成: 调用本机 babeldoc CLI 做版式保持的论文整本翻译。
//! 引擎为可选外部程序 (uv tool install babeldoc), 不捆入安装包。
//! API key 通过临时 TOML 配置传递, 不出现在进程参数列表。

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct BabeldocState(pub Mutex<Option<Child>>);

#[derive(Serialize, Clone)]
pub struct BabeldocInfo {
  pub found: bool,
  pub path: String,
  pub version: String,
}

#[derive(Serialize, Clone)]
struct Progress {
  line: String,
  percent: Option<f32>,
}

/// GUI 进程不继承 shell PATH, 需补查常见安装位置
fn find_binary() -> Option<PathBuf> {
  let name = if cfg!(windows) { "babeldoc.exe" } else { "babeldoc" };
  if let Ok(path_var) = std::env::var("PATH") {
    for dir in std::env::split_paths(&path_var) {
      let c = dir.join(name);
      if c.is_file() {
        return Some(c);
      }
    }
  }
  let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok()?;
  let home = PathBuf::from(home);
  let candidates = [
    home.join(".local/bin").join(name),
    PathBuf::from("/opt/homebrew/bin").join(name),
    PathBuf::from("/usr/local/bin").join(name),
  ];
  candidates.into_iter().find(|c| c.is_file())
}

#[tauri::command]
pub fn babeldoc_status() -> BabeldocInfo {
  match find_binary() {
    Some(path) => {
      let version = Command::new(&path)
        .arg("--version")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
      BabeldocInfo { found: true, path: path.to_string_lossy().into_owned(), version }
    }
    None => BabeldocInfo { found: false, path: String::new(), version: String::new() },
  }
}

/// 去掉 rich 进度条输出里的 ANSI 转义序列
fn strip_ansi(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut chars = s.chars().peekable();
  while let Some(c) = chars.next() {
    if c == '\u{1b}' {
      if chars.peek() == Some(&'[') {
        chars.next();
        for e in chars.by_ref() {
          if e.is_ascii_alphabetic() {
            break;
          }
        }
      }
      continue;
    }
    out.push(c);
  }
  out
}

/// 从进度行提取最后一个百分比数字
fn parse_percent(line: &str) -> Option<f32> {
  let bytes = line.as_bytes();
  let mut best = None;
  for (i, b) in bytes.iter().enumerate() {
    if *b == b'%' {
      let mut start = i;
      while start > 0 && (bytes[start - 1].is_ascii_digit() || bytes[start - 1] == b'.') {
        start -= 1;
      }
      if start < i {
        if let Ok(v) = line[start..i].parse::<f32>() {
          if (0.0..=100.0).contains(&v) {
            best = Some(v);
          }
        }
      }
    }
  }
  best
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn babeldoc_translate(
  app: AppHandle,
  state: State<'_, BabeldocState>,
  file_path: String,
  base_url: String,
  api_key: String,
  model: String,
  pages: Option<String>,
) -> Result<Vec<String>, String> {
  let bin = find_binary().ok_or("babeldoc not found")?;
  let src = PathBuf::from(&file_path);
  if !src.is_file() {
    return Err(format!("源文件不存在: {file_path}"));
  }

  let out_dir = std::env::temp_dir().join(format!(
    "lightread-babeldoc-{}",
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis())
      .unwrap_or(0)
  ));
  std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

  // API key 走 TOML 配置文件, 避免出现在进程参数
  let cfg_path = out_dir.join("config.toml");
  let escaped_key = api_key.replace('\\', "\\\\").replace('"', "\\\"");
  std::fs::write(&cfg_path, format!("[babeldoc]\nopenai-api-key = \"{escaped_key}\"\n"))
    .map_err(|e| e.to_string())?;

  let mut cmd = Command::new(&bin);
  cmd
    .arg("--files")
    .arg(&src)
    .arg("-c")
    .arg(&cfg_path)
    .arg("--openai")
    .arg("--openai-model")
    .arg(&model)
    .arg("--openai-base-url")
    .arg(&base_url)
    .arg("--lang-in")
    .arg("en")
    .arg("--lang-out")
    .arg("zh")
    .arg("--output")
    .arg(&out_dir)
    .arg("--watermark-output-mode")
    .arg("no_watermark")
    .arg("--report-interval")
    .arg("1")
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .stdin(Stdio::null());
  if let Some(p) = pages.as_deref() {
    if !p.trim().is_empty() {
      cmd.arg("--pages").arg(p.trim());
    }
  }

  let mut child = cmd.spawn().map_err(|e| format!("启动 babeldoc 失败: {e}"))?;
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  *state.0.lock().unwrap() = Some(child);

  let emit = |app: &AppHandle, raw: &str| {
    let line = strip_ansi(raw).trim().to_string();
    if line.is_empty() {
      return;
    }
    let percent = parse_percent(&line);
    let _ = app.emit("babeldoc:progress", Progress { line: line.chars().take(200).collect(), percent });
  };

  // stderr (rich 进度) 在独立线程读, stdout 在当前线程读
  let app2 = app.clone();
  let err_thread = stderr.map(|err| {
    std::thread::spawn(move || {
      for line in BufReader::new(err).lines().map_while(Result::ok) {
        let stripped = strip_ansi(&line).trim().to_string();
        if !stripped.is_empty() {
          let percent = parse_percent(&stripped);
          let _ = app2.emit(
            "babeldoc:progress",
            Progress { line: stripped.chars().take(200).collect(), percent },
          );
        }
      }
    })
  });
  if let Some(out) = stdout {
    for line in BufReader::new(out).lines().map_while(Result::ok) {
      emit(&app, &line);
    }
  }
  if let Some(t) = err_thread {
    let _ = t.join();
  }

  let status = {
    let mut guard = state.0.lock().unwrap();
    let result = guard.as_mut().map(|c| c.wait());
    *guard = None;
    result
  };
  let _ = std::fs::remove_file(&cfg_path);

  match status {
    Some(Ok(s)) if s.success() => {
      let mut outputs: Vec<String> = std::fs::read_dir(&out_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "pdf").unwrap_or(false))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
      outputs.sort();
      if outputs.is_empty() {
        Err("翻译完成但未找到输出 PDF".into())
      } else {
        Ok(outputs)
      }
    }
    Some(Ok(s)) => Err(format!("babeldoc 退出码 {}", s.code().unwrap_or(-1))),
    Some(Err(e)) => Err(e.to_string()),
    None => Err("已取消".into()),
  }
}

#[tauri::command]
pub fn babeldoc_cancel(state: State<'_, BabeldocState>) {
  if let Some(mut child) = state.0.lock().unwrap().take() {
    let _ = child.kill();
  }
}

/// 读取 babeldoc 输出目录下的 PDF (限制路径前缀, 不做任意文件读取)
#[tauri::command]
pub fn babeldoc_read_output(path: String) -> Result<tauri::ipc::Response, String> {
  let p = PathBuf::from(&path);
  let tmp = std::env::temp_dir();
  if !p.starts_with(&tmp) || !path.contains("lightread-babeldoc-") {
    return Err("路径不在输出目录内".into());
  }
  let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
  Ok(tauri::ipc::Response::new(bytes))
}
