//! BabelDOC 集成: 论文整本版式保持翻译。
//! 优先用 BabelDOC Python API runner (结构化 JSON 进度: 阶段名 + 百分比);
//! 解析不到 python 时回退 CLI (进度不精确但功能可用)。
//! 引擎为可选外部程序 (uv tool install babeldoc), 不捆入安装包。
//! API key 通过临时配置文件传递, 不出现在进程参数列表。

use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const RUNNER_PY: &str = include_str!("../resources/babeldoc_runner.py");
const MAX_BACKGROUND_PROMPT_CHARS: usize = 20_000;
const SUPPORTED_TARGET_LANGUAGES: &[&str] =
  &["zh", "zh-TW", "ja", "ko", "fr", "de", "es", "pt", "it", "ru"];

enum BabeldocProcess {
  Idle,
  Starting,
  Running(Child),
  Cancelling,
  Finishing,
}

impl Default for BabeldocProcess {
  fn default() -> Self {
    Self::Idle
  }
}

#[derive(Default)]
pub struct BabeldocState(Arc<Mutex<BabeldocProcess>>);

struct TranslationRequest {
  file_path: String,
  base_url: String,
  api_key: String,
  model: String,
  target_language: String,
  pages: Option<String>,
  background_prompt: Option<String>,
}

/// 在准备配置与拉起子进程前占住任务槽；早退时保证槽位复位。
struct TranslationReservation(Arc<Mutex<BabeldocProcess>>);

impl TranslationReservation {
  fn acquire(state: Arc<Mutex<BabeldocProcess>>) -> Result<Self, String> {
    {
      let mut process = state.lock().unwrap();
      if !matches!(&*process, BabeldocProcess::Idle) {
        return Err("已有重排版翻译任务正在运行".into());
      }
      *process = BabeldocProcess::Starting;
    }
    Ok(Self(state))
  }
}

impl Drop for TranslationReservation {
  fn drop(&mut self) {
    let child = {
      let mut process = self.0.lock().unwrap_or_else(|e| e.into_inner());
      match std::mem::take(&mut *process) {
        BabeldocProcess::Running(child) => Some(child),
        _ => None,
      }
    };
    if let Some(mut child) = child {
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

struct TempFile(PathBuf);

impl Drop for TempFile {
  fn drop(&mut self) {
    let _ = std::fs::remove_file(&self.0);
  }
}

struct OutputDirectory {
  path: PathBuf,
  keep: bool,
}

impl OutputDirectory {
  fn keep(&mut self) {
    self.keep = true;
  }
}

impl Drop for OutputDirectory {
  fn drop(&mut self) {
    if !self.keep {
      let _ = std::fs::remove_dir_all(&self.path);
    }
  }
}

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

fn validate_background_prompt(prompt: Option<String>) -> Result<Option<String>, String> {
  let Some(prompt) = prompt else {
    return Ok(None);
  };
  let trimmed = prompt.trim();
  if trimmed.is_empty() {
    return Ok(None);
  }
  if trimmed.chars().count() > MAX_BACKGROUND_PROMPT_CHARS {
    return Err(format!("论文翻译背景过长，最多 {MAX_BACKGROUND_PROMPT_CHARS} 个字符"));
  }
  Ok(Some(trimmed.to_string()))
}

fn validate_target_language(language: String) -> Result<String, String> {
  let language = language.trim();
  if SUPPORTED_TARGET_LANGUAGES.contains(&language) {
    return Ok(language.to_string());
  }
  Err("不支持的目标语言".into())
}

fn build_python_runner_config(
  request: &TranslationRequest,
  src: &Path,
  out_dir: &Path,
  pages: Option<&str>,
) -> serde_json::Value {
  serde_json::json!({
    "input": src.to_string_lossy(),
    "output": out_dir.to_string_lossy(),
    "model": request.model,
    "base_url": request.base_url,
    "api_key": request.api_key,
    "lang_out": request.target_language,
    "pages": pages,
    "custom_system_prompt": request.background_prompt,
  })
}

fn build_cli_arguments(
  request: &TranslationRequest,
  src: &Path,
  cfg_path: &Path,
  out_dir: &Path,
  pages: Option<&str>,
) -> Vec<OsString> {
  let mut args = vec![
    "--files".into(),
    src.as_os_str().into(),
    "-c".into(),
    cfg_path.as_os_str().into(),
    "--openai".into(),
    "--openai-model".into(),
    request.model.as_str().into(),
    "--openai-base-url".into(),
    request.base_url.as_str().into(),
    "--lang-in".into(),
    "en".into(),
    "--lang-out".into(),
    request.target_language.as_str().into(),
    "--output".into(),
    out_dir.as_os_str().into(),
    "--watermark-output-mode".into(),
    "no_watermark".into(),
    "--report-interval".into(),
    "1".into(),
  ];
  if let Some(pages) = pages {
    args.push("--pages".into());
    args.push(pages.into());
  }
  if let Some(prompt) = request.background_prompt.as_deref() {
    args.push("--custom-system-prompt".into());
    args.push(prompt.into());
  }
  args
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

fn run_translation(
  app: AppHandle,
  state: Arc<Mutex<BabeldocProcess>>,
  request: TranslationRequest,
  _reservation: TranslationReservation,
) -> Result<Vec<String>, String> {
  {
    let process = state.lock().unwrap();
    if matches!(&*process, BabeldocProcess::Cancelling) {
      return Err("已取消".into());
    }
  }

  let bin = find_binary().ok_or("babeldoc not found")?;
  let src = PathBuf::from(&request.file_path);
  if !src.is_file() {
    return Err(format!("源文件不存在: {}", request.file_path));
  }

  let out_dir = std::env::temp_dir().join(format!(
    "lightread-babeldoc-{}",
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis())
      .unwrap_or(0)
  ));
  std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
  let mut output_cleanup = OutputDirectory { path: out_dir.clone(), keep: false };
  let pages_arg = request.pages.as_deref().map(str::trim).filter(|p| !p.is_empty());

  let python = resolve_python(&bin);
  let mut cmd;
  let cfg_path = out_dir.join(if python.is_some() { "config.json" } else { "config.toml" });
  let _config_cleanup = TempFile(cfg_path.clone());
  if let Some(py) = &python {
    // runner 模式: 结构化 JSON 进度
    let runner_path = out_dir.join("runner.py");
    std::fs::write(&runner_path, RUNNER_PY).map_err(|e| e.to_string())?;
    let cfg = build_python_runner_config(&request, &src, &out_dir, pages_arg);
    std::fs::write(&cfg_path, cfg.to_string()).map_err(|e| e.to_string())?;
    cmd = Command::new(py);
    cmd.arg(&runner_path).arg(&cfg_path);
  } else {
    // CLI 回退: 进度不精确但功能可用; key 走 TOML 不进参数
    let escaped_key = request.api_key.replace('\\', "\\\\").replace('"', "\\\"");
    std::fs::write(&cfg_path, format!("[babeldoc]\nopenai-api-key = \"{escaped_key}\"\n"))
      .map_err(|e| e.to_string())?;
    cmd = Command::new(&bin);
    cmd.args(build_cli_arguments(&request, &src, &cfg_path, &out_dir, pages_arg));
  }
  cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());

  let mut child = cmd.spawn().map_err(|e| format!("启动翻译引擎失败: {e}"))?;
  let stdout = child.stdout.take();
  let stderr = child.stderr.take();
  {
    let mut process = state.lock().unwrap();
    if matches!(&*process, BabeldocProcess::Starting) {
      *process = BabeldocProcess::Running(child);
    } else {
      let _ = child.kill();
      let _ = child.wait();
      return Err("已取消".into());
    }
  }

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

  let child = {
    let mut process = state.lock().unwrap();
    match std::mem::take(&mut *process) {
      BabeldocProcess::Running(child) => {
        *process = BabeldocProcess::Finishing;
        Some(child)
      }
      BabeldocProcess::Cancelling => {
        *process = BabeldocProcess::Finishing;
        None
      }
      other => {
        *process = other;
        None
      }
    }
  };
  let status = child.map(|mut child| child.wait());
  let stderr_tail = || {
    let t = tail.lock().unwrap();
    t.iter().rev().take(6).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
  };

  let result = match status {
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
  };
  if result.is_ok() {
    output_cleanup.keep();
  }
  result
}

/// 翻译会持续数分钟并包含阻塞式子进程 I/O，必须离开 Tauri 命令事件循环执行。
#[tauri::command]
pub async fn babeldoc_translate(
  app: AppHandle,
  state: State<'_, BabeldocState>,
  file_path: String,
  base_url: String,
  api_key: String,
  model: String,
  target_language: String,
  pages: Option<String>,
  background_prompt: Option<String>,
) -> Result<Vec<String>, String> {
  let state = Arc::clone(&state.0);
  let reservation = TranslationReservation::acquire(state.clone())?;
  let background_prompt = validate_background_prompt(background_prompt)?;
  let target_language = validate_target_language(target_language)?;
  let request = TranslationRequest {
    file_path,
    base_url,
    api_key,
    model,
    target_language,
    pages,
    background_prompt,
  };
  tauri::async_runtime::spawn_blocking(move || {
    run_translation(app, state, request, reservation)
  })
  .await
  .map_err(|e| format!("翻译后台任务异常: {e}"))?
}

#[tauri::command]
pub fn babeldoc_cancel(state: State<'_, BabeldocState>) {
  let child = {
    let mut process = state.0.lock().unwrap();
    match std::mem::take(&mut *process) {
      BabeldocProcess::Starting => {
        *process = BabeldocProcess::Cancelling;
        None
      }
      BabeldocProcess::Running(child) => {
        *process = BabeldocProcess::Cancelling;
        Some(child)
      }
      BabeldocProcess::Cancelling => {
        *process = BabeldocProcess::Cancelling;
        None
      }
      BabeldocProcess::Finishing => {
        *process = BabeldocProcess::Finishing;
        None
      }
      BabeldocProcess::Idle => None,
    }
  };
  if let Some(mut child) = child {
    let _ = child.kill();
    let _ = child.wait();
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

#[cfg(test)]
mod tests {
  use super::*;
  use std::ffi::OsStr;

  fn translation_request(background_prompt: Option<&str>) -> TranslationRequest {
    TranslationRequest {
      file_path: "/tmp/input.pdf".into(),
      base_url: "https://example.invalid/v1".into(),
      api_key: String::new(),
      model: "test-model".into(),
      target_language: "ja".into(),
      pages: None,
      background_prompt: background_prompt.map(str::to_string),
    }
  }

  #[test]
  fn reservation_blocks_another_translation_until_drop() {
    let state = Arc::new(Mutex::new(BabeldocProcess::Idle));
    let reservation = TranslationReservation::acquire(state.clone()).unwrap();

    assert!(TranslationReservation::acquire(state.clone()).is_err());
    drop(reservation);
    assert!(matches!(&*state.lock().unwrap(), BabeldocProcess::Idle));
  }

  #[test]
  fn cancelled_queued_translation_releases_slot_on_drop() {
    let state = Arc::new(Mutex::new(BabeldocProcess::Idle));
    let reservation = TranslationReservation::acquire(state.clone()).unwrap();
    *state.lock().unwrap() = BabeldocProcess::Cancelling;

    drop(reservation);
    assert!(matches!(&*state.lock().unwrap(), BabeldocProcess::Idle));
  }

  #[test]
  fn finishing_translation_holds_slot_until_cleanup_completes() {
    let state = Arc::new(Mutex::new(BabeldocProcess::Idle));
    let reservation = TranslationReservation::acquire(state.clone()).unwrap();
    *state.lock().unwrap() = BabeldocProcess::Finishing;

    assert!(TranslationReservation::acquire(state.clone()).is_err());
    drop(reservation);
    assert!(matches!(&*state.lock().unwrap(), BabeldocProcess::Idle));
  }

  #[test]
  fn empty_background_prompt_is_ignored() {
    assert_eq!(validate_background_prompt(Some("  \n ".into())).unwrap(), None);
  }

  #[test]
  fn oversized_background_prompt_is_rejected() {
    let prompt = "x".repeat(MAX_BACKGROUND_PROMPT_CHARS + 1);
    assert!(validate_background_prompt(Some(prompt)).is_err());
  }

  #[test]
  fn supported_target_language_is_accepted() {
    assert_eq!(validate_target_language(" ja ".into()).unwrap(), "ja");
  }

  #[test]
  fn unsupported_target_language_is_rejected() {
    assert!(validate_target_language("ar".into()).is_err());
  }

  #[test]
  fn python_runner_config_forwards_target_language_and_background_prompt() {
    let request = translation_request(Some("approved context"));
    let config = build_python_runner_config(
      &request,
      Path::new("/tmp/input.pdf"),
      Path::new("/tmp/output"),
      None,
    );

    assert_eq!(config.get("lang_out").and_then(serde_json::Value::as_str), Some("ja"));
    assert_eq!(
      config.get("custom_system_prompt").and_then(serde_json::Value::as_str),
      Some("approved context")
    );
  }

  #[test]
  fn python_runner_config_uses_null_when_background_prompt_is_absent() {
    let request = translation_request(None);
    let config = build_python_runner_config(
      &request,
      Path::new("/tmp/input.pdf"),
      Path::new("/tmp/output"),
      None,
    );

    assert!(config.get("custom_system_prompt").is_some_and(serde_json::Value::is_null));
  }

  #[test]
  fn cli_arguments_forward_target_language_and_background_prompt_as_opaque_values() {
    let request = translation_request(Some("approved context"));
    let args = build_cli_arguments(
      &request,
      Path::new("/tmp/input.pdf"),
      Path::new("/tmp/config.toml"),
      Path::new("/tmp/output"),
      None,
    );

    let language_flag = args.iter().position(|arg| arg == OsStr::new("--lang-out")).unwrap();
    assert_eq!(args.get(language_flag + 1).map(OsString::as_os_str), Some(OsStr::new("ja")));

    let prompt_flags: Vec<_> = args
      .iter()
      .enumerate()
      .filter(|(_, arg)| *arg == OsStr::new("--custom-system-prompt"))
      .collect();
    assert_eq!(prompt_flags.len(), 1);
    assert_eq!(
      args.get(prompt_flags[0].0 + 1).map(OsString::as_os_str),
      Some(OsStr::new("approved context"))
    );
  }

  #[test]
  fn cli_arguments_omit_background_prompt_when_absent() {
    let request = translation_request(None);
    let args = build_cli_arguments(
      &request,
      Path::new("/tmp/input.pdf"),
      Path::new("/tmp/config.toml"),
      Path::new("/tmp/output"),
      None,
    );

    assert!(!args.iter().any(|arg| arg == OsStr::new("--custom-system-prompt")));
  }
}
