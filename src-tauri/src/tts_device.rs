//! 离线语音的设备评估与 Windows 路径兼容。
//!
//! sherpa-onnx 遇到内部错误会直接结束进程 (`_Exit`), 内存不足时的 C++ 异常也会让 Rust 侧 abort,
//! 这些都无法在 Rust 里捕获。所以下载前先评估设备, 明显带不动的不提供下载;
//! 运行时的闪退由 local_tts 的闪退标记兜底。
#![cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 低于此总内存不推荐 (fp32 模型约 330MB, 加载峰值估计 1–1.5GB; 4GB 的机器系统和 WebView 已占去大半)
const MIN_TOTAL_RAM: u64 = 5_500 << 20;
/// 安装包与解压后的文件会同时存在一段时间
const MIN_FREE_DISK: u64 = 1 << 30;
/// 推理用一半逻辑核; 少于 4 个逻辑核时合成跟不上朗读, 还会让界面卡住
const MIN_LOGICAL_CORES: usize = 4;

#[derive(Serialize)]
pub struct DeviceCheck {
    pub ok: bool,
    pub reasons: Vec<String>,
}

/// 评估结果的原因, 中英两种说法 (前端按界面语言传 lang)
#[derive(Debug, PartialEq)]
pub(crate) enum Concern {
    LowMemory(u64),
    FewCores(usize),
    NoAvx2,
    LowDisk(u64),
    BadPath,
}

impl Concern {
    fn describe(&self, en: bool) -> String {
        let gb = |b: &u64| format!("{:.1}", *b as f64 / (1u64 << 30) as f64);
        match (self, en) {
            (Concern::LowMemory(b), false) => format!("内存 {} GB，至少需要 6 GB", gb(b)),
            (Concern::LowMemory(b), true) => format!("{} GB of memory, at least 6 GB needed", gb(b)),
            (Concern::FewCores(n), false) => format!("处理器只有 {n} 个线程，至少需要 4 个"),
            (Concern::FewCores(n), true) => format!("only {n} CPU threads, at least 4 needed"),
            (Concern::NoAvx2, false) => "处理器较旧（不支持 AVX2），合成跟不上朗读".into(),
            (Concern::NoAvx2, true) => "the CPU is too old (no AVX2) to keep up".into(),
            (Concern::LowDisk(b), false) => format!("磁盘剩余 {} GB，至少需要 1 GB", gb(b)),
            (Concern::LowDisk(b), true) => format!("{} GB of free disk space, at least 1 GB needed", gb(b)),
            (Concern::BadPath, false) => "数据目录含中文等字符，且系统未开启短文件名，离线语音无法读取".into(),
            (Concern::BadPath, true) => "the data folder path has non-English characters the voice engine cannot read".into(),
        }
    }
}

/// 纯函数: 由测得的数值得出不推荐的原因 (测不到的项不算问题)
pub(crate) fn assess(ram: Option<u64>, cores: Option<usize>, avx2: Option<bool>, disk: Option<u64>, path_ok: bool) -> Vec<Concern> {
    let mut out = Vec::new();
    if let Some(r) = ram.filter(|r| *r < MIN_TOTAL_RAM) {
        out.push(Concern::LowMemory(r));
    }
    if let Some(c) = cores.filter(|c| *c < MIN_LOGICAL_CORES) {
        out.push(Concern::FewCores(c));
    }
    if avx2 == Some(false) {
        out.push(Concern::NoAvx2);
    }
    if let Some(d) = disk.filter(|d| *d < MIN_FREE_DISK) {
        out.push(Concern::LowDisk(d));
    }
    if !path_ok {
        out.push(Concern::BadPath);
    }
    out
}

#[tauri::command]
pub fn local_tts_device_check(app: AppHandle, lang: Option<String>) -> DeviceCheck {
    let en = lang.as_deref() == Some("en");
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        return DeviceCheck {
            ok: false,
            reasons: vec![if en { "not supported on mobile".into() } else { "移动端暂不支持".into() }],
        };
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use tauri::Manager;
        let data = app.path().app_data_dir().ok();
        let cores = std::thread::available_parallelism().ok().map(|n| n.get());
        #[cfg(target_arch = "x86_64")]
        let avx2 = Some(std::arch::is_x86_feature_detected!("avx2"));
        #[cfg(not(target_arch = "x86_64"))]
        let avx2: Option<bool> = None;
        let disk = data.as_deref().and_then(free_disk);
        let path_ok = data.as_deref().map_or(true, |d| engine_path(d).is_ok());
        let concerns = assess(total_memory(), cores, avx2, disk, path_ok);
        DeviceCheck {
            ok: concerns.is_empty(),
            reasons: concerns.iter().map(|c| c.describe(en)).collect(),
        }
    }
}

/// 交给原生库的路径: sherpa-onnx 在 Windows 上除 model.onnx 外都用窄字符 (ANSI) 打开文件,
/// 用户名含中文时数据目录读不了。路径不是纯 ASCII 时换成 8.3 短路径; 系统关了短文件名就报错。
#[cfg(windows)]
pub(crate) fn engine_path(path: &Path) -> Result<PathBuf, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    if path.to_string_lossy().is_ascii() {
        return Ok(path.to_path_buf());
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetShortPathNameW(long: *const u16, short: *mut u16, len: u32) -> u32;
    }
    // 目录可能还不存在 (下载前评估), 取最近的已存在祖先来判断能否得到短路径
    let mut probe = path;
    while !probe.exists() {
        match probe.parent() {
            Some(p) => probe = p,
            None => break,
        }
    }
    let wide: Vec<u16> = probe.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    let n = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return Err(Concern::BadPath.describe(false));
    }
    let short = PathBuf::from(OsString::from_wide(&buf[..n])).join(path.strip_prefix(probe).unwrap_or(Path::new("")));
    if short.to_string_lossy().is_ascii() {
        Ok(short)
    } else {
        Err(Concern::BadPath.describe(false))
    }
}

/// macOS / Linux 的原生库按 UTF-8 打开文件, 原样使用
#[cfg(not(windows))]
pub(crate) fn engine_path(path: &Path) -> Result<PathBuf, String> {
    Ok(path.to_path_buf())
}

#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) fn total_memory() -> Option<u64> {
    let info = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb: u64 = info.lines().find(|l| l.starts_with("MemTotal:"))?.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

#[cfg(target_os = "macos")]
pub(crate) fn total_memory() -> Option<u64> {
    let mut size: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let name = b"hw.memsize\0";
    let rc = unsafe {
        libc::sysctlbyname(name.as_ptr() as *const _, &mut size as *mut u64 as *mut _, &mut len, std::ptr::null_mut(), 0)
    };
    (rc == 0).then_some(size)
}

#[cfg(windows)]
pub(crate) fn total_memory() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status: MemoryStatusEx = unsafe { std::mem::zeroed() };
    status.length = std::mem::size_of::<MemoryStatusEx>() as u32;
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.total_phys)
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", windows)))]
pub(crate) fn total_memory() -> Option<u64> {
    None
}

/// 最近的已存在祖先目录所在磁盘的可用空间
#[cfg(unix)]
pub(crate) fn free_disk(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let dir = path.ancestors().find(|p| p.exists())?;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(c.as_ptr(), &mut st) } == 0).then(|| st.f_bavail as u64 * st.f_frsize as u64)
}

#[cfg(windows)]
pub(crate) fn free_disk(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, avail: *mut u64, total: *mut u64, free: *mut u64) -> i32;
    }
    let dir = path.ancestors().find(|p| p.exists())?;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut avail = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(avail)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn free_disk(_path: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_machine_passes() {
        assert!(assess(Some(16 << 30), Some(8), Some(true), Some(50 << 30), true).is_empty());
        // 测不到的项不拦
        assert!(assess(None, None, None, None, true).is_empty());
    }

    #[test]
    fn weak_machine_lists_every_reason() {
        let c = assess(Some(4 << 30), Some(2), Some(false), Some(512 << 20), false);
        assert_eq!(c.len(), 5);
        assert!(c[0].describe(false).contains("至少需要 6 GB"));
        assert!(c[1].describe(true).contains("2 CPU threads"));
    }

    #[test]
    fn eight_gb_laptop_with_4_threads_is_fine() {
        // 8GB 机器系统报告的总内存略少于 8GB
        assert!(assess(Some(7_800 << 20), Some(4), Some(true), Some(2 << 30), true).is_empty());
    }

    #[test]
    fn this_machine_reports_measurements() {
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        assert!(total_memory().unwrap_or(0) > 0);
        assert!(free_disk(&std::env::temp_dir()).unwrap_or(0) > 0);
        assert!(engine_path(&std::env::temp_dir()).is_ok());
    }
}
