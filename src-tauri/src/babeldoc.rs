//! BabelDOC 集成: 论文整本版式保持翻译。
//! 优先用 BabelDOC Python API runner (结构化 JSON 进度: 阶段名 + 百分比);
//! 解析不到 python 时回退 CLI (进度不精确但功能可用)。
//! 引擎为可选外部程序 (uv tool install babeldoc), 不捆入安装包。
//! API key 通过临时配置文件传递, 不出现在进程参数列表。

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const RUNNER_PY: &str = include_str!("../resources/babeldoc_runner.py");

#[derive(Default)]
pub struct BabeldocState(pub Mutex<Option<Child>>);

#[derive(Serialize, Clone)]
pub struct BabeldocInfo {
  pub found: bool,
  pub path: String,
  pub version: String,
}

#[derive(Serialize, Clone, Default)]
struct Progress {
  line: String,
  percent: Option<f32>,
  stage: Option<String>,
  current: Option<i64>,
  total: Option<i64>,
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

/// 找 babeldoc 所在虚拟环境的 python (跑 runner 用)
fn resolve_python(bin: &Path) -> Option<PathBuf> {
  // unix 脚本首行 shebang 直指环境 python
  if !cfg!(windows) {
    if let Ok(bytes) = std::fs::read(bin) {
      let head = String::from_utf8_lossy(&bytes[..bytes.len().min(300)]).to_string();
      if let Some(first) = head.lines().next() {
        if let Some(rest) = first.strip_prefix("#!") {
          let p = PathBuf::from(rest.trim());
          if p.is_file() {
            return Some(p);
          }
        }
      }
    }
  }
  // 常见安装位置 (uv tool / pipx)
  let mut candidates: Vec<PathBuf> = Vec::new();
  if let Ok(home) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
    let home = PathBuf::from(home);
    if cfg!(windows) {
      if let Ok(lad) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(lad).join("uv/tools/babeldoc/Scripts/python.exe"));
      }
      candidates.push(home.join("pipx/venvs/babeldoc/Scripts/python.exe"));
    } else {
      candidates.push(home.join(".local/share/uv/tools/babeldoc/bin/python"));
      candidates.push(home.join(".local/pipx/venvs/babeldoc/bin/python"));
    }
  }
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

/// 去掉 rich 输出里的 ANSI 转义序列
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

/// 从进度行提取最后一个百分比数字 (CLI 回退模式用)
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

/// stdout 行 → 进度事件。runner 的 JSON 行优先, 非 JSON 走原始行解析。
/// 返回 done 事件的产物路径 / error 事件的消息。
fn handle_line(app: &AppHandle, raw: &str, outputs: &mut Vec<String>, error: &mut Option<String>) {
  let line = strip_ansi(raw).trim().to_string();
  if line.is_empty() {
    return;
  }
  if line.starts_with('{') {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
      match v.get("event").and_then(|e| e.as_str()) {
        Some("stage") => {
          let stage = v.get("stage").and_then(|s| s.as_str()).unwrap_or("").to_string();
          let percent = v.get("percent").and_then(|p| p.as_f64()).map(|p| p as f32);
          let current = v.get("current").and_then(|c| c.as_i64());
          let total = v.get("total").and_then(|t| t.as_i64());
          let _ = app.emit(
            "babeldoc:progress",
            Progress { line: stage.clone(), percent, stage: Some(stage), current, total },
          );
          return;
        }
        Some("done") => {
          if let Some(arr) = v.get("outputs").and_then(|o| o.as_array()) {
            outputs.extend(arr.iter().filter_map(|p| p.as_str().map(String::from)));
          }
          return;
        }
        Some("error") => {
          *error = Some(
            v.get("message").and_then(|m| m.as_str()).unwrap_or("unknown").to_string(),
          );
          return;
        }
        _ => {}
      }
    }
  }
  let percent = parse_percent(&line);
  let _ = app.emit(
    "babeldoc:progress",
    Progress { line: line.chars().take(200).collect(), percent, ..Default::default() },
  );
}

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
  let pages_arg = pages.as_deref().map(str::trim).filter(|p| !p.is_empty());

  let python = resolve_python(&bin);
  let mut cmd;
  let cfg_path;
  if let Some(py) = &python {
    // runner 模式: 结构化 JSON 进度
    let runner_path = out_dir.join("runner.py");
    std::fs::write(&runner_path, RUNNER_PY).map_err(|e| e.to_string())?;
    cfg_path = out_dir.join("config.json");
    let cfg = serde_json::json!({
      "input": src.to_string_lossy(),
      "output": out_dir.to_string_lossy(),
      "model": model,
      "base_url": base_url,
      "api_key": api_key,
      "pages": pages_arg,
    });
    std::fs::write(&cfg_path, cfg.to_string()).map_err(|e| e.to_string())?;
    cmd = Command::new(py);
    cmd.arg(&runner_path).arg(&cfg_path);
  } else {
    // CLI 回退: 进度不精确但功能可用; key 走 TOML 不进参数
    cfg_path = out_dir.join("config.toml");
    let escaped_key = api_key.replace('\\', "\\\\").replace('"', "\\\"");
    std::fs::write(&cfg_path, format!("[babeldoc]\nopenai-api-key = \"{escaped_key}\"\n"))
      .map_err(|e| e.to_string())?;
    cmd = Command::new(&bin);
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
      .arg("1");
    if let Some(p) = pages_arg {
      cmd.arg("--pages").arg(p);
    }
  }
  cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

  let mut child = cmd.spawn().map_err(|e| format!("启动翻译引擎失败: {e}"))?;
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  *state.0.lock().unwrap() = Some(child);

  // 点击后立即反馈, 引擎冷启动期间不"装死"
  let _ = app.emit(
    "babeldoc:progress",
    Progress { line: "engine starting".into(), ..Default::default() },
  );

  // stderr: 后台线程收集尾部日志 (失败时展示), 不打扰结构化进度
  let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
  let tail2 = tail.clone();
  let err_thread = stderr.map(|err| {
    std::thread::spawn(move || {
      let mut buf: Vec<u8> = Vec::new();
      for b in BufReader::new(err).bytes().map_while(Result::ok) {
        if b == b'\n' || b == b'\r' {
          if !buf.is_empty() {
            let line = strip_ansi(&String::from_utf8_lossy(&buf)).trim().to_string();
            buf.clear();
            if !line.is_empty() {
              let mut t = tail2.lock().unwrap();
              t.push_back(line);
              if t.len() > 40 {
                t.pop_front();
              }
            }
          }
        } else {
          buf.push(b);
        }
      }
    })
  });

  // stdout: 主线程按 \r/\n 双分隔读 (rich 用 \r 原位刷新)
  let mut outputs: Vec<String> = Vec::new();
  let mut runner_error: Option<String> = None;
  if let Some(out) = stdout {
    let mut buf: Vec<u8> = Vec::new();
    let mut last = String::new();
    for b in BufReader::new(out).bytes().map_while(Result::ok) {
      if b == b'\n' || b == b'\r' {
        if !buf.is_empty() {
          let line = String::from_utf8_lossy(&buf).to_string();
          buf.clear();
          if line != last {
            last = line.clone();
            handle_line(&app, &line, &mut outputs, &mut runner_error);
          }
        }
      } else {
        buf.push(b);
      }
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

  let stderr_tail = || {
    let t = tail.lock().unwrap();
    t.iter().rev().take(6).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
  };

  match status {
    Some(Ok(s)) if s.success() => {
      if outputs.is_empty() {
        // CLI 回退模式没有 done 事件, 扫描输出目录
        let mut found: Vec<String> = std::fs::read_dir(&out_dir)
          .map_err(|e| e.to_string())?
          .filter_map(|e| e.ok())
          .map(|e| e.path())
          .filter(|p| p.extension().map(|x| x == "pdf").unwrap_or(false))
          .map(|p| p.to_string_lossy().into_owned())
          .collect();
        found.sort();
        outputs = found;
      }
      if outputs.is_empty() {
        Err(format!("翻译完成但未找到输出 PDF\n{}", stderr_tail()))
      } else {
        Ok(outputs)
      }
    }
    Some(Ok(s)) => Err(
      runner_error.unwrap_or_else(|| format!("引擎退出码 {}\n{}", s.code().unwrap_or(-1), stderr_tail())),
    ),
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
