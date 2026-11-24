//! TXT (正文类) → EPUB 的原生实现, 与 src/services/textToEpub.ts 的 TXT 分支逐字节一致.
//!
//! 以前每次打开 TXT 都在 WebView 里解码、分章、拼 XHTML、打包 (30 MB 约 0.6 s, 且整本在 JS 内存里两份)。
//! 现在桌面由 Rust 转换一次并缓存在书库 (`books/<id>.txt.v<版式>.epub`), 之后直接读缓存。
//! 代码 / 配置类 TXT (代码视图)、Markdown、HTML 仍走前端 (依赖 marked / DOMParser)。
//!
//! 与 JS 对齐的细节 (改动时两边一起改, 由 testdata/txt-epub-golden 回归):
//!  - 解码: UTF-16 BOM → 对应 UTF-16; 否则严格 UTF-8 (去 BOM), 失败按 GB18030 (encoding_rs = WHATWG, 与 TextDecoder 同规范)
//!  - 空白: JS 的 `trim()` / `\s` 含 U+FEFF、不含 U+0085, 与 Rust 的 `char::is_whitespace` 不同, 这里按 JS 集合
//!  - 长度: `.{0,40}` 与分节上限按 UTF-16 码元计数 (JS 字符串长度)
//!  - CHAPTER_RE 的前瞻 `(?=$|…)` 改为: 正则匹配开头 + 手工检查后续 (后续只受上限约束, 取最长开头即等价)

use std::path::Path;

use regex::Regex;

use crate::backup_zip::{write_zip, Source};

/// 与 textToEpub.ts 的 TEXT_EPUB_LAYOUT 一致; 变化时缓存文件名随之变化
pub const LAYOUT: &str = "3";
/// txtParagraphs.ts SECTION_CHARS
const SECTION_CHARS: usize = 40_000;
const MIN_LINES: usize = 20;

/// JS `\s` / `String.prototype.trim` 的空白集合
fn js_space(c: char) -> bool {
  matches!(c,
    '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
    | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}
fn js_trim(s: &str) -> &str {
  s.trim_matches(js_space)
}
fn utf16_len(s: &str) -> usize {
  s.chars().map(char::len_utf16).sum()
}

/// textToEpub.ts decodeText
pub fn decode_text(bytes: &[u8]) -> String {
  if bytes.starts_with(&[0xFF, 0xFE]) {
    return encoding_rs::UTF_16LE.decode_with_bom_removal(bytes).0.into_owned();
  }
  if bytes.starts_with(&[0xFE, 0xFF]) {
    return encoding_rs::UTF_16BE.decode_with_bom_removal(bytes).0.into_owned();
  }
  match std::str::from_utf8(bytes) {
    Ok(s) => s.strip_prefix('\u{FEFF}').unwrap_or(s).to_string(),
    Err(_) => legacy_chinese_encoding(bytes).decode_without_bom_handling(bytes).0.into_owned(),
  }
}

/// textToEpub.ts COMMON_HAN: 简繁写法相同的高频汉字
const COMMON_HAN: &str = "的一是不了人在有我他中大上也之而以其子曰天下可于所此心又得出去自己日月山水小生如知道行年同手今已者十三五百千里外好老看王主乎";
const LEGACY_SAMPLE_BYTES: usize = 64 * 1024;

/// textToEpub.ts legacyChineseEncoding: 不是 UTF-8 时在 GB18030 (大陆 GBK) 与 Big5 (港台) 里挑更像中文的
fn legacy_chinese_encoding(bytes: &[u8]) -> &'static encoding_rs::Encoding {
  let sample = &bytes[..bytes.len().min(LEGACY_SAMPLE_BYTES)];
  let score = |encoding: &'static encoding_rs::Encoding| {
    let (text, _) = encoding.decode_without_bom_handling(sample);
    text.chars().filter(|c| COMMON_HAN.contains(*c)).count()
  };
  if score(encoding_rs::BIG5) > score(encoding_rs::GB18030) {
    encoding_rs::BIG5
  } else {
    encoding_rs::GB18030
  }
}

fn escape_xml(s: &str) -> String {
  s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// JS encodeURIComponent
fn encode_uri_component(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  for b in s.bytes() {
    if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
      out.push(b as char);
    } else {
      out.push_str(&format!("%{b:02X}"));
    }
  }
  out
}

// ---------------- smartToc.ts CHAPTER_RE ----------------

const WS: &str = r"[\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

struct ChapterRe {
  /// 前两种开头 (第…章 / Chapter N): 其后 `.{0,40}$`
  plain: Regex,
  /// 第三种 (序章 / 番外…): 其后必须是结尾或分隔符, 再 `.{0,40}$`
  special: Regex,
}

impl ChapterRe {
  fn new() -> Self {
    let plain = format!(
      r"^{WS}*(?:第{WS}*[0-9０-９一二三四五六七八九十百千万零两〇○]+{WS}*[章节卷回部集话]|(?:Chapter|CHAPTER|Part|PART){WS}+[0-9IVXLC]+)"
    );
    let special = format!(r"^{WS}*(?:序章|序言|楔子|前言|引子|后记|尾声|终章|番外(?:篇)?[0-9一二三四五六七八九十]*)");
    ChapterRe { plain: Regex::new(&plain).unwrap(), special: Regex::new(&special).unwrap() }
  }

  /// JS `.` 不匹配换行类字符; `.{0,40}` 按 UTF-16 码元计
  fn tail_ok(rest: &str) -> bool {
    !rest.contains(['\n', '\r', '\u{2028}', '\u{2029}']) && utf16_len(rest) <= 40
  }

  fn test(&self, line: &str) -> bool {
    if let Some(m) = self.plain.find(line) {
      if Self::tail_ok(&line[m.end()..]) {
        return true;
      }
    }
    if let Some(m) = self.special.find(line) {
      let rest = &line[m.end()..];
      let sep_ok = match rest.chars().next() {
        None => true,
        Some(c) => js_space(c) || matches!(c, ':' | '：' | '·' | '—' | '-' | '、' | '.'),
      };
      return sep_ok && Self::tail_ok(rest);
    }
    false
  }
}

// ---------------- txtParagraphs.ts ----------------

/// JS 的 [⺀-鿿豈-﫿＀-￯　-〿]; 最后一段 (U+3000–303F) 已含在第一段里
fn is_cjk(c: char) -> bool {
  matches!(c, '\u{2E80}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}' | '\u{FF00}'..='\u{FFEF}')
}

fn visual_width(line: &str) -> usize {
  line.chars().map(|c| if is_cjk(c) { 2 } else { 1 }).sum()
}

fn quantile(sorted: &[usize], q: f64) -> usize {
  sorted[(sorted.len() - 1).min((sorted.len() as f64 * q).floor() as usize)]
}

/// INDENTED_RE = /^(?:　|\s{2,})/
fn indented(line: &str) -> bool {
  let mut it = line.chars();
  match it.next() {
    Some('\u{3000}') => true,
    Some(c) if js_space(c) => it.next().is_some_and(js_space),
    _ => false,
  }
}

fn split_blocks<'a>(lines: &[&'a str]) -> Vec<Vec<&'a str>> {
  let mut blocks = Vec::new();
  let mut cur: Vec<&str> = Vec::new();
  for &line in lines {
    let blank = js_trim(line).is_empty();
    if blank || indented(line) {
      if !cur.is_empty() {
        blocks.push(std::mem::take(&mut cur));
      }
    }
    if !blank {
      cur.push(line);
    }
  }
  if !cur.is_empty() {
    blocks.push(cur);
  }
  blocks
}

fn looks_hard_wrapped(lines: &[&str]) -> bool {
  let blocks = split_blocks(lines);
  let non_empty: usize = blocks.iter().map(Vec::len).sum();
  if non_empty < MIN_LINES {
    return false;
  }
  let multi: Vec<&Vec<&str>> = blocks.iter().filter(|b| b.len() > 1).collect();
  let in_multi: usize = multi.iter().map(|b| b.len()).sum();
  if (in_multi as f64) / (non_empty as f64) < 0.5 {
    return false;
  }
  let mut sizes: Vec<usize> = multi.iter().map(|b| b.len()).collect();
  sizes.sort_unstable();
  if quantile(&sizes, 0.5) > 20 {
    return false;
  }
  let mut widths: Vec<usize> = multi.iter().flat_map(|b| b[..b.len() - 1].iter()).map(|l| visual_width(js_trim(l))).collect();
  widths.sort_unstable();
  if widths.len() < MIN_LINES / 2 {
    return false;
  }
  let (p25, p50, p75) = (quantile(&widths, 0.25), quantile(&widths, 0.5), quantile(&widths, 0.75));
  (40..=160).contains(&p50) && ((p75 - p25) as f64) / (p50 as f64) <= 0.25
}

/// JS 取的是 UTF-16 首尾码元; 代理对码元不在 CJK 区间, 与按字符判断结果相同
fn join_lines(a: &str, b: &str) -> String {
  let last = a.chars().last();
  let first = b.chars().next();
  if last == Some('-') || last.is_some_and(is_cjk) || first.is_some_and(is_cjk) {
    format!("{a}{b}")
  } else {
    format!("{a} {b}")
  }
}

fn to_paragraphs(lines: &[&str], hard_wrapped: bool) -> Vec<String> {
  if !hard_wrapped {
    return lines.iter().map(|l| js_trim(l)).filter(|l| !l.is_empty()).map(str::to_string).collect();
  }
  split_blocks(lines)
    .into_iter()
    .map(|block| {
      let mut it = block.into_iter().map(js_trim);
      let first = it.next().unwrap_or_default().to_string();
      it.fold(first, |acc, l| join_lines(&acc, l))
    })
    .collect()
}

// ---------------- textToEpub.ts ----------------

struct Chapter {
  title: String,
  html: String,
}

fn finish_chapter(title: &str, lines: &[&str], wrapped: bool) -> Chapter {
  let paras: Vec<String> = to_paragraphs(lines, wrapped).iter().map(|l| format!("<p>{}</p>", escape_xml(l))).collect();
  Chapter { title: title.to_string(), html: format!("<h2>{}</h2>\n{}", escape_xml(title), paras.join("\n")) }
}

/// JS `text.split(/\r\n?|\n/)`
fn split_lines(text: &str) -> Vec<&str> {
  let mut out = Vec::new();
  let bytes = text.as_bytes();
  let (mut start, mut i) = (0, 0);
  while i < bytes.len() {
    match bytes[i] {
      b'\r' => {
        out.push(&text[start..i]);
        i += if bytes.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
        start = i;
      }
      b'\n' => {
        out.push(&text[start..i]);
        i += 1;
        start = i;
      }
      _ => i += 1,
    }
  }
  out.push(&text[start..]);
  out
}

fn split_txt_chapters(text: &str, fallback_title: &str) -> Vec<Chapter> {
  let re = ChapterRe::new();
  let lines = split_lines(text);
  let wrapped = looks_hard_wrapped(&lines);
  let mut chapters = Vec::new();
  let mut current: Option<(String, Vec<&str>)> = None;
  let mut preface: Vec<&str> = Vec::new();
  for &line in &lines {
    if re.test(line) {
      if let Some((title, body)) = current.take() {
        chapters.push(finish_chapter(&title, &body, wrapped));
      } else if preface.iter().any(|l| !js_trim(l).is_empty()) {
        chapters.push(finish_chapter("开篇", &preface, wrapped));
      }
      current = Some((js_trim(line).to_string(), Vec::new()));
    } else if let Some((_, body)) = current.as_mut() {
      body.push(line);
    } else {
      preface.push(line);
    }
  }
  if let Some((title, body)) = current {
    chapters.push(finish_chapter(&title, &body, wrapped));
  }
  if chapters.is_empty() {
    // 无章节结构: 每 300 段切一块 (段落已经 trim, 不再按硬换行合并)
    let paras = to_paragraphs(&lines, wrapped);
    for chunk in paras.chunks(300) {
      let title = if chapters.is_empty() { fallback_title.to_string() } else { format!("{fallback_title} ({})", chapters.len() + 1) };
      let refs: Vec<&str> = chunk.iter().map(String::as_str).collect();
      chapters.push(finish_chapter(&title, &refs, false));
    }
  }
  if chapters.is_empty() {
    chapters.push(Chapter { title: fallback_title.to_string(), html: "<p>(空文件)</p>".into() });
  }
  chapters
}

/// txtParagraphs.ts packSections: 按 UTF-16 长度装分节, 返回每节的章下标
fn pack_sections(chapters: &[Chapter]) -> Vec<Vec<usize>> {
  let mut sections = Vec::new();
  let mut cur = Vec::new();
  let mut size = 0;
  for (i, c) in chapters.iter().enumerate() {
    let len = utf16_len(&c.html);
    if !cur.is_empty() && size + len > SECTION_CHARS {
      sections.push(std::mem::take(&mut cur));
      size = 0;
    }
    cur.push(i);
    size += len;
  }
  if !cur.is_empty() {
    sections.push(cur);
  }
  sections
}

const TXT_CSS: &str = include_str!("txt_epub.css");

/// JS `fileName.replace(/\.[^.]+$/, '')`
fn base_name(file_name: &str) -> &str {
  match file_name.rfind('.') {
    Some(i) if i + 1 < file_name.len() => &file_name[..i],
    _ => file_name,
  }
}

/// 生成 EPUB 各文件 (名字, 内容), 顺序与 JS 一致
pub fn txt_epub_entries(text: &str, file_name: &str) -> Vec<(String, String)> {
  let base = base_name(file_name);
  let chapters = split_txt_chapters(text, base);
  let sections = pack_sections(&chapters);
  let mut href = vec![String::new(); chapters.len()];
  for (j, sec) in sections.iter().enumerate() {
    for &i in sec {
      href[i] = format!("s{j}.xhtml#c{i}");
    }
  }
  let manifest = (0..sections.len())
    .map(|j| format!(r#"<item id="s{j}" href="s{j}.xhtml" media-type="application/xhtml+xml"/>"#))
    .collect::<Vec<_>>()
    .join("\n    ");
  let spine = (0..sections.len()).map(|j| format!(r#"<itemref idref="s{j}"/>"#)).collect::<Vec<_>>().join("\n    ");
  let nav_list = chapters
    .iter()
    .enumerate()
    .map(|(i, c)| format!(r#"<li><a href="{}">{}</a></li>"#, href[i], escape_xml(&c.title)))
    .collect::<Vec<_>>()
    .join("\n      ");
  let title = base;
  let opf = format!(
    r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:lights:{}</dc:identifier>
    <dc:title>{}</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">1970-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    {manifest}
  </manifest>
  <spine>
    {spine}
  </spine>
</package>"#,
    encode_uri_component(base),
    escape_xml(title)
  );
  let nav = format!(
    r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc"><h1>目录</h1>
    <ol>
      {nav_list}
    </ol>
  </nav>
</body>
</html>"#
  );
  let container = r#"<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
  let mut files = vec![
    ("mimetype".to_string(), "application/epub+zip".to_string()),
    ("META-INF/container.xml".to_string(), container.to_string()),
    ("OEBPS/content.opf".to_string(), opf),
    ("OEBPS/nav.xhtml".to_string(), nav),
    ("OEBPS/style.css".to_string(), TXT_CSS.to_string()),
  ];
  for (j, sec) in sections.iter().enumerate() {
    let body = sec
      .iter()
      .map(|&i| format!("<section class=\"chapter\" id=\"c{i}\">\n{}\n</section>", chapters[i].html))
      .collect::<Vec<_>>()
      .join("\n");
    let head_title = escape_xml(&chapters[sec[0]].title);
    files.push((
      format!("OEBPS/s{j}.xhtml"),
      format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<html xmlns=\"http://www.w3.org/1999/xhtml\">\n<head><title>{head_title}</title><link rel=\"stylesheet\" href=\"style.css\"/></head>\n<body>{body}</body>\n</html>"
      ),
    ));
  }
  files
}

/// 读 `src`, 写 store 模式 EPUB 到 `dest` (先 .part 再改名). 与 Tauri 无关, 便于单测.
pub fn txt_to_epub_file(src: &Path, dest: &Path, file_name: &str) -> Result<u64, String> {
  let bytes = std::fs::read(src).map_err(|e| format!("file: {e}"))?;
  let text = decode_text(&bytes);
  drop(bytes);
  let entries = txt_epub_entries(&text, file_name).into_iter().map(|(n, c)| (n, Source::Bytes(c.into_bytes()))).collect();
  let mut part = dest.as_os_str().to_owned();
  part.push(".part");
  let part = std::path::PathBuf::from(part);
  let result = std::fs::File::create(&part)
    .map_err(|e| format!("file: {e}"))
    .and_then(|f| write_zip(f, entries, u32::MAX as u64, |_| {}))
    .and_then(|size| std::fs::rename(&part, dest).map(|_| size).map_err(|e| format!("file: {e}")));
  if result.is_err() {
    let _ = std::fs::remove_file(&part);
  }
  result
}

/// 书库里的正文类 TXT (`rel`) → EPUB 缓存 `<rel>.v<版式>.epub`; 缓存不比原书旧时直接复用.
/// 返回缓存的书库相对路径. 旧版式的缓存顺手删掉.
#[tauri::command]
pub async fn txt_epub_cache<R: tauri::Runtime>(
  app: tauri::AppHandle<R>,
  root: String,
  rel: String,
  file_name: String,
) -> Result<String, String> {
  use crate::http_upload::{resolve_library_file, FileRef};
  use tauri::Manager;
  let cache_rel = format!("{rel}.v{LAYOUT}.epub");
  let app_data = app.path().app_data_dir().ok();
  let src = resolve_library_file(app_data.clone(), &FileRef { root: root.clone(), rel })?;
  let dest = resolve_library_file(app_data, &FileRef { root, rel: cache_rel.clone() })?;
  tauri::async_runtime::spawn_blocking(move || {
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let fresh = matches!((modified(&dest), modified(&src)), (Some(c), Some(o)) if c >= o);
    if !fresh {
      txt_to_epub_file(&src, &dest, &file_name)?;
      // 旧版式缓存: <书文件名>.v<其它>.epub
      if let (Some(dir), Some(name)) = (src.parent(), src.file_name().and_then(|n| n.to_str())) {
        let keep = dest.file_name().map(|n| n.to_os_string());
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
          let n = entry.file_name();
          let s = n.to_string_lossy();
          if s.starts_with(&format!("{name}.v")) && s.ends_with(".epub") && Some(&n) != keep.as_ref() {
            let _ = std::fs::remove_file(entry.path());
          }
        }
      }
    }
    Ok(cache_rel)
  })
  .await
  .map_err(|e| format!("file: {e}"))?
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn chapter_regex_matches_js_rules() {
    let re = ChapterRe::new();
    for yes in ["第一章 风起", "  第 12 节", "第３章", "Chapter IV The End", "PART 2", "序章", "番外篇3：后来", "楔子", "后记·", "尾声 - 完"] {
      assert!(re.test(yes), "{yes}");
    }
    for no in ["第一章", "序章之后的故事很长", "Chapter", "前言后语", "番外篇外", "正文"] {
      // "第一章" 本身是章标题 (开头匹配, 尾部为空), 单独校验
      if no == "第一章" {
        assert!(re.test(no));
        continue;
      }
      assert!(!re.test(no), "{no}");
    }
    // 尾部上限按 UTF-16 码元: 40 个 BMP 字符可以, 20 个表情 (各 2 码元) + 1 不行
    assert!(re.test(&format!("第1章{}", "字".repeat(40))));
    assert!(!re.test(&format!("第1章{}", "字".repeat(41))));
    assert!(re.test(&format!("第1章{}", "😀".repeat(20))));
    assert!(!re.test(&format!("第1章{}字", "😀".repeat(20))));
  }

  #[test]
  fn layout_version_matches_frontend() {
    // 缓存文件名带版式版本; 前端改了 TEXT_EPUB_LAYOUT 却没改这里时提醒
    assert!(include_str!("../../src/services/textToEpub.ts").contains(&format!("TEXT_EPUB_LAYOUT = '{LAYOUT}'")));
  }

  #[test]
  fn js_whitespace_semantics() {
    assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
    assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    assert!(indented("\u{3000}x") && indented("  x") && !indented(" x"));
  }

  #[test]
  fn decodes_like_text_decoder() {
    assert_eq!(decode_text("\u{FEFF}中文".as_bytes()), "中文");
    let (gbk, _, _) = encoding_rs::GB18030.encode("中文 GBK");
    assert_eq!(decode_text(&gbk), "中文 GBK");
    // 港台 Big5 的 TXT 不能当 GBK 解成乱码 (同一段文字两种编码都要认对)
    let passage = "第一回　靈根育孕源流出，心性修持大道生。詩曰：混沌未分天地亂，茫茫渺渺無人見。";
    let (big5, _, _) = encoding_rs::BIG5.encode(passage);
    assert_eq!(decode_text(&big5), passage);
    let (gb, _, _) = encoding_rs::GB18030.encode(passage);
    assert_eq!(decode_text(&gb), passage);
    let mut le = vec![0xFF, 0xFE];
    le.extend("ab".encode_utf16().flat_map(u16::to_le_bytes));
    assert_eq!(decode_text(&le), "ab");
    let mut be = vec![0xFE, 0xFF];
    be.extend("ab".encode_utf16().flat_map(u16::to_be_bytes));
    assert_eq!(decode_text(&be), "ab");
  }

  #[test]
  fn helpers_match_js() {
    assert_eq!(base_name("a.b.txt"), "a.b");
    assert_eq!(base_name("a."), "a.");
    assert_eq!(base_name(".bashrc"), "");
    assert_eq!(encode_uri_component("我 a-b_(c)!"), "%E6%88%91%20a-b_(c)!");
    assert_eq!(split_lines("a\r\nb\rc\nd"), vec!["a", "b", "c", "d"]);
  }

  /// 与 JS 实现逐文件比对; 样本与期望由 scripts/gen-txt-epub-golden.mjs 用前端 convertToEpub 生成
  #[test]
  fn matches_js_golden_output() {
    let golden: serde_json::Value = serde_json::from_str(include_str!("testdata/txt-epub-golden.json")).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    for case in cases {
      let name = case["fileName"].as_str().unwrap();
      let input: Vec<u8> = case["inputBase64"].as_str().map(|b| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(b).unwrap()
      }).unwrap();
      let got = txt_epub_entries(&decode_text(&input), name);
      let want = case["entries"].as_array().unwrap();
      assert_eq!(got.len(), want.len(), "{name}: 文件数");
      for ((gn, gc), w) in got.iter().zip(want) {
        assert_eq!(gn, w[0].as_str().unwrap(), "{name}: 文件名");
        assert_eq!(gc, w[1].as_str().unwrap(), "{name}: {gn} 内容不一致");
      }
    }
  }
}
