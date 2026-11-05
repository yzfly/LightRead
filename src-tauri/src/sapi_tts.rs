//! Windows SAPI 5 语音: 枚举本机注册的语音, 把文本合成为 WAV 交给前端播放。
//! 枚举的是 HKLM/HKCU 下 Speech\Voices 的语音, 包含系统语音、第三方语音和 NaturalVoiceSAPIAdapter 注册的自然语音。
//! 64 位应用只能看到 64 位注册的语音。其他平台返回空列表。

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SapiVoice {
    pub id: String,
    pub name: String,
    pub language: String,
}

/// 合成上限: 适配器的在线语音可能卡在网络上, 不能让听书一直等
#[cfg(windows)]
const SYNTH_TIMEOUT_SECS: u64 = 60;

/// SAPI 语速是 -10..10 的对数刻度: +10 约 3 倍速, -10 约 1/3 倍速
#[cfg_attr(not(windows), allow(dead_code))]
fn sapi_rate(rate: f64) -> i32 {
    if !rate.is_finite() || rate <= 0.0 {
        return 0;
    }
    ((rate.ln() / 3f64.ln()) * 10.0).round().clamp(-10.0, 10.0) as i32
}

/// PCM 数据加上 44 字节 WAV 头
#[cfg_attr(not(windows), allow(dead_code))]
fn wav_bytes(pcm: &[u8], sample_rate: u32, channels: u16, bits: u16) -> Vec<u8> {
    let block = channels * bits / 8;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * block as u32).to_le_bytes());
    out.extend_from_slice(&block.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// 注册表里的语言是十六进制 LCID, 可能有多个 (`804;409`), 取第一个并转成语言标记
#[cfg_attr(not(windows), allow(dead_code))]
fn language_tag(lcid: &str) -> String {
    let first = lcid.split(';').next().unwrap_or("").trim();
    match u32::from_str_radix(first, 16).unwrap_or(0) {
        0x804 => "zh-CN".into(),
        0x404 => "zh-TW".into(),
        0xC04 => "zh-HK".into(),
        0x409 => "en-US".into(),
        0x809 => "en-GB".into(),
        0x411 => "ja-JP".into(),
        0x412 => "ko-KR".into(),
        _ => String::new(),
    }
}

#[cfg(windows)]
mod imp {
    use super::{language_tag, sapi_rate, wav_bytes, SapiVoice};
    use windows::core::{w, Interface, GUID, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Media::Audio::WAVEFORMATEX;
    use windows::Win32::Media::Speech::{
        IEnumSpObjectTokens, ISpObjectToken, ISpObjectTokenCategory, ISpStream, ISpVoice, SpObjectTokenCategory,
        SpStream, SpVoice, SPCAT_VOICES, SPF_IS_NOT_XML, SPF_PURGEBEFORESPEAK,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IStream, CLSCTX_ALL, COINIT_MULTITHREADED,
        STREAM_SEEK_SET,
    };
    use windows::Win32::UI::Shell::SHCreateMemStream;

    const SAMPLE_RATE: u32 = 24_000;
    const WAVE_FORMAT_PCM: u16 = 1;
    /// sapi.h 的 SPDFID_WaveFormatEx; windows 库没有导出这个常量
    const SPDFID_WAVE_FORMAT_EX: GUID = GUID::from_u128(0xC31ADBAE_527F_4FF5_A230_F62BB61FF70C);

    /// COM 按线程初始化; 每次调用都在独立的阻塞线程上进行
    struct Com;
    impl Com {
        fn init() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .map_err(|e| format!("COM 初始化失败: {e}"))?;
            Ok(Com)
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    fn take_string(value: PWSTR) -> String {
        if value.is_null() {
            return String::new();
        }
        let text = unsafe { value.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(value.0 as *const _)) };
        text
    }

    fn tokens() -> Result<Vec<ISpObjectToken>, String> {
        let message = |e: windows::core::Error| format!("读取语音列表失败: {e}");
        unsafe {
            let category: ISpObjectTokenCategory =
                CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL).map_err(message)?;
            category.SetId(SPCAT_VOICES, false).map_err(message)?;
            let list: IEnumSpObjectTokens = category.EnumTokens(PCWSTR::null(), PCWSTR::null()).map_err(message)?;
            let mut out = Vec::new();
            loop {
                let mut slot: [Option<ISpObjectToken>; 1] = [None];
                let mut fetched = 0u32;
                let result = list.Next(1, slot.as_mut_ptr() as *mut _, Some(&mut fetched));
                if result.is_err() || fetched == 0 {
                    break;
                }
                if let Some(token) = slot[0].take() {
                    out.push(token);
                }
            }
            Ok(out)
        }
    }

    fn describe(token: &ISpObjectToken) -> Option<SapiVoice> {
        unsafe {
            let id = take_string(token.GetId().ok()?);
            let name = take_string(token.GetStringValue(PCWSTR::null()).ok()?);
            let language = token
                .OpenKey(w!("Attributes"))
                .and_then(|key| key.GetStringValue(w!("Language")))
                .map(take_string)
                .map(|lcid| language_tag(&lcid))
                .unwrap_or_default();
            Some(SapiVoice { id, name, language })
        }
    }

    pub fn list() -> Result<Vec<SapiVoice>, String> {
        let _com = Com::init()?;
        Ok(tokens()?.iter().filter_map(describe).collect())
    }

    pub fn synthesize(text: &str, voice_id: &str, rate: f64) -> Result<Vec<u8>, String> {
        let _com = Com::init()?;
        let message = |e: windows::core::Error| format!("SAPI 合成失败: {e}");
        unsafe {
            let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_ALL).map_err(message)?;
            if !voice_id.is_empty() {
                let token = tokens()?
                    .into_iter()
                    .find(|t| t.GetId().map(take_string).is_ok_and(|id| id == voice_id))
                    .ok_or_else(|| "这个 SAPI 语音已不存在".to_string())?;
                voice.SetVoice(&token).map_err(message)?;
            }
            voice.SetRate(sapi_rate(rate)).map_err(message)?;

            let memory: IStream = SHCreateMemStream(None).ok_or("创建内存流失败")?;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_PCM,
                nChannels: 1,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * 2,
                nBlockAlign: 2,
                wBitsPerSample: 16,
                cbSize: 0,
            };
            let stream: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL).map_err(message)?;
            stream
                .SetBaseStream(&memory, &SPDFID_WAVE_FORMAT_EX, &format)
                .map_err(message)?;
            voice.SetOutput(&stream.cast::<windows::core::IUnknown>().map_err(message)?, true).map_err(message)?;

            let text = HSTRING::from(text);
            let flags = (SPF_IS_NOT_XML.0 | SPF_PURGEBEFORESPEAK.0) as u32;
            voice.Speak(PCWSTR(text.as_ptr()), flags, None).map_err(message)?;

            memory.Seek(0, STREAM_SEEK_SET, None).map_err(message)?;
            let mut pcm = Vec::new();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let mut read = 0u32;
                let result = memory.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read));
                result.ok().map_err(message)?;
                if read == 0 {
                    break;
                }
                pcm.extend_from_slice(&buf[..read as usize]);
            }
            if pcm.is_empty() {
                return Err("SAPI 语音没有输出音频".into());
            }
            Ok(wav_bytes(&pcm, SAMPLE_RATE, 1, 16))
        }
    }
}

/// 本机已注册的 SAPI 5 语音; 非 Windows 平台为空
#[tauri::command]
pub async fn sapi_tts_voices() -> Result<Vec<SapiVoice>, String> {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(imp::list).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// 合成一段文本, 返回 WAV 字节流; voice 为空时用系统默认语音
#[tauri::command]
pub async fn sapi_tts_synthesize(text: String, voice: String, rate: f64) -> Result<tauri::ipc::Response, String> {
    #[cfg(windows)]
    {
        let task = tokio::task::spawn_blocking(move || imp::synthesize(&text, &voice, rate));
        let wav = tokio::time::timeout(std::time::Duration::from_secs(SYNTH_TIMEOUT_SECS), task)
            .await
            .map_err(|_| "SAPI 语音合成超时".to_string())?
            .map_err(|e| e.to_string())??;
        Ok(tauri::ipc::Response::new(wav))
    }
    #[cfg(not(windows))]
    {
        let _ = (text, voice, rate);
        Err("SAPI 语音只在 Windows 上可用".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_uses_sapi_log_scale() {
        assert_eq!(sapi_rate(1.0), 0);
        assert_eq!(sapi_rate(3.0), 10);
        assert_eq!(sapi_rate(1.0 / 3.0), -10);
        assert_eq!(sapi_rate(9.0), 10);
        assert_eq!(sapi_rate(0.0), 0);
    }

    #[test]
    fn wav_header_describes_pcm() {
        let wav = wav_bytes(&[1, 2, 3, 4], 24_000, 1, 16);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 40);
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 48_000);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 4);
        assert_eq!(wav.len(), 48);
    }

    #[test]
    fn language_reads_first_lcid() {
        assert_eq!(language_tag("804"), "zh-CN");
        assert_eq!(language_tag("804;409"), "zh-CN");
        assert_eq!(language_tag("zz"), "");
    }
}
