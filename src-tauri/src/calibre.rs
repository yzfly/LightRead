//! Calibre 书库直读: 只读打开 metadata.db, 文件读取带路径越界校验.
//! 全部在 Rust 侧完成, 不依赖 webview 的 fs scope.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct CalibreFormat {
    pub format: String,
    pub file_name: String,
}

#[derive(Serialize)]
pub struct CalibreBook {
    pub id: i64,
    pub title: String,
    pub authors: String,
    /// 书库内相对路径 (作者/书名 (id))
    pub path: String,
    pub has_cover: bool,
    pub formats: Vec<CalibreFormat>,
}

fn open_metadata(library: &str) -> Result<Connection, String> {
    let db_path = Path::new(library).join("metadata.db");
    if !db_path.exists() {
        return Err("所选文件夹不是 Calibre 书库 (未找到 metadata.db)".into());
    }
    Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("打开书库失败: {e}"))
}

/// 列出书库中的全部书籍 (按加入时间倒序)
#[tauri::command]
pub fn calibre_list_books(library: String) -> Result<Vec<CalibreBook>, String> {
    let conn = open_metadata(&library)?;
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.title, b.path, b.has_cover,
               COALESCE((SELECT group_concat(a.name, ', ')
                 FROM books_authors_link l JOIN authors a ON a.id = l.author
                 WHERE l.book = b.id), '')
             FROM books b ORDER BY b.timestamp DESC",
        )
        .map_err(|e| format!("读取书目失败: {e}"))?;

    let mut fmt_stmt = conn
        .prepare("SELECT format, name FROM data WHERE book = ?1")
        .map_err(|e| format!("读取格式失败: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| format!("查询失败: {e}"))?;

    let mut books = Vec::new();
    for row in rows.flatten() {
        let (id, title, path, has_cover, authors) = row;
        let formats = fmt_stmt
            .query_map([id], |r| {
                Ok(CalibreFormat {
                    format: r.get::<_, String>(0)?.to_lowercase(),
                    file_name: r.get(1)?,
                })
            })
            .map(|it| it.flatten().collect())
            .unwrap_or_default();
        books.push(CalibreBook {
            id,
            title,
            authors,
            path,
            has_cover: has_cover != 0,
            formats,
        });
    }
    Ok(books)
}

/// 越界校验后的绝对路径
fn safe_join(library: &str, relative: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(library).map_err(|e| format!("书库路径无效: {e}"))?;
    let full = std::fs::canonicalize(root.join(relative))
        .map_err(|_| "文件不存在".to_string())?;
    if !full.starts_with(&root) {
        return Err("路径越界".into());
    }
    Ok(full)
}

/// 读取书库内的文件 (书籍原文件 / 封面)
#[tauri::command]
pub fn calibre_read_file(
    library: String,
    relative: String,
) -> Result<tauri::ipc::Response, String> {
    let full = safe_join(&library, &relative)?;
    let bytes = std::fs::read(&full).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_library(dir: &Path) {
        let conn = Connection::open(dir.join("metadata.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, path TEXT,
               has_cover INTEGER DEFAULT 0, timestamp TEXT DEFAULT '2026-01-01');
             CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT);
             CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
             CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT, name TEXT);
             INSERT INTO books (id, title, path, has_cover) VALUES (1, '夜航船', '张岱/夜航船 (1)', 1);
             INSERT INTO authors (id, name) VALUES (1, '张岱');
             INSERT INTO books_authors_link (book, author) VALUES (1, 1);
             INSERT INTO data (book, format, name) VALUES (1, 'EPUB', '夜航船 - 张岱');",
        )
        .unwrap();
        let book_dir = dir.join("张岱/夜航船 (1)");
        std::fs::create_dir_all(&book_dir).unwrap();
        std::fs::write(book_dir.join("夜航船 - 张岱.epub"), b"fake-epub").unwrap();
        std::fs::write(book_dir.join("cover.jpg"), b"fake-jpg").unwrap();
    }

    #[test]
    fn lists_and_reads() {
        let dir = std::env::temp_dir().join(format!("calibre-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        make_library(&dir);
        let lib = dir.to_string_lossy().to_string();

        let books = calibre_list_books(lib.clone()).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].title, "夜航船");
        assert_eq!(books[0].authors, "张岱");
        assert_eq!(books[0].formats[0].format, "epub");

        let rel = format!("{}/{}.epub", books[0].path, books[0].formats[0].file_name);
        let full = safe_join(&lib, &rel).unwrap();
        assert_eq!(std::fs::read(full).unwrap(), b"fake-epub");

        // 越界防御
        assert!(safe_join(&lib, "../../etc/passwd").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
