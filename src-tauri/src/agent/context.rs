use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::supervisor::AgentSupervisor;

const AGENT_ROOT: &str = "paper-agents";
const CURRENT_PAPER_DIR: &str = "current-paper";
const PREVIOUS_PAPER_DIR: &str = ".previous-current-paper";
const MANIFEST_FILE: &str = ".lightread-manifest.json";
const MAX_TEXT_CHUNK_BYTES: usize = 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct ContextState(Mutex<HashMap<String, PendingSnapshot>>);

struct PendingSnapshot {
  paper_id: String,
  staging_dir: PathBuf,
  paper_dir: PathBuf,
  source_sha256: String,
  extractor_version: u32,
  needs_text: bool,
  text_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBeginResult {
  token: String,
  needs_text: bool,
  source_sha256: String,
  current_paper_path: String,
  workspace_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFinalizeResult {
  #[serde(skip)]
  paper_id: String,
  revision: String,
  source_sha256: String,
  file_hashes: BTreeMap<String, String>,
  current_paper_path: String,
  workspace_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SnapshotManifest {
  version: u32,
  extractor_version: u32,
  source_sha256: String,
  revision: String,
  file_hashes: BTreeMap<String, String>,
}

fn validate_paper_id(paper_id: &str) -> Result<(), String> {
  if paper_id.is_empty()
    || paper_id.len() > 128
    || !paper_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
  {
    return Err("invalid paper id".into());
  }
  Ok(())
}

fn validate_source_pdf(path: &Path) -> Result<PathBuf, String> {
  if !path.is_file()
    || !path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
  {
    return Err("source must be an existing PDF file".into());
  }
  let canonical = path.canonicalize().map_err(|error| format!("resolve source PDF: {error}"))?;
  let mut header = [0_u8; 5];
  File::open(&canonical)
    .and_then(|mut file| file.read_exact(&mut header))
    .map_err(|error| format!("read source PDF: {error}"))?;
  if &header != b"%PDF-" {
    return Err("source file does not have a PDF header".into());
  }
  Ok(canonical)
}

fn hash_file(path: &Path) -> Result<String, String> {
  let mut file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
  let mut hasher = Sha256::new();
  let mut buffer = [0_u8; 64 * 1024];
  loop {
    let count = file.read(&mut buffer).map_err(|error| format!("read {}: {error}", path.display()))?;
    if count == 0 {
      break;
    }
    hasher.update(&buffer[..count]);
  }
  Ok(format!("sha256:{:x}", hasher.finalize()))
}

#[cfg(test)]
fn hash_bytes(bytes: &[u8]) -> String {
  format!("sha256:{:x}", Sha256::digest(bytes))
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
  let digest = value.strip_prefix("sha256:").ok_or_else(|| format!("{label} must be a SHA-256 digest"))?;
  if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err(format!("{label} must be a SHA-256 digest"));
  }
  Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), String> {
  fs::create_dir_all(path).map_err(|error| format!("create {}: {error}", path.display()))?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
      .map_err(|error| format!("protect {}: {error}", path.display()))?;
  }
  Ok(())
}

fn set_snapshot_readonly(path: &Path) -> Result<(), String> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o444))
      .map_err(|error| format!("protect {}: {error}", path.display()))?;
  }
  #[cfg(not(unix))]
  {
    let mut permissions = fs::metadata(path)
      .map_err(|error| format!("inspect {}: {error}", path.display()))?
      .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
      .map_err(|error| format!("protect {}: {error}", path.display()))?;
  }
  Ok(())
}

fn make_file_writable(path: &Path) -> Result<(), String> {
  if !path.exists() {
    return Ok(());
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
      .map_err(|error| format!("unlock {}: {error}", path.display()))?;
  }
  #[cfg(not(unix))]
  {
    let mut permissions = fs::metadata(path)
      .map_err(|error| format!("inspect {}: {error}", path.display()))?
      .permissions();
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)
      .map_err(|error| format!("unlock {}: {error}", path.display()))?;
  }
  Ok(())
}

#[cfg(windows)]
fn unlock_managed_tree(path: &Path) -> Result<(), String> {
  if path.is_dir() {
    for entry in fs::read_dir(path).map_err(|error| format!("inspect {}: {error}", path.display()))? {
      let entry = entry.map_err(|error| format!("inspect {}: {error}", path.display()))?;
      unlock_managed_tree(&entry.path())?;
    }
  }
  let mut permissions = fs::metadata(path)
    .map_err(|error| format!("inspect {}: {error}", path.display()))?
    .permissions();
  permissions.set_readonly(false);
  fs::set_permissions(path, permissions)
    .map_err(|error| format!("unlock {}: {error}", path.display()))
}

fn remove_managed_tree(path: &Path, label: &str) -> Result<(), String> {
  if !path.exists() {
    return Ok(());
  }
  #[cfg(windows)]
  unlock_managed_tree(path)?;
  fs::remove_dir_all(path).map_err(|error| format!("{label}: {error}"))
}

fn load_manifest(current_dir: &Path) -> Option<SnapshotManifest> {
  let raw = fs::read(current_dir.join(MANIFEST_FILE)).ok()?;
  serde_json::from_slice(&raw).ok()
}

fn static_snapshot_is_valid(
  current_dir: &Path,
  source_sha256: &str,
  extractor_version: u32,
) -> bool {
  let Some(manifest) = load_manifest(current_dir) else {
    return false;
  };
  if manifest.version != 1
    || manifest.extractor_version != extractor_version
    || manifest.source_sha256 != source_sha256
  {
    return false;
  }
  ["paper.pdf", "paper.txt"].iter().all(|name| {
    let Some(expected) = manifest.file_hashes.get(*name) else {
      return false;
    };
    hash_file(&current_dir.join(name)).is_ok_and(|actual| actual == *expected)
  })
}

fn recover_snapshot(paper_dir: &Path) -> Result<(), String> {
  let current = paper_dir.join(CURRENT_PAPER_DIR);
  let previous = paper_dir.join(PREVIOUS_PAPER_DIR);
  if !current.exists() && previous.exists() {
    fs::rename(&previous, &current)
      .map_err(|error| format!("restore previous paper snapshot: {error}"))?;
  } else if current.exists() && previous.exists() {
    remove_managed_tree(&previous, "remove previous paper snapshot")?;
  }
  Ok(())
}

fn remove_abandoned_staging(paper_dir: &Path) -> Result<(), String> {
  let entries = fs::read_dir(paper_dir)
    .map_err(|error| format!("inspect paper Agent directory: {error}"))?;
  for entry in entries {
    let entry = entry.map_err(|error| format!("inspect paper Agent directory: {error}"))?;
    let name = entry.file_name();
    let Some(token) = name.to_str().and_then(|name| name.strip_prefix(".snapshot-")) else {
      continue;
    };
    if Uuid::parse_str(token).is_ok() && entry.path().is_dir() {
      remove_managed_tree(&entry.path(), "remove abandoned staged snapshot")?;
    }
  }
  Ok(())
}

fn begin_snapshot_at(
  state: &ContextState,
  app_data_dir: &Path,
  paper_id: String,
  source_pdf_path: String,
  extractor_version: u32,
) -> Result<SnapshotBeginResult, String> {
  validate_paper_id(&paper_id)?;
  let source = validate_source_pdf(Path::new(&source_pdf_path))?;
  let source_sha256 = hash_file(&source)?;
  let agent_root = app_data_dir.join(AGENT_ROOT);
  let paper_dir = agent_root.join(&paper_id);
  ensure_private_dir(&agent_root)?;
  ensure_private_dir(&paper_dir)?;
  ensure_private_dir(&paper_dir.join("workspace"))?;
  remove_abandoned_staging(&paper_dir)?;
  recover_snapshot(&paper_dir)?;

  let mut pending = state.0.lock().map_err(|_| "snapshot state is poisoned")?;
  if pending.values().any(|value| value.paper_id == paper_id) {
    return Err("a snapshot update is already active for this paper".into());
  }

  let current_dir = paper_dir.join(CURRENT_PAPER_DIR);
  let needs_text = !static_snapshot_is_valid(&current_dir, &source_sha256, extractor_version);
  let token = Uuid::new_v4().to_string();
  let staging_dir = paper_dir.join(format!(".snapshot-{token}"));
  ensure_private_dir(&staging_dir)?;
  if needs_text {
    fs::copy(&source, staging_dir.join("paper.pdf"))
      .map_err(|error| format!("copy source PDF: {error}"))?;
    File::create(staging_dir.join("paper.txt"))
      .map_err(|error| format!("create staged paper text: {error}"))?;
  } else {
    for name in ["paper.pdf", "paper.txt"] {
      fs::copy(current_dir.join(name), staging_dir.join(name))
        .map_err(|error| format!("copy prior {name}: {error}"))?;
      make_file_writable(&staging_dir.join(name))?;
    }
  }
  pending.insert(token.clone(), PendingSnapshot {
    paper_id,
    staging_dir: staging_dir.clone(),
    paper_dir: paper_dir.clone(),
    source_sha256: source_sha256.clone(),
    extractor_version,
    needs_text,
    text_bytes: 0,
  });
  Ok(SnapshotBeginResult {
    token,
    needs_text,
    source_sha256,
    current_paper_path: current_dir.to_string_lossy().into_owned(),
    workspace_path: paper_dir.join("workspace").to_string_lossy().into_owned(),
  })
}

fn append_text_at(state: &ContextState, token: &str, chunk: &str) -> Result<(), String> {
  if chunk.len() > MAX_TEXT_CHUNK_BYTES {
    return Err("paper text chunk is too large".into());
  }
  let mut pending = state.0.lock().map_err(|_| "snapshot state is poisoned")?;
  let snapshot = pending.get_mut(token).ok_or("unknown snapshot token")?;
  if !snapshot.needs_text {
    return Err("paper text is already current".into());
  }
  let next_size = snapshot.text_bytes.saturating_add(chunk.len() as u64);
  if next_size > MAX_TEXT_BYTES {
    return Err("paper text snapshot is too large".into());
  }
  OpenOptions::new()
    .append(true)
    .open(snapshot.staging_dir.join("paper.txt"))
    .and_then(|mut file| file.write_all(chunk.as_bytes()))
    .map_err(|error| format!("append paper text: {error}"))?;
  snapshot.text_bytes = next_size;
  Ok(())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
  if path.exists() {
    make_file_writable(path)?;
  }
  let temporary = path.with_extension("tmp");
  fs::write(&temporary, bytes).map_err(|error| format!("write {}: {error}", path.display()))?;
  if path.exists() {
    fs::remove_file(path).map_err(|error| format!("replace {}: {error}", path.display()))?;
  }
  fs::rename(&temporary, path).map_err(|error| format!("commit {}: {error}", path.display()))
}

fn finalize_snapshot_at(
  state: &ContextState,
  token: &str,
  notes_markdown: String,
  context_markdown: String,
  snapshot_revision: String,
) -> Result<SnapshotFinalizeResult, String> {
  if notes_markdown.len() > MAX_MARKDOWN_BYTES || context_markdown.len() > MAX_MARKDOWN_BYTES {
    return Err("snapshot markdown is too large".into());
  }
  validate_sha256(&snapshot_revision, "snapshot revision")?;
  let snapshot = state.0.lock()
    .map_err(|_| "snapshot state is poisoned")?
    .remove(token)
    .ok_or("unknown snapshot token")?;
  let result = (|| {
    let text_path = snapshot.staging_dir.join("paper.txt");
    if fs::metadata(&text_path).map(|metadata| metadata.len()).unwrap_or(0) == 0 {
      return Err("paper text snapshot is empty".into());
    }

    write_new_file(&snapshot.staging_dir.join("notes.md"), notes_markdown.as_bytes())?;
    for name in ["paper.pdf", "paper.txt", "notes.md"] {
      set_snapshot_readonly(&snapshot.staging_dir.join(name))?;
    }
    // context.md is the visible commit marker inside the staged directory and is written last.
    write_new_file(&snapshot.staging_dir.join("context.md"), context_markdown.as_bytes())?;
    set_snapshot_readonly(&snapshot.staging_dir.join("context.md"))?;

    let mut file_hashes = BTreeMap::new();
    for name in ["paper.pdf", "paper.txt", "notes.md", "context.md"] {
      file_hashes.insert(name.to_string(), hash_file(&snapshot.staging_dir.join(name))?);
    }
    let manifest = SnapshotManifest {
      version: 1,
      extractor_version: snapshot.extractor_version,
      source_sha256: snapshot.source_sha256.clone(),
      revision: snapshot_revision.clone(),
      file_hashes: file_hashes.clone(),
    };
    fs::write(
      snapshot.staging_dir.join(MANIFEST_FILE),
      serde_json::to_vec_pretty(&manifest).map_err(|error| format!("encode snapshot manifest: {error}"))?,
    ).map_err(|error| format!("write snapshot manifest: {error}"))?;
    set_snapshot_readonly(&snapshot.staging_dir.join(MANIFEST_FILE))?;

    let current = snapshot.paper_dir.join(CURRENT_PAPER_DIR);
    let previous = snapshot.paper_dir.join(PREVIOUS_PAPER_DIR);
    if previous.exists() {
      remove_managed_tree(&previous, "remove stale previous snapshot")?;
    }
    if current.exists() {
      fs::rename(&current, &previous).map_err(|error| format!("stage previous snapshot: {error}"))?;
    }
    if let Err(error) = fs::rename(&snapshot.staging_dir, &current) {
      if previous.exists() && !current.exists() {
        let _ = fs::rename(&previous, &current);
      }
      return Err(format!("commit paper snapshot: {error}"));
    }
    if previous.exists() {
      remove_managed_tree(&previous, "remove previous snapshot")?;
    }
    Ok(SnapshotFinalizeResult {
      paper_id: snapshot.paper_id,
      revision: snapshot_revision,
      source_sha256: snapshot.source_sha256,
      file_hashes,
      current_paper_path: current.to_string_lossy().into_owned(),
      workspace_path: snapshot.paper_dir.join("workspace").to_string_lossy().into_owned(),
    })
  })();
  if result.is_err() && snapshot.staging_dir.exists() {
    let _ = remove_managed_tree(&snapshot.staging_dir, "remove failed staged snapshot");
  }
  result
}

fn abort_snapshot_at(state: &ContextState, token: &str) -> Result<(), String> {
  let snapshot = state.0.lock()
    .map_err(|_| "snapshot state is poisoned")?
    .remove(token);
  if let Some(snapshot) = snapshot {
    if snapshot.staging_dir.exists() {
      remove_managed_tree(&snapshot.staging_dir, "remove staged snapshot")?;
    }
  }
  Ok(())
}

fn pending_snapshot_paper_id(state: &ContextState, token: &str) -> Result<String, String> {
  state.0.lock()
    .map_err(|_| "snapshot state is poisoned".to_string())?
    .get(token)
    .map(|snapshot| snapshot.paper_id.clone())
    .ok_or_else(|| "unknown snapshot token".into())
}

fn cleanup_paper_at(state: &ContextState, app_data_dir: &Path, paper_id: &str) -> Result<(), String> {
  validate_paper_id(paper_id)?;
  if state.0.lock().map_err(|_| "snapshot state is poisoned")?
    .values().any(|value| value.paper_id == paper_id)
  {
    return Err("cannot clean a paper with an active snapshot update".into());
  }
  let agent_root = app_data_dir.join(AGENT_ROOT);
  let paper_dir = agent_root.join(paper_id);
  if paper_dir.parent() != Some(agent_root.as_path()) {
    return Err("paper cleanup escaped the Agent data root".into());
  }
  if paper_dir.exists() {
    remove_managed_tree(&paper_dir, "remove Agent paper data")?;
  }
  Ok(())
}

#[tauri::command]
pub async fn agent_snapshot_begin(
  app: AppHandle,
  paper_id: String,
  source_pdf_path: String,
  extractor_version: u32,
) -> Result<SnapshotBeginResult, String> {
  validate_paper_id(&paper_id)?;
  app.state::<AgentSupervisor>().reserve_snapshot(&paper_id)?;
  let reserved_paper_id = paper_id.clone();
  let worker_app = app.clone();
  let worker_result = tauri::async_runtime::spawn_blocking(move || {
    let app_data_dir = worker_app.path().app_data_dir().map_err(|error| format!("resolve application data: {error}"))?;
    let state = worker_app.state::<ContextState>();
    begin_snapshot_at(&state, &app_data_dir, paper_id, source_pdf_path, extractor_version)
  }).await.map_err(|error| format!("prepare paper snapshot task failed: {error}"));
  match worker_result {
    Ok(Ok(result)) => Ok(result),
    Ok(Err(error)) => {
      app.state::<AgentSupervisor>().finish_snapshot(&reserved_paper_id);
      Err(error)
    }
    Err(error) => {
      app.state::<AgentSupervisor>().finish_snapshot(&reserved_paper_id);
      Err(error)
    }
  }
}

#[tauri::command]
pub fn agent_snapshot_append_text(
  state: State<'_, ContextState>,
  token: String,
  chunk: String,
) -> Result<(), String> {
  append_text_at(&state, &token, &chunk)
}

#[tauri::command]
pub async fn agent_snapshot_finalize(
  app: AppHandle,
  token: String,
  notes_markdown: String,
  context_markdown: String,
  snapshot_revision: String,
) -> Result<SnapshotFinalizeResult, String> {
  let paper_id = pending_snapshot_paper_id(&app.state::<ContextState>(), &token)?;
  let worker_app = app.clone();
  let worker_result = tauri::async_runtime::spawn_blocking(move || {
    let state = worker_app.state::<ContextState>();
    let result = finalize_snapshot_at(&state, &token, notes_markdown, context_markdown, snapshot_revision)?;
    let app_data_dir = worker_app.path().app_data_dir().map_err(|error| format!("resolve application data: {error}"))?;
    super::worksheet::mark_context_revision_at(&app_data_dir, &result.paper_id, &result.revision)?;
    Ok(result)
  }).await.map_err(|error| format!("finalize paper snapshot task failed: {error}"));
  app.state::<AgentSupervisor>().finish_snapshot(&paper_id);
  worker_result?
}

#[tauri::command]
pub fn agent_snapshot_abort(app: AppHandle, token: String) -> Result<(), String> {
  let state = app.state::<ContextState>();
  let paper_id = pending_snapshot_paper_id(&state, &token).ok();
  let result = abort_snapshot_at(&state, &token);
  if let Some(paper_id) = paper_id {
    app.state::<AgentSupervisor>().finish_snapshot(&paper_id);
  }
  result
}

#[tauri::command]
pub async fn agent_cleanup_paper(
  app: AppHandle,
  paper_id: String,
) -> Result<(), String> {
  let supervisor = app.state::<AgentSupervisor>();
  supervisor.reserve_cleanup(&paper_id)?;
  let worker_app = app.clone();
  let worker_paper_id = paper_id.clone();
  let result = tauri::async_runtime::spawn_blocking(move || {
    let app_data_dir = worker_app.path().app_data_dir()
      .map_err(|error| format!("resolve application data: {error}"))?;
    let state = worker_app.state::<ContextState>();
    cleanup_paper_at(&state, &app_data_dir, &worker_paper_id)
  }).await.map_err(|error| format!("delete paper Agent data task failed: {error}"));
  app.state::<AgentSupervisor>().finish_cleanup(&paper_id);
  result?
}

#[tauri::command]
pub fn agent_workspace_path(app: AppHandle, paper_id: String) -> Result<String, String> {
  validate_paper_id(&paper_id)?;
  let workspace = app.path().app_data_dir()
    .map_err(|error| format!("resolve application data: {error}"))?
    .join(AGENT_ROOT)
    .join(paper_id)
    .join("workspace");
  if !workspace.is_dir() {
    return Err("prepare the paper Agent context before opening its workspace".into());
  }
  Ok(workspace.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_root(label: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let path = std::env::temp_dir().join(format!("lightread-agent-{label}-{nonce}"));
    fs::create_dir_all(&path).unwrap();
    path
  }

  fn source_pdf(root: &Path, name: &str, tail: &[u8]) -> PathBuf {
    let path = root.join(name);
    let mut bytes = b"%PDF-1.7\n".to_vec();
    bytes.extend_from_slice(tail);
    fs::write(&path, bytes).unwrap();
    path
  }

  fn finalize(
    state: &ContextState,
    root: &Path,
    source: &Path,
    paper_id: &str,
    text: &str,
    notes: &str,
    context: &str,
  ) -> SnapshotFinalizeResult {
    let begin = begin_snapshot_at(
      state,
      root,
      paper_id.to_string(),
      source.to_string_lossy().into_owned(),
      1,
    ).unwrap();
    if begin.needs_text {
      append_text_at(state, &begin.token, text).unwrap();
    }
    let revision = hash_bytes(format!("{notes}\n{context}").as_bytes());
    finalize_snapshot_at(state, &begin.token, notes.to_string(), context.to_string(), revision).unwrap()
  }

  #[test]
  fn commits_a_complete_readonly_snapshot_and_writable_workspace() {
    let root = temp_root("commit");
    let source = source_pdf(&root, "论文 source.pdf", b"original");
    let state = ContextState::default();
    let result = finalize(&state, &root, &source, "paper_1", "[Page 1]\nhello\n", "# notes\n", "# context\n");
    let current = PathBuf::from(&result.current_paper_path);
    for name in ["paper.pdf", "paper.txt", "notes.md", "context.md"] {
      let path = current.join(name);
      assert!(path.is_file(), "{}", path.display());
      assert!(fs::metadata(path).unwrap().permissions().readonly());
    }
    assert!(PathBuf::from(result.workspace_path).is_dir());
    assert_eq!(fs::read(current.join("paper.pdf")).unwrap(), fs::read(source).unwrap());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn dynamic_refresh_reuses_static_files_and_keeps_last_valid_snapshot_on_abort() {
    let root = temp_root("dynamic");
    let source = source_pdf(&root, "source.pdf", b"original");
    let state = ContextState::default();
    let first = finalize(&state, &root, &source, "paper-2", "[Page 1]\nold\n", "old notes", "old context");
    let old_pdf_hash = hash_file(&PathBuf::from(&first.current_paper_path).join("paper.pdf")).unwrap();
    let begin = begin_snapshot_at(&state, &root, "paper-2".into(), source.to_string_lossy().into_owned(), 1).unwrap();
    assert!(!begin.needs_text);
    abort_snapshot_at(&state, &begin.token).unwrap();
    assert_eq!(fs::read_to_string(PathBuf::from(&first.current_paper_path).join("context.md")).unwrap(), "old context");
    let second = finalize(&state, &root, &source, "paper-2", "unused", "new notes", "new context");
    assert_eq!(old_pdf_hash, hash_file(&PathBuf::from(&second.current_paper_path).join("paper.pdf")).unwrap());
    assert_eq!(fs::read_to_string(PathBuf::from(&second.current_paper_path).join("context.md")).unwrap(), "new context");
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn modified_static_snapshot_forces_regeneration() {
    let root = temp_root("tamper");
    let source = source_pdf(&root, "source.pdf", b"original");
    let state = ContextState::default();
    let result = finalize(&state, &root, &source, "paper-3", "[Page 1]\noriginal text\n", "notes", "context");
    let text_path = PathBuf::from(result.current_paper_path).join("paper.txt");
    make_file_writable(&text_path).unwrap();
    fs::write(&text_path, "tampered").unwrap();
    let begin = begin_snapshot_at(&state, &root, "paper-3".into(), source.to_string_lossy().into_owned(), 1).unwrap();
    assert!(begin.needs_text);
    abort_snapshot_at(&state, &begin.token).unwrap();
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn rejects_traversal_and_non_pdf_sources() {
    let root = temp_root("validate");
    let source = source_pdf(&root, "source.pdf", b"original");
    let text = root.join("source.txt");
    fs::write(&text, b"%PDF-fake").unwrap();
    let state = ContextState::default();
    assert!(begin_snapshot_at(&state, &root, "../escape".into(), source.to_string_lossy().into_owned(), 1).is_err());
    assert!(begin_snapshot_at(&state, &root, "paper".into(), text.to_string_lossy().into_owned(), 1).is_err());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn cleanup_is_confined_and_idempotent() {
    let root = temp_root("cleanup");
    let source = source_pdf(&root, "source.pdf", b"original");
    let state = ContextState::default();
    finalize(&state, &root, &source, "paper-4", "text", "notes", "context");
    cleanup_paper_at(&state, &root, "paper-4").unwrap();
    cleanup_paper_at(&state, &root, "paper-4").unwrap();
    assert!(cleanup_paper_at(&state, &root, "..").is_err());
    assert!(source.exists());
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn next_prepare_removes_an_abandoned_staged_snapshot() {
    let root = temp_root("abandoned");
    let source = source_pdf(&root, "source.pdf", b"original");
    let state = ContextState::default();
    let paper_dir = root.join(AGENT_ROOT).join("paper-5");
    let abandoned = paper_dir.join(format!(".snapshot-{}", Uuid::new_v4()));
    fs::create_dir_all(&abandoned).unwrap();
    fs::write(abandoned.join("paper.txt"), "partial").unwrap();
    set_snapshot_readonly(&abandoned.join("paper.txt")).unwrap();
    let begin = begin_snapshot_at(
      &state,
      &root,
      "paper-5".into(),
      source.to_string_lossy().into_owned(),
      1,
    ).unwrap();
    assert!(!abandoned.exists());
    abort_snapshot_at(&state, &begin.token).unwrap();
    fs::remove_dir_all(root).unwrap();
  }
}
