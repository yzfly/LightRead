//! 本机模型的设备评估 (纯函数): 内存是否装得下、用几个线程、明显带不动的设备不提供下载。
//! 做法取自 pocketpal-ai-zh (内存上限 = min(60% 内存, 内存 − 1.2GB); 线程数 = 大核数)。
//! 真实速度下载后实测 (见 mod.rs 的速度记录), 这里只挡掉必然失败的情况。

/// 手机: 低于此总内存不提供 (系统与 WebView 已占去大半, 加载 1GB 模型会被系统杀掉)
const MOBILE_MIN_RAM: u64 = 5_500 << 20;
/// 桌面: 8GB 机器系统报告的总内存略少于 8GB
const DESKTOP_MIN_RAM: u64 = 7_300 << 20;
const MOBILE_MIN_CORES: usize = 8;
const DESKTOP_MIN_CORES: usize = 4;
/// 下载之外再留的磁盘余量
const DISK_HEADROOM: u64 = 512 << 20;

#[derive(Clone, Debug, Default)]
pub(crate) struct Device {
    pub ram: Option<u64>,
    pub logical_cores: usize,
    /// 大核数 (测不到时为 0)
    pub perf_cores: usize,
    pub avx2: Option<bool>,
    pub mobile: bool,
    pub free_disk: Option<u64>,
}

/// 一个模型对设备的要求
#[derive(Clone, Copy, Debug)]
pub(crate) struct Requirements {
    /// 要下载的字节数
    pub download: u64,
    /// 加载后大约占用的内存
    pub memory: u64,
    /// 手机上是否提供
    pub mobile_ok: bool,
    /// 桌面的最低总内存与线程数 (0 = 用通用下限)
    pub desktop_min_ram: u64,
    pub desktop_min_ram_gb: u32,
    pub desktop_min_cores: usize,
}

impl Requirements {
    /// 文本模型: 内存按文件大小与上下文估算, 其余用通用下限
    pub const fn text(download: u64, n_ctx: u32) -> Self {
        Self { download, memory: memory_need(download, n_ctx), mobile_ok: true, desktop_min_ram: 0, desktop_min_ram_gb: 8, desktop_min_cores: 0 }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) enum Concern {
    /// 这类设备暂不提供 (手机上的大语音模型)
    NotOnMobile,
    LowMemory { have: u64, need_gb: u32 },
    WontFit { need: u64, ceiling: u64 },
    FewCores { have: usize, need: usize },
    NoAvx2,
    LowDisk { have: u64, need: u64 },
}

impl Concern {
    pub fn describe(&self, en: bool) -> String {
        let gb = |b: &u64| format!("{:.1}", *b as f64 / (1u64 << 30) as f64);
        match (self, en) {
            (Concern::NotOnMobile, false) => "手机上暂不提供，目前只支持电脑".into(),
            (Concern::NotOnMobile, true) => "not available on phones yet, computers only".into(),
            (Concern::LowMemory { have, need_gb }, false) => format!("内存 {} GB，至少需要 {need_gb} GB", gb(have)),
            (Concern::LowMemory { have, need_gb }, true) => format!("{} GB of memory, at least {need_gb} GB needed", gb(have)),
            (Concern::WontFit { need, ceiling }, false) => format!("模型约占 {} GB 内存，本机最多可用 {} GB", gb(need), gb(ceiling)),
            (Concern::WontFit { need, ceiling }, true) => format!("the model needs about {} GB of memory, this device can spare {} GB", gb(need), gb(ceiling)),
            (Concern::FewCores { have, need }, false) => format!("处理器只有 {have} 个线程，至少需要 {need} 个"),
            (Concern::FewCores { have, need }, true) => format!("only {have} CPU threads, at least {need} needed"),
            (Concern::NoAvx2, false) => "处理器较旧（不支持 AVX2），速度跟不上".into(),
            (Concern::NoAvx2, true) => "the CPU is too old (no AVX2) to keep up".into(),
            (Concern::LowDisk { have, need }, false) => format!("磁盘剩余 {} GB，至少需要 {} GB", gb(have), gb(need)),
            (Concern::LowDisk { have, need }, true) => format!("{} GB of free disk space, at least {} GB needed", gb(have), gb(need)),
        }
    }
}

/// 加载后大约占用的内存: 权重 (mmap 后基本全部驻留) + 上下文与计算缓冲
pub(crate) const fn memory_need(model_bytes: u64, n_ctx: u32) -> u64 {
    model_bytes + model_bytes / 8 + (n_ctx as u64) * (96 << 10)
}

/// 本机能让给模型的内存上限
pub(crate) fn memory_ceiling(ram: u64) -> u64 {
    let headroom = 1_200 << 20;
    (ram / 10 * 6).min(ram.saturating_sub(headroom))
}

/// 不提供下载的原因; 空 = 可以用。测不到的项不算问题。
/// `installed` 为真时不再检查磁盘 (文件已经在了)。
pub(crate) fn assess(dev: &Device, req: &Requirements, installed: bool) -> Vec<Concern> {
    let mut out = Vec::new();
    if dev.mobile && !req.mobile_ok {
        return vec![Concern::NotOnMobile];
    }
    let (min_ram, min_ram_gb, min_cores) = if dev.mobile {
        (MOBILE_MIN_RAM, 6, MOBILE_MIN_CORES)
    } else {
        (req.desktop_min_ram.max(DESKTOP_MIN_RAM), req.desktop_min_ram_gb.max(8), req.desktop_min_cores.max(DESKTOP_MIN_CORES))
    };
    if let Some(ram) = dev.ram {
        if ram < min_ram {
            out.push(Concern::LowMemory { have: ram, need_gb: min_ram_gb });
        } else if req.memory > memory_ceiling(ram) {
            out.push(Concern::WontFit { need: req.memory, ceiling: memory_ceiling(ram) });
        }
    }
    if dev.logical_cores > 0 && dev.logical_cores < min_cores {
        out.push(Concern::FewCores { have: dev.logical_cores, need: min_cores });
    }
    if dev.avx2 == Some(false) {
        out.push(Concern::NoAvx2);
    }
    if !installed {
        let need = req.download + DISK_HEADROOM;
        if let Some(have) = dev.free_disk.filter(|d| *d < need) {
            out.push(Concern::LowDisk { have, need });
        }
    }
    out
}

/// 由各核心的最高频率数出大核: 高于最低一档的都算。频率全相同 (或读不到) 返回 0。
pub(crate) fn perf_cores_from_freqs(freqs: &[u64]) -> usize {
    let Some(min) = freqs.iter().copied().min() else { return 0 };
    let big = freqs.iter().filter(|f| **f > min).count();
    if big == freqs.len() { 0 } else { big }
}

/// 推理线程数: 有大小核就只用大核 (小核会拖慢整体); 否则用一半逻辑核。
/// 上限 8: 再多对 1–2B 的模型没有收益; 至少留一个核给界面。
pub(crate) fn inference_threads(dev: &Device) -> i32 {
    let logical = dev.logical_cores.max(1);
    let n = if dev.perf_cores >= 2 && dev.perf_cores < logical { dev.perf_cores } else { logical / 2 };
    n.clamp(1, 8).min(logical.saturating_sub(1).max(1)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    const HY_MT: Requirements = Requirements::text(1_133_080_448, 4096);
    /// 语音模型: 只在 12GB 以上、8 线程以上的电脑上提供
    const VOICE: Requirements = Requirements { download: 1_482_388_192, memory: 3_500 << 20, mobile_ok: false, desktop_min_ram: 11_500 << 20, desktop_min_ram_gb: 12, desktop_min_cores: 8 };

    fn dev(ram_gb: f64, cores: usize, mobile: bool) -> Device {
        Device {
            ram: Some((ram_gb * (1u64 << 30) as f64) as u64),
            logical_cores: cores,
            perf_cores: 0,
            avx2: None,
            mobile,
            free_disk: Some(50 << 30),
        }
    }

    #[test]
    fn capable_devices_pass() {
        assert!(assess(&dev(16.0, 10, false), &HY_MT, false).is_empty());
        // 8GB 笔记本 (系统报 7.8GB)、8GB 手机、6GB 手机 (系统报 5.6GB)
        assert!(assess(&dev(7.8, 8, false), &HY_MT, false).is_empty());
        assert!(assess(&dev(7.4, 8, true), &HY_MT, false).is_empty());
        assert!(assess(&dev(5.6, 8, true), &HY_MT, false).is_empty());
        // 测不到的项不拦
        assert!(assess(&Device::default(), &HY_MT, false).is_empty());
    }

    #[test]
    fn weak_devices_are_turned_away_with_reasons() {
        let c = assess(&dev(3.7, 8, true), &HY_MT, false);
        assert_eq!(c, vec![Concern::LowMemory { have: (3.7 * (1u64 << 30) as f64) as u64, need_gb: 6 }]);
        assert!(c[0].describe(false).contains("至少需要 6 GB"));
        assert!(matches!(assess(&dev(4.0, 4, false), &HY_MT, false)[0], Concern::LowMemory { need_gb: 8, .. }));
        assert_eq!(assess(&dev(8.0, 4, true), &HY_MT, false), vec![Concern::FewCores { have: 4, need: 8 }]);
        let mut old = dev(16.0, 4, false);
        old.avx2 = Some(false);
        assert_eq!(assess(&old, &HY_MT, false), vec![Concern::NoAvx2]);
    }

    #[test]
    fn a_model_bigger_than_the_ceiling_does_not_fit() {
        // 8GB 手机装不下 6GB 的模型 (上限 4.8GB)
        let c = assess(&dev(8.0, 8, true), &Requirements::text(6 << 30, 4096), false);
        assert!(matches!(c[0], Concern::WontFit { .. }), "{c:?}");
        assert!(c[0].describe(true).contains("can spare 4.8 GB"));
    }

    #[test]
    fn a_heavier_model_raises_the_bar_and_can_skip_phones() {
        assert!(assess(&dev(16.0, 10, false), &VOICE, false).is_empty());
        assert_eq!(assess(&dev(12.0, 8, true), &VOICE, false), vec![Concern::NotOnMobile]);
        let c = assess(&dev(7.8, 8, false), &VOICE, false);
        assert!(matches!(c[0], Concern::LowMemory { need_gb: 12, .. }), "{c:?}");
        assert_eq!(assess(&dev(16.0, 4, false), &VOICE, false), vec![Concern::FewCores { have: 4, need: 8 }]);
        // 通用下限照旧适用于普通模型
        assert!(assess(&dev(7.8, 4, false), &HY_MT, false).is_empty());
    }

    #[test]
    fn disk_is_only_checked_before_download() {
        let mut d = dev(16.0, 8, false);
        d.free_disk = Some(1 << 30);
        assert!(matches!(assess(&d, &HY_MT, false)[0], Concern::LowDisk { .. }));
        assert!(assess(&d, &HY_MT, true).is_empty());
    }

    #[test]
    fn threads_follow_big_cores() {
        // 骁龙 1+3+4: 4 个大核
        assert_eq!(perf_cores_from_freqs(&[1800, 1800, 1800, 1800, 2400, 2400, 2400, 2840]), 4);
        assert_eq!(perf_cores_from_freqs(&[2400; 8]), 0);
        assert_eq!(perf_cores_from_freqs(&[]), 0);
        let mut d = dev(8.0, 8, true);
        d.perf_cores = 4;
        assert_eq!(inference_threads(&d), 4);
        d.perf_cores = 0;
        assert_eq!(inference_threads(&d), 4);
        assert_eq!(inference_threads(&dev(32.0, 32, false)), 8);
        assert_eq!(inference_threads(&dev(8.0, 2, false)), 1);
        assert_eq!(inference_threads(&Device::default()), 1);
    }
}
