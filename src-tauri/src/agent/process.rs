use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
#[cfg(unix)]
use std::time::{Duration, Instant};

const MAX_FRAME_BYTES: usize = 1024 * 1024;
const STDERR_LINES: usize = 200;
const IO_QUEUE_CAPACITY: usize = 256;

#[derive(Debug)]
pub enum ProcessFrame {
  Line(String),
  Oversized,
  IoError(String),
  Eof,
}

pub struct ProcessIo {
  pub process: Arc<Mutex<ManagedProcess>>,
  pub stdin: mpsc::SyncSender<Vec<u8>>,
  pub stdout: mpsc::Receiver<ProcessFrame>,
  pub stderr: Arc<Mutex<VecDeque<String>>>,
}

pub struct ManagedProcess {
  child: Child,
  #[cfg(windows)]
  job: windows_sys::Win32::Foundation::HANDLE,
}

impl ProcessIo {
  pub fn stderr_tail(&self) -> String {
    let lines = self.stderr.lock().unwrap_or_else(|error| error.into_inner());
    lines.iter().rev().take(8).rev().flat_map(|line| line.chars().chain(std::iter::once('\n')))
      .take(2_000).collect::<String>().trim().to_string()
  }
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
  use std::os::unix::process::CommandExt;
  unsafe {
    command.pre_exec(|| {
      if libc::setpgid(0, 0) == 0 {
        Ok(())
      } else {
        Err(std::io::Error::last_os_error())
      }
    });
  }
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(windows)]
fn create_job(child: &Child) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
  use std::mem::size_of;
  use std::os::windows::io::AsRawHandle;
  use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  };
  unsafe {
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
      return Err(format!("create Windows Job Object: {}", std::io::Error::last_os_error()));
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if SetInformationJobObject(
      job,
      JobObjectExtendedLimitInformation,
      &info as *const _ as *const _,
      size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    ) == 0
    {
      windows_sys::Win32::Foundation::CloseHandle(job);
      return Err(format!("configure Windows Job Object: {}", std::io::Error::last_os_error()));
    }
    if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
      windows_sys::Win32::Foundation::CloseHandle(job);
      return Err(format!("assign Windows Job Object: {}", std::io::Error::last_os_error()));
    }
    Ok(job)
  }
}

#[cfg(not(windows))]
fn create_job(_child: &Child) -> Result<(), String> {
  Ok(())
}

fn pump_lines<R: Read>(mut reader: R, sender: mpsc::SyncSender<ProcessFrame>) {
  let mut pending = Vec::new();
  let mut discarding_oversized = false;
  let mut chunk = [0_u8; 8192];
  loop {
    let count = match reader.read(&mut chunk) {
      Ok(0) => break,
      Ok(count) => count,
      Err(error) => {
        let _ = sender.send(ProcessFrame::IoError(error.to_string()));
        return;
      }
    };
    let mut cursor = 0;
    while cursor < count {
      if discarding_oversized {
        if let Some(end) = chunk[cursor..count].iter().position(|byte| *byte == b'\n') {
          cursor += end + 1;
          discarding_oversized = false;
          continue;
        }
        break;
      }

      if let Some(end) = chunk[cursor..count].iter().position(|byte| *byte == b'\n') {
        pending.extend_from_slice(&chunk[cursor..cursor + end]);
        if pending.last() == Some(&b'\r') {
          pending.pop();
        }
        if pending.len() > MAX_FRAME_BYTES {
          let _ = sender.send(ProcessFrame::Oversized);
        } else {
          let line = std::mem::take(&mut pending);
          let _ = sender.send(ProcessFrame::Line(String::from_utf8_lossy(&line).into_owned()));
        }
        pending.clear();
        cursor += end + 1;
      } else {
        pending.extend_from_slice(&chunk[cursor..count]);
        if pending.len() > MAX_FRAME_BYTES {
          pending.clear();
          discarding_oversized = true;
          let _ = sender.send(ProcessFrame::Oversized);
        }
        break;
      }
    }
  }
  if !discarding_oversized && !pending.is_empty() {
    let frame = if pending.len() > MAX_FRAME_BYTES {
      ProcessFrame::Oversized
    } else {
      ProcessFrame::Line(String::from_utf8_lossy(&pending).into_owned())
    };
    let _ = sender.send(frame);
  }
  let _ = sender.send(ProcessFrame::Eof);
}

fn drain_stderr<R: Read + Send + 'static>(reader: R, ring: Arc<Mutex<VecDeque<String>>>) {
  let (sender, receiver) = mpsc::sync_channel(IO_QUEUE_CAPACITY);
  thread::spawn(move || pump_lines(reader, sender));
  while let Ok(frame) = receiver.recv() {
    match frame {
      ProcessFrame::Line(line) => {
        let mut lines = ring.lock().unwrap_or_else(|error| error.into_inner());
        if lines.len() == STDERR_LINES {
          lines.pop_front();
        }
        lines.push_back(line);
      }
      ProcessFrame::Oversized => {
        let mut lines = ring.lock().unwrap_or_else(|error| error.into_inner());
        if lines.len() == STDERR_LINES {
          lines.pop_front();
        }
        lines.push_back("[oversized stderr frame omitted]".into());
      }
      ProcessFrame::IoError(error) => {
        ring.lock().unwrap_or_else(|value| value.into_inner()).push_back(error);
      }
      ProcessFrame::Eof => break,
    }
  }
}

pub fn spawn_managed(command: &mut Command) -> Result<ProcessIo, String> {
  configure_process_group(command);
  command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
  let mut child = command.spawn().map_err(|error| format!("start Agent process: {error}"))?;
  #[cfg(windows)]
  let job = match create_job(&child) {
    Ok(job) => job,
    Err(error) => {
      let _ = child.kill();
      let _ = child.wait();
      return Err(error);
    }
  };
  #[cfg(not(windows))]
  create_job(&child)?;
  let mut child_stdin = child.stdin.take().ok_or("Agent process has no stdin")?;
  let child_stdout = child.stdout.take().ok_or("Agent process has no stdout")?;
  let child_stderr = child.stderr.take().ok_or("Agent process has no stderr")?;
  let process = Arc::new(Mutex::new(ManagedProcess {
    child,
    #[cfg(windows)]
    job,
  }));
  let (stdin_sender, stdin_receiver) = mpsc::sync_channel::<Vec<u8>>(32);
  thread::spawn(move || {
    while let Ok(bytes) = stdin_receiver.recv() {
      if child_stdin.write_all(&bytes).is_err() || child_stdin.flush().is_err() {
        break;
      }
    }
  });
  let (stdout_sender, stdout_receiver) = mpsc::sync_channel(IO_QUEUE_CAPACITY);
  thread::spawn(move || pump_lines(child_stdout, stdout_sender));
  let stderr = Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_LINES)));
  let stderr_thread = stderr.clone();
  thread::spawn(move || drain_stderr(child_stderr, stderr_thread));
  Ok(ProcessIo { process, stdin: stdin_sender, stdout: stdout_receiver, stderr })
}

impl ManagedProcess {
  #[cfg(test)]
  pub fn id(&self) -> u32 {
    self.child.id()
  }

  pub fn try_wait(&mut self) -> Result<Option<std::process::ExitStatus>, String> {
    self.child.try_wait().map_err(|error| format!("inspect Agent process: {error}"))
  }

  pub fn terminate_tree(&mut self) -> Result<(), String> {
    if self.try_wait()?.is_some() {
      return Ok(());
    }
    #[cfg(unix)]
    unsafe {
      let group = -(self.child.id() as i32);
      libc::kill(group, libc::SIGTERM);
      let deadline = Instant::now() + Duration::from_millis(750);
      while Instant::now() < deadline {
        if self.try_wait()?.is_some() {
          return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
      }
      libc::kill(group, libc::SIGKILL);
    }
    #[cfg(windows)]
    unsafe {
      if windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) == 0 {
        return Err(format!("terminate Windows Job Object: {}", std::io::Error::last_os_error()));
      }
    }
    #[cfg(not(any(unix, windows)))]
    self.child.kill().map_err(|error| format!("terminate Agent process: {error}"))?;
    self.child.wait().map_err(|error| format!("reap Agent process: {error}"))?;
    Ok(())
  }
}

impl Drop for ManagedProcess {
  fn drop(&mut self) {
    let _ = self.terminate_tree();
    #[cfg(windows)]
    unsafe {
      if !self.job.is_null() {
        windows_sys::Win32::Foundation::CloseHandle(self.job);
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Cursor;

  #[test]
  fn bounded_line_reader_handles_chunk_boundaries_and_invalid_utf8() {
    let input = Cursor::new(vec![b'a', b'\n', 0xff, b'b', b'\n', b'c']);
    let (sender, receiver) = mpsc::sync_channel(8);
    pump_lines(input, sender);
    assert!(matches!(receiver.recv().unwrap(), ProcessFrame::Line(value) if value == "a"));
    assert!(matches!(receiver.recv().unwrap(), ProcessFrame::Line(value) if value.contains('b')));
    assert!(matches!(receiver.recv().unwrap(), ProcessFrame::Line(value) if value == "c"));
    assert!(matches!(receiver.recv().unwrap(), ProcessFrame::Eof));
  }

  #[test]
  fn bounded_line_reader_discards_the_remainder_of_an_oversized_frame() {
    let mut input = vec![b'x'; MAX_FRAME_BYTES + 17];
    input.extend_from_slice(b"\nvalid\n");
    let (sender, receiver) = mpsc::sync_channel(8);
    pump_lines(Cursor::new(input), sender);
    assert!(matches!(receiver.recv().unwrap(), ProcessFrame::Oversized));
    assert!(matches!(receiver.recv().unwrap(), ProcessFrame::Line(value) if value == "valid"));
    assert!(matches!(receiver.recv().unwrap(), ProcessFrame::Eof));
  }

  #[cfg(unix)]
  #[test]
  fn terminate_tree_reaps_the_root_process() {
    let mut command = Command::new("sh");
    command.args(["-c", "sleep 30 & wait"]);
    let io = spawn_managed(&mut command).unwrap();
    let pid = io.process.lock().unwrap().id();
    io.process.lock().unwrap().terminate_tree().unwrap();
    assert!(io.process.lock().unwrap().try_wait().unwrap().is_some(), "pid {pid}");
  }

  #[cfg(windows)]
  #[test]
  fn terminate_job_reaps_the_root_process() {
    let mut command = Command::new("cmd.exe");
    command.args(["/C", "ping -n 31 127.0.0.1 >NUL"]);
    let io = spawn_managed(&mut command).unwrap();
    let pid = io.process.lock().unwrap().id();
    io.process.lock().unwrap().terminate_tree().unwrap();
    assert!(io.process.lock().unwrap().try_wait().unwrap().is_some(), "pid {pid}");
  }
}
