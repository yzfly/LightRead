//! 改写 GGUF 文件里张量的类型编号 (只动文件头里每个张量的 4 字节类型字段, 权重数据不动)。
//!
//! 用途: 轻量翻译模型 Hy-MT2 1.8B 1.25bit 用 STQ1_0 量化, 这种类型还没进 llama.cpp 正式版
//! (PR #22836)。官方发布的文件按 PR 早先的版本把它记成 42, 而 42 在正式版里已经是 Q2_0;
//! PR 现在用 43, 我们打的补丁也是 43。下载校验后把 42 改成 43 (见 mod.rs 的 `ModelFile::retype`)。
//! 改写是幂等的: 已经是目标编号的张量算作已完成, 再跑一次什么都不改。

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;

const MAGIC: &[u8; 4] = b"GGUF";
/// 键值与张量信息再多也不会超过这些 (Hy-MT2 的文件头约 7MB, 主要是词表)
const MAX_COUNT: u64 = 1 << 24;
const MAX_STR: u64 = 1 << 24;

struct Reader<R> {
    inner: R,
    pos: u64,
}

impl<R: Read> Reader<R> {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], String> {
        let mut buf = [0u8; N];
        self.inner.read_exact(&mut buf).map_err(|e| format!("GGUF 文件头不完整: {e}"))?;
        self.pos += N as u64;
        Ok(buf)
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.bytes::<4>()?))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.bytes::<8>()?))
    }
    fn skip(&mut self, n: u64) -> Result<(), String> {
        let copied = std::io::copy(&mut (&mut self.inner).take(n), &mut std::io::sink()).map_err(|e| format!("读取失败: {e}"))?;
        if copied != n {
            return Err("GGUF 文件头不完整".into());
        }
        self.pos += n;
        Ok(())
    }
    fn skip_str(&mut self) -> Result<(), String> {
        let n = self.u64()?;
        if n > MAX_STR {
            return Err("GGUF 文件头格式不对".into());
        }
        self.skip(n)
    }
    fn skip_value(&mut self, ty: u32) -> Result<(), String> {
        match ty {
            0 | 1 | 7 => self.skip(1),
            2 | 3 => self.skip(2),
            4..=6 => self.skip(4),
            10..=12 => self.skip(8),
            8 => self.skip_str(),
            9 => {
                let elem = self.u32()?;
                let n = self.u64()?;
                if n > MAX_COUNT || elem == 9 {
                    return Err("GGUF 文件头格式不对".into());
                }
                for _ in 0..n {
                    self.skip_value(elem)?;
                }
                Ok(())
            }
            _ => Err(format!("GGUF 文件头里有未知的值类型 {ty}")),
        }
    }
}

/// 找出所有张量类型字段的位置与当前编号
fn tensor_types(path: &Path) -> Result<Vec<(u64, u32)>, String> {
    let file = File::open(path).map_err(|e| format!("打开模型失败: {e}"))?;
    let mut r = Reader { inner: BufReader::with_capacity(1 << 20, file), pos: 0 };
    if &r.bytes::<4>()? != MAGIC {
        return Err("不是 GGUF 文件".into());
    }
    let version = r.u32()?;
    if version < 2 {
        return Err(format!("不支持的 GGUF 版本 {version}"));
    }
    let n_tensors = r.u64()?;
    let n_kv = r.u64()?;
    if n_tensors > MAX_COUNT || n_kv > MAX_COUNT {
        return Err("GGUF 文件头格式不对".into());
    }
    for _ in 0..n_kv {
        r.skip_str()?;
        let ty = r.u32()?;
        r.skip_value(ty)?;
    }
    let mut out = Vec::with_capacity(n_tensors as usize);
    for _ in 0..n_tensors {
        r.skip_str()?;
        let dims = r.u32()?;
        if dims > 8 {
            return Err("GGUF 文件头格式不对".into());
        }
        r.skip(8 * dims as u64)?;
        let at = r.pos;
        let ty = r.u32()?;
        r.u64()?; // 数据偏移
        out.push((at, ty));
    }
    Ok(out)
}

/// 把类型编号为 `from` 的张量改成 `to`; 返回改了几个。
/// 一个都没有、也没有已经是 `to` 的张量时报错 (多半是下错了文件)。
pub(crate) fn retype(path: &Path, from: u32, to: u32) -> Result<usize, String> {
    let types = tensor_types(path)?;
    let pending: Vec<u64> = types.iter().filter(|(_, ty)| *ty == from).map(|(at, _)| *at).collect();
    if pending.is_empty() {
        return if types.iter().any(|(_, ty)| *ty == to) { Ok(0) } else { Err(format!("模型文件里没有类型 {from} 的张量")) };
    }
    let mut file = std::fs::OpenOptions::new().write(true).open(path).map_err(|e| format!("打开模型失败: {e}"))?;
    for at in &pending {
        file.seek(SeekFrom::Start(*at)).map_err(|e| format!("写入模型失败: {e}"))?;
        file.write_all(&to.to_le_bytes()).map_err(|e| format!("写入模型失败: {e}"))?;
    }
    file.sync_all().map_err(|e| format!("写入模型失败: {e}"))?;
    Ok(pending.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(out: &mut Vec<u8>, text: &str) {
        out.extend((text.len() as u64).to_le_bytes());
        out.extend(text.as_bytes());
    }

    /// 造一个小 GGUF: 几种键值 (含字符串数组) + 三个张量, 类型分别为 0 / 42 / 42, 后面跟假数据
    fn sample() -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(b"GGUF");
        b.extend(3u32.to_le_bytes());
        b.extend(3u64.to_le_bytes()); // 张量数
        b.extend(4u64.to_le_bytes()); // 键值数
        s(&mut b, "general.architecture");
        b.extend(8u32.to_le_bytes());
        s(&mut b, "hunyuan-dense");
        s(&mut b, "general.file_type");
        b.extend(4u32.to_le_bytes());
        b.extend(41u32.to_le_bytes());
        s(&mut b, "general.sampling.temp");
        b.extend(6u32.to_le_bytes());
        b.extend(0.7f32.to_le_bytes());
        s(&mut b, "tokenizer.ggml.tokens");
        b.extend(9u32.to_le_bytes());
        b.extend(8u32.to_le_bytes());
        b.extend(2u64.to_le_bytes());
        s(&mut b, "a");
        s(&mut b, "<|bos|>");
        for (name, ty) in [("output_norm.weight", 0u32), ("blk.0.attn_k.weight", 42), ("blk.0.attn_q.weight", 42)] {
            s(&mut b, name);
            b.extend(2u32.to_le_bytes());
            b.extend(2048u64.to_le_bytes());
            b.extend(512u64.to_le_bytes());
            b.extend(ty.to_le_bytes());
            b.extend(0u64.to_le_bytes());
        }
        b.extend([0xAB; 64]);
        b
    }

    fn write(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("lightread-gguf-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn retypes_only_the_tensor_type_fields() {
        let original = sample();
        let path = write("retype", &original);
        assert_eq!(retype(&path, 42, 43).unwrap(), 2);
        let after = std::fs::read(&path).unwrap();
        assert_eq!(after.len(), original.len());
        // 只有两个张量的类型字段变了, 每处 1 字节 (42 → 43), 键值里的 41 和数据不动
        let diff: Vec<usize> = (0..after.len()).filter(|i| after[*i] != original[*i]).collect();
        assert_eq!(diff.len(), 2);
        assert!(diff.iter().all(|i| original[*i] == 42 && after[*i] == 43));
        assert_eq!(tensor_types(&path).unwrap().iter().map(|t| t.1).collect::<Vec<_>>(), vec![0, 43, 43]);
        // 幂等: 再跑一次什么都不改
        assert_eq!(retype(&path, 42, 43).unwrap(), 0);
        assert_eq!(std::fs::read(&path).unwrap(), after);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn rejects_wrong_files() {
        let path = write("none", &sample());
        // 没有类型 40 也没有 44: 下错文件了
        assert!(retype(&path, 40, 44).is_err());
        let _ = std::fs::remove_file(&path);

        let path = write("magic", b"GGML\x03\0\0\0");
        assert!(retype(&path, 42, 43).is_err());
        let _ = std::fs::remove_file(&path);

        let mut cut = sample();
        cut.truncate(90);
        let path = write("cut", &cut);
        assert!(retype(&path, 42, 43).is_err());
        let _ = std::fs::remove_file(path);
    }

    /// 真实文件: LOCAL_LLM_RETYPE_TEST=<Hy-MT2-1.8B-1.25Bit.gguf 的副本> (会被原地改写)
    #[test]
    #[ignore]
    fn retypes_the_real_model() {
        let Ok(path) = std::env::var("LOCAL_LLM_RETYPE_TEST") else { return };
        let path = std::path::PathBuf::from(path);
        let n = retype(&path, 42, 43).unwrap();
        println!("retyped {n} tensors");
        let types = tensor_types(&path).unwrap();
        assert_eq!(types.len(), 354);
        assert_eq!(types.iter().filter(|t| t.1 == 43).count(), 224);
    }
}
