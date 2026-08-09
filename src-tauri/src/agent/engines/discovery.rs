use super::EngineStatus;
use super::engine_command;
use crate::agent::protocol::EngineKind;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn bounded_output(mut command: Command, label: &str) -> Result<Output, String> {
  command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
  let mut child = command.spawn().map_err(|error| format!("{label}: {error}"))?;
  let deadline = Instant::now() + Duration::from_secs(5);
  loop {
    if child.try_wait().map_err(|error| format!("{label}: {error}"))?.is_some() {
      return child.wait_with_output().map_err(|error| format!("{label}: {error}"));
    }
    if Instant::now() >= deadline {
      let _ = child.kill();
      let _ = child.wait();
      return Err(format!("{label} timed out"));
    }
    thread::sleep(Duration::from_millis(25));
  }
}

fn executable_names(engine: EngineKind) -> Vec<String> {
  let base = match engine {
    EngineKind::Codex => "codex",
    EngineKind::Claude => "claude",
    EngineKind::Pi => "pi",
  };
  if cfg!(windows) {
    vec![format!("{base}.exe"), format!("{base}.cmd"), base.into()]
  } else {
    vec![base.into()]
  }
}

fn candidates(engine: EngineKind) -> Vec<PathBuf> {
  let names = executable_names(engine);
  let mut candidates = Vec::new();
  if let Ok(path) = std::env::var("PATH") {
    for dir in std::env::split_paths(&path) {
      candidates.extend(names.iter().map(|name| dir.join(name)));
    }
  }
  let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok().map(PathBuf::from);
  if let Some(home) = home {
    for name in &names {
      candidates.extend([
        home.join(".local/bin").join(name),
        home.join(".volta/bin").join(name),
        home.join(".bun/bin").join(name),
        home.join("Library/pnpm").join(name),
        home.join("AppData/Roaming/npm").join(name),
      ]);
    }
    let nvm = home.join(".nvm/versions/node");
    if let Ok(versions) = std::fs::read_dir(nvm) {
      for version in versions.flatten() {
        candidates.extend(names.iter().map(|name| version.path().join("bin").join(name)));
      }
    }
  }
  for name in names {
    candidates.extend([
      PathBuf::from("/opt/homebrew/bin").join(&name),
      PathBuf::from("/usr/local/bin").join(&name),
      PathBuf::from("/usr/bin").join(&name),
    ]);
  }
  candidates
}

fn canonical_executable(path: &Path) -> Result<PathBuf, String> {
  let canonical = path.canonicalize().map_err(|error| format!("resolve executable: {error}"))?;
  if !canonical.is_file() {
    return Err("selected executable is not a regular file".into());
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::metadata(&canonical).map_err(|error| format!("inspect executable: {error}"))?.permissions().mode() & 0o111 == 0 {
      return Err("selected file is not executable".into());
    }
  }
  Ok(canonical)
}

fn version_output(path: &Path) -> Result<String, String> {
  let mut command = engine_command(path);
  command.arg("--version");
  let output = bounded_output(command, "probe executable version")?;
  let combined = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
  if !output.status.success() || combined.trim().is_empty() {
    return Err("executable did not report a version".into());
  }
  Ok(combined.trim().to_string())
}

fn version_tuple(version: &str) -> Option<(u32, u32, u32)> {
  version.split_whitespace().find_map(|part| {
    let candidate = part.trim_matches(|character: char| !character.is_ascii_digit() && character != '.');
    let mut pieces = candidate.split('.');
    let major = pieces.next()?.parse().ok()?;
    let minor = pieces.next()?.parse().ok()?;
    let patch = pieces.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
  })
}

fn version_matches(engine: EngineKind, version: &str) -> bool {
  let lowercase = version.to_ascii_lowercase();
  let Some(parsed) = version_tuple(version) else {
    return false;
  };
  match engine {
    EngineKind::Codex => (lowercase.starts_with("codex-cli ") || lowercase.starts_with("codex "))
      && parsed >= (0, 147, 0),
    EngineKind::Claude => (lowercase.contains("claude") || version.chars().next().is_some_and(|value| value.is_ascii_digit()))
      && parsed >= (2, 1, 0),
    EngineKind::Pi => parsed >= (0, 78, 0),
  }
}

fn codex_authenticated(path: &Path) -> (bool, String) {
  let mut command = engine_command(path);
  command.args(["login", "status"]);
  match bounded_output(command, "probe Codex authentication") {
    Ok(output) if output.status.success() => (true, String::from_utf8_lossy(&output.stdout).trim().to_string()),
    Ok(output) => (false, String::from_utf8_lossy(&output.stderr).trim().to_string()),
    Err(error) => (false, error.to_string()),
  }
}

fn claude_authenticated(path: &Path) -> (bool, String) {
  let mut command = engine_command(path);
  command.args(["auth", "status", "--json"]);
  let Ok(output) = bounded_output(command, "probe Claude authentication") else {
    return (false, "Claude authentication status is unavailable".into());
  };
  let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) else {
    return (false, "Claude returned malformed authentication status".into());
  };
  if value.get("loggedIn").and_then(Value::as_bool) != Some(true) {
    return (false, "Claude is not logged in".into());
  }
  let method = value.get("authMethod").and_then(Value::as_str).unwrap_or_default();
  let provider = value.get("apiProvider").and_then(Value::as_str).unwrap_or_default();
  let subscription = value.get("subscriptionType").and_then(Value::as_str).unwrap_or_default();
  if method.eq_ignore_ascii_case("claude.ai") || !subscription.is_empty() {
    return (false, "Personal Claude subscription OAuth is unsupported for this third-party integration; use an API key or supported cloud provider".into());
  }
  let supported = method.to_ascii_lowercase().contains("api")
    || ["bedrock", "vertex", "foundry"].iter().any(|value| provider.to_ascii_lowercase().contains(value));
  if supported {
    (true, format!("{method} {provider}").trim().into())
  } else {
    (false, "Claude authentication mode is not a supported API-key or cloud-provider mode".into())
  }
}

pub fn discover_engine(engine: EngineKind, selected_path: Option<String>) -> EngineStatus {
  let candidate = selected_path.map(PathBuf::from)
    .or_else(|| candidates(engine).into_iter().find(|path| path.is_file()));
  let Some(candidate) = candidate else {
    return EngineStatus::missing(engine, "Executable not found");
  };
  let path = match canonical_executable(&candidate) {
    Ok(path) => path,
    Err(error) => return EngineStatus::missing(engine, &error),
  };
  let version = match version_output(&path) {
    Ok(version) => version,
    Err(error) => return EngineStatus::incompatible(engine, &path, "", &error),
  };
  if !version_matches(engine, &version) {
    return EngineStatus::incompatible(engine, &path, &version, "The selected executable does not match the selected engine or tested protocol version");
  }
  let (authenticated, reason) = match engine {
    EngineKind::Codex => codex_authenticated(&path),
    EngineKind::Claude => claude_authenticated(&path),
    EngineKind::Pi => (true, "Authentication is managed by Pi's configured provider".into()),
  };
  EngineStatus {
    engine,
    found: true,
    compatible: true,
    authenticated,
    path: path.to_string_lossy().into_owned(),
    version,
    reason,
    approval_posture: "Uses the engine's installed approval, sandbox, tool, extension, model, and network configuration".into(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};

  #[cfg(unix)]
  #[test]
  fn rejects_a_manual_path_that_reports_the_wrong_engine() {
    use std::os::unix::fs::PermissionsExt;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("lightread-fake-engine-{nonce}"));
    std::fs::write(&path, "#!/bin/sh\necho 'not-codex 1.0'\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let status = discover_engine(EngineKind::Codex, Some(path.to_string_lossy().into_owned()));
    assert!(!status.compatible);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn gates_each_native_protocol_at_its_tested_version_floor() {
    assert!(!version_matches(EngineKind::Codex, "codex-cli 0.146.0"));
    assert!(version_matches(EngineKind::Codex, "codex-cli 0.147.0"));
    assert!(!version_matches(EngineKind::Claude, "2.0.99 (Claude Code)"));
    assert!(version_matches(EngineKind::Claude, "2.1.226 (Claude Code)"));
    assert!(!version_matches(EngineKind::Pi, "0.77.9"));
    assert!(version_matches(EngineKind::Pi, "0.78.1"));
  }
}
