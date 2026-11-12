//! 变速不变调 (WSOLA): 本机语音模型没有语速参数, 合成后按听书的语速设置拉伸或压缩波形。
//! 只处理 16-bit 单声道 PCM (语音模型的输出格式); 纯函数, 全平台编译。
#![cfg_attr(not(llm_engine), allow(dead_code))]

/// 每帧 30ms, 相邻帧重叠 10ms, 在 ±8ms 内找最接得上的位置
const FRAME_MS: usize = 30;
const OVERLAP_MS: usize = 10;
const SEARCH_MS: usize = 8;

/// 把语音加快 (speed > 1) 或放慢 (speed < 1), 音高不变。接近 1 或太短的输入原样返回。
pub(crate) fn time_stretch(input: &[i16], sample_rate: u32, speed: f32) -> Vec<i16> {
    let sr = sample_rate as usize;
    let frame = sr * FRAME_MS / 1000;
    let overlap = sr * OVERLAP_MS / 1000;
    let search = sr * SEARCH_MS / 1000;
    if !speed.is_finite() || (speed - 1.0).abs() < 0.02 || overlap == 0 || input.len() < frame * 4 {
        return input.to_vec();
    }
    let speed = speed.clamp(0.5, 3.0);
    let hop_out = frame - overlap;
    let hop_in = hop_out as f32 * speed;
    let last_start = input.len() - frame;

    let mut out: Vec<f32> = Vec::with_capacity((input.len() as f32 / speed) as usize + frame);
    out.extend(input[..frame].iter().map(|s| *s as f32));
    let mut prev = 0usize;
    let mut k = 1usize;
    loop {
        let ideal = (k as f32 * hop_in) as usize;
        if ideal + search > last_start {
            break;
        }
        // 上一帧在原音频里「自然接下去」的那一小段, 就是已输出部分的末尾; 新的一帧要从最像它的地方起
        let template = &input[prev + hop_out..prev + frame];
        let lo = ideal.saturating_sub(search);
        let hi = (ideal + search).min(last_start);
        let pos = best_match(input, template, lo, hi);
        append_frame(&mut out, &input[pos..pos + frame], overlap);
        prev = pos;
        k += 1;
    }
    // 收尾: 把原音频的最后一帧接上, 免得句尾的收音被截掉
    if last_start > prev + overlap {
        append_frame(&mut out, &input[last_start..], overlap);
    }
    out.iter().map(|s| s.round().clamp(i16::MIN as f32, i16::MAX as f32) as i16).collect()
}

/// [lo, hi] 里与 template 归一化互相关最大的起点
fn best_match(input: &[i16], template: &[i16], lo: usize, hi: usize) -> usize {
    let mut best = lo;
    let mut best_score = f32::MIN;
    for pos in lo..=hi {
        let candidate = &input[pos..pos + template.len()];
        let mut dot = 0.0f32;
        let mut energy = 1.0f32;
        for (a, b) in candidate.iter().zip(template) {
            let a = *a as f32;
            dot += a * *b as f32;
            energy += a * a;
        }
        let score = dot / energy.sqrt();
        if score > best_score {
            best_score = score;
            best = pos;
        }
    }
    best
}

/// 把一帧接到输出末尾: 前 overlap 个采样与已有的末尾线性交叠, 其余直接追加
fn append_frame(out: &mut Vec<f32>, frame: &[i16], overlap: usize) {
    let tail = out.len() - overlap;
    for i in 0..overlap {
        let w = (i + 1) as f32 / (overlap + 1) as f32;
        out[tail + i] = out[tail + i] * (1.0 - w) + frame[i] as f32 * w;
    }
    out.extend(frame[overlap..].iter().map(|s| *s as f32));
}

/// 取出 WAV 里的 16-bit 单声道 PCM 与采样率; 其他格式返回 None
pub(crate) fn parse_wav(bytes: &[u8]) -> Option<(u32, Vec<i16>)> {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let mut pos = 12;
    let mut format: Option<(u32, u16, u16, u16)> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32_at(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            format = Some((u32_at(body + 4), u16_at(body), u16_at(body + 2), u16_at(body + 14)));
        } else if id == b"data" {
            let (rate, tag, channels, bits) = format?;
            if tag != 1 || channels != 1 || bits != 16 {
                return None;
            }
            // 流式写出的 WAV 可能把长度写成 0 或超出文件: 以实际剩余为准
            let end = body.saturating_add(size).min(bytes.len());
            let end = if size == 0 { bytes.len() } else { end };
            let samples = bytes[body..end].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
            return Some((rate, samples));
        }
        pos = body + size + (size & 1);
    }
    None
}

pub(crate) fn write_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + samples.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    wav
}

/// 按语速处理一段 WAV; 语速接近 1 或格式不认识时原样返回
pub(crate) fn stretch_wav(wav: Vec<u8>, speed: f32) -> Vec<u8> {
    if !speed.is_finite() || (speed - 1.0).abs() < 0.02 {
        return wav;
    }
    match parse_wav(&wav) {
        Some((rate, samples)) => write_wav(&time_stretch(&samples, rate, speed), rate),
        None => wav,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 24_000;

    /// 带一点谐波与起伏的 220Hz 音, 像一段元音
    fn tone(seconds: f32) -> Vec<i16> {
        (0..(seconds * SR as f32) as usize)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let w = std::f32::consts::TAU * 220.0 * t;
                let envelope = 0.7 + 0.3 * (std::f32::consts::TAU * 3.0 * t).sin();
                ((w.sin() + 0.3 * (2.0 * w).sin()) * envelope * 9000.0) as i16
            })
            .collect()
    }

    /// 基频: 每秒由负到正的过零次数
    fn pitch(samples: &[i16]) -> f32 {
        let rising = samples.windows(2).filter(|w| w[0] < 0 && w[1] >= 0).count();
        rising as f32 * SR as f32 / samples.len() as f32
    }

    #[test]
    fn faster_and_slower_change_length_but_not_pitch() {
        let input = tone(2.0);
        assert!((pitch(&input) - 220.0).abs() < 3.0);
        for speed in [0.75f32, 1.25, 1.5, 2.0] {
            let out = time_stretch(&input, SR, speed);
            let ratio = input.len() as f32 / out.len() as f32;
            assert!((ratio - speed).abs() < speed * 0.04, "speed {speed}: length ratio {ratio}");
            assert!((pitch(&out) - 220.0).abs() < 5.0, "speed {speed}: pitch {}", pitch(&out));
            // 没有爆音: 相邻采样的跳变不超过原信号的最大跳变太多
            let jump = |s: &[i16]| s.windows(2).map(|w| (w[1] as i32 - w[0] as i32).abs()).max().unwrap();
            assert!(jump(&out) <= jump(&input) * 2, "speed {speed}: click {} vs {}", jump(&out), jump(&input));
        }
    }

    #[test]
    fn unit_speed_and_tiny_inputs_pass_through() {
        let input = tone(1.0);
        assert_eq!(time_stretch(&input, SR, 1.0), input);
        assert_eq!(time_stretch(&input, SR, 1.01), input);
        assert_eq!(time_stretch(&input, SR, f32::NAN), input);
        let tiny = tone(0.05);
        assert_eq!(time_stretch(&tiny, SR, 1.5), tiny);
        assert!(time_stretch(&[], SR, 1.5).is_empty());
    }

    #[test]
    fn the_end_of_the_sentence_is_kept() {
        // 末尾 20ms 是与前面不同的高音: 变速后末尾仍然是它
        let mut input = tone(1.0);
        let n = input.len();
        for (i, s) in input[n - 480..].iter_mut().enumerate() {
            *s = ((std::f32::consts::TAU * 2000.0 * i as f32 / SR as f32).sin() * 9000.0) as i16;
        }
        let out = time_stretch(&input, SR, 1.5);
        assert_eq!(out[out.len() - 200..], input[n - 200..]);
    }

    #[test]
    fn wav_round_trips_and_odd_headers_are_tolerated() {
        let samples = tone(0.5);
        let wav = write_wav(&samples, SR);
        assert_eq!(parse_wav(&wav), Some((SR, samples.clone())));
        // 长度字段为 0 (流式写出): 取到文件末尾
        let mut streamed = wav.clone();
        streamed[40..44].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_wav(&streamed).unwrap().1.len(), samples.len());
        // fmt 与 data 之间夹着别的块
        let mut extra = wav[..36].to_vec();
        extra.extend_from_slice(b"LIST\x04\x00\x00\x00abcd");
        extra.extend_from_slice(&wav[36..]);
        assert_eq!(parse_wav(&extra), Some((SR, samples.clone())));
        assert_eq!(parse_wav(b"not a wav"), None);
        // 立体声不处理
        let mut stereo = wav.clone();
        stereo[22] = 2;
        assert_eq!(parse_wav(&stereo), None);
        assert_eq!(stretch_wav(stereo.clone(), 1.5), stereo, "不认识的格式原样返回");

        let faster = stretch_wav(wav.clone(), 1.5);
        let (rate, out) = parse_wav(&faster).unwrap();
        assert_eq!(rate, SR);
        assert!(out.len() < samples.len() * 3 / 4);
        assert_eq!(stretch_wav(wav.clone(), 1.0), wav);
    }
}
