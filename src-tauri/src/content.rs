//! Local materials and articles. Content is isolated by the selected workspace.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaFile {
    pub path: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Material {
    pub id: i64,
    pub title: String,
    pub source: String,
    pub url: String,
    pub note: String,
    pub tags: String,
    #[serde(default)]
    pub media: Vec<MediaFile>,
    pub updated_at: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Version {
    pub title: String,
    pub body: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Article {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub versions: BTreeMap<String, Version>,
    pub material_ids: Vec<i64>,
    pub updated_at: String,
}
#[derive(Serialize)]
pub struct ContentData {
    materials: Vec<Material>,
    articles: Vec<Article>,
}
#[derive(Serialize)]
pub struct SaveResult {
    id: i64,
    backup_warning: Option<String>,
}

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS content_materials (id INTEGER PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS content_materials_root ON content_materials(root);
        CREATE TABLE IF NOT EXISTS content_material_media (material_id INTEGER NOT NULL REFERENCES content_materials(id) ON DELETE CASCADE, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(material_id,path));
        CREATE TABLE IF NOT EXISTS content_articles (id INTEGER PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', versions TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS content_articles_root ON content_articles(root);
        CREATE TABLE IF NOT EXISTS content_article_materials (article_id INTEGER NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES content_materials(id) ON DELETE CASCADE, PRIMARY KEY(article_id, material_id));")
        .map_err(|e| e.to_string())
}
fn load(conn: &Connection, root: &str) -> Result<ContentData, String> {
    init(conn)?;
    let mut statement = conn.prepare("SELECT id,title,source,url,note,tags,updated_at FROM content_materials WHERE root=?1 ORDER BY updated_at DESC,id DESC").map_err(|e| e.to_string())?;
    let mut materials = statement
        .query_map([root], |r| {
            Ok(Material {
                id: r.get(0)?,
                title: r.get(1)?,
                source: r.get(2)?,
                url: r.get(3)?,
                note: r.get(4)?,
                tags: r.get(5)?,
                media: Vec::new(),
                updated_at: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for material in &mut materials {
        let mut media = conn.prepare("SELECT path,name,kind FROM content_material_media WHERE material_id=?1 ORDER BY rowid").map_err(|e| e.to_string())?;
        material.media = media
            .query_map([material.id], |r| {
                Ok(MediaFile {
                    path: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
    }
    let mut statement = conn.prepare("SELECT id,title,body,versions,updated_at FROM content_articles WHERE root=?1 ORDER BY updated_at DESC,id DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([root], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut articles = Vec::new();
    for row in rows {
        let (id, title, body, versions, updated_at) = row.map_err(|e| e.to_string())?;
        let mut links = conn.prepare("SELECT material_id FROM content_article_materials WHERE article_id=?1 ORDER BY material_id").map_err(|e| e.to_string())?;
        let material_ids = links
            .query_map([id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<i64>, _>>()
            .map_err(|e| e.to_string())?;
        articles.push(Article {
            id,
            title,
            body,
            versions: serde_json::from_str(&versions)
                .map_err(|e| format!("文章平台版本读取失败：{e}"))?,
            material_ids,
            updated_at,
        });
    }
    Ok(ContentData {
        materials,
        articles,
    })
}
fn save_material(conn: &mut Connection, root: &str, item: &Material) -> Result<i64, String> {
    init(conn)?;
    if item.title.trim().is_empty() {
        return Err("请输入素材标题".into());
    }
    if item.title.len() > 2000
        || item.note.len() > 2_000_000
        || item.url.len() > 10000
        || item.tags.len() > 10000
        || item.source.len() > 1000
    {
        return Err("素材内容过长".into());
    }
    if item.media.len() > 100 {
        return Err("素材附件过多".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = if item.id == 0 {
        tx.execute("INSERT INTO content_materials(root,title,source,url,note,tags) VALUES (?1,?2,?3,?4,?5,?6)",params![root,item.title.trim(),item.source,item.url,item.note,item.tags]).map_err(|e|e.to_string())?;
        tx.last_insert_rowid()
    } else {
        let n = tx.execute("UPDATE content_materials SET title=?1,source=?2,url=?3,note=?4,tags=?5,updated_at=CURRENT_TIMESTAMP WHERE id=?6 AND root=?7",params![item.title.trim(),item.source,item.url,item.note,item.tags,item.id,root]).map_err(|e|e.to_string())?;
        if n == 0 {
            return Err("素材不存在或不属于当前工作目录".into());
        }
        item.id
    };
    tx.execute(
        "DELETE FROM content_material_media WHERE material_id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    let media_dir = std::path::Path::new(root).join("seabird-media");
    for media in &item.media {
        let path = std::path::Path::new(&media.path);
        if !path.starts_with(&media_dir)
            || path.parent() != Some(media_dir.as_path())
            || !["image", "video"].contains(&media.kind.as_str())
        {
            return Err("素材附件路径无效".into());
        }
        tx.execute(
            "INSERT INTO content_material_media(material_id,path,name,kind) VALUES(?1,?2,?3,?4)",
            params![id, media.path, media.name, media.kind],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
fn save_article(conn: &mut Connection, root: &str, item: &Article) -> Result<i64, String> {
    init(conn)?;
    if item.title.trim().is_empty() {
        return Err("请输入文章标题".into());
    }
    let versions = serde_json::to_string(&item.versions).map_err(|e| e.to_string())?;
    if item.title.len() > 2000 || item.body.len() > 2_000_000 || versions.len() > 4_000_000 {
        return Err("文章内容过长".into());
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let id = if item.id == 0 {
        tx.execute(
            "INSERT INTO content_articles(root,title,body,versions) VALUES (?1,?2,?3,?4)",
            params![root, item.title.trim(), item.body, versions],
        )
        .map_err(|e| e.to_string())?;
        tx.last_insert_rowid()
    } else {
        let n=tx.execute("UPDATE content_articles SET title=?1,body=?2,versions=?3,updated_at=CURRENT_TIMESTAMP WHERE id=?4 AND root=?5",params![item.title.trim(),item.body,versions,item.id,root]).map_err(|e|e.to_string())?;
        if n == 0 {
            return Err("文章不存在或不属于当前工作目录".into());
        }
        item.id
    };
    tx.execute(
        "DELETE FROM content_article_materials WHERE article_id=?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    for mid in &item.material_ids {
        let exists = tx
            .query_row(
                "SELECT 1 FROM content_materials WHERE id=?1 AND root=?2",
                params![mid, root],
                |r| r.get::<_, i32>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !exists {
            return Err("关联素材不存在或不属于当前工作目录".into());
        }
        tx.execute(
            "INSERT OR IGNORE INTO content_article_materials(article_id,material_id) VALUES(?1,?2)",
            params![id, mid],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
fn delete(conn: &Connection, root: &str, kind: &str, id: i64) -> Result<(), String> {
    init(conn)?;
    let sql = match kind {
        "material" => "DELETE FROM content_materials WHERE id=?1 AND root=?2",
        "article" => "DELETE FROM content_articles WHERE id=?1 AND root=?2",
        _ => return Err("未知内容类型".into()),
    };
    if conn
        .execute(sql, params![id, root])
        .map_err(|e| e.to_string())?
        == 0
    {
        return Err("内容不存在或不属于当前工作目录".into());
    }
    Ok(())
}
#[tauri::command]
pub fn content_load(app: tauri::AppHandle, root: String) -> Result<ContentData, String> {
    let root = crate::workspace::root(&root)?;
    let media = root.join("seabird-media");
    if media.exists() {
        let actual = media.canonicalize().map_err(|e| e.to_string())?;
        if actual.parent() != Some(root.as_path()) {
            return Err("素材目录不能指向工作目录之外".into());
        }
        app.asset_protocol_scope()
            .allow_directory(&actual, false)
            .map_err(|e| e.to_string())?;
    }
    load(&crate::database(&app)?, &root.to_string_lossy())
}
#[tauri::command]
pub fn content_save_material(
    app: tauri::AppHandle,
    root: String,
    item: Material,
) -> Result<SaveResult, String> {
    let root = crate::workspace::root(&root)?;
    let mut conn = crate::database(&app)?;
    let id = save_material(&mut conn, &root.to_string_lossy(), &item)?;
    let backup_warning = crate::backup_database(&app, &conn, false, false).err();
    Ok(SaveResult { id, backup_warning })
}

fn copy_media(root: &str, path: &str) -> Result<(MediaFile, std::path::PathBuf), String> {
    use std::io;
    let root = crate::workspace::root(root)?;
    let source = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| format!("无法读取文件：{e}"))?;
    if !source.is_file() {
        return Err("请选择图片或视频文件".into());
    }
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" => "image",
        "mp4" | "mov" | "m4v" | "webm" => "video",
        _ => return Err("暂不支持此文件格式".into()),
    };
    if source.metadata().map_err(|e| e.to_string())?.len() > 1_000_000_000 {
        return Err("文件超过 1 GB".into());
    }
    let dir = root.join("seabird-media");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建素材目录：{e}"))?;
    let actual = dir.canonicalize().map_err(|e| e.to_string())?;
    if actual.parent() != Some(root.as_path()) {
        return Err("素材目录不能指向工作目录之外".into());
    }
    let name = source
        .file_name()
        .ok_or("文件名无效")?
        .to_string_lossy()
        .to_string();
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let target = actual.join(format!("{time}.{ext}"));
    let mut from = std::fs::File::open(&source).map_err(|e| e.to_string())?;
    let mut to = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| e.to_string())?;
    if let Err(error) = io::copy(&mut from, &mut to) {
        drop(to);
        let _ = std::fs::remove_file(&target);
        return Err(format!("导入文件失败：{error}"));
    }
    Ok((
        MediaFile {
            path: target.to_string_lossy().into_owned(),
            name,
            kind: kind.into(),
        },
        actual,
    ))
}
#[tauri::command]
pub async fn content_import_media(
    app: tauri::AppHandle,
    root: String,
    path: String,
) -> Result<MediaFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (media, dir) = copy_media(&root, &path)?;
        app.asset_protocol_scope()
            .allow_directory(&dir, false)
            .map_err(|e| e.to_string())?;
        Ok(media)
    })
    .await
    .map_err(|e| format!("导入文件失败：{e}"))?
}
#[tauri::command]
pub fn content_save_article(
    app: tauri::AppHandle,
    root: String,
    item: Article,
) -> Result<SaveResult, String> {
    let root = crate::workspace::root(&root)?;
    let mut conn = crate::database(&app)?;
    let id = save_article(&mut conn, &root.to_string_lossy(), &item)?;
    let backup_warning = crate::backup_database(&app, &conn, false, false).err();
    Ok(SaveResult { id, backup_warning })
}
#[tauri::command]
pub fn content_delete(
    app: tauri::AppHandle,
    root: String,
    kind: String,
    id: i64,
) -> Result<Option<String>, String> {
    let root = crate::workspace::root(&root)?;
    let conn = crate::database(&app)?;
    crate::backup_database(&app, &conn, false, true)
        .map_err(|e| format!("无法创建删除前备份，未删除：{e}"))?;
    delete(&conn, &root.to_string_lossy(), &kind, id)?;
    Ok(crate::backup_database(&app, &conn, false, false).err())
}

#[derive(Serialize)]
pub struct Trend {
    title: String,
    source: String,
    url: String,
    note: String,
}
#[derive(Serialize)]
pub struct TrendResult {
    account: String,
    items: Vec<Trend>,
}
#[tauri::command]
pub async fn content_trends() -> Result<TrendResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(unix)]
        let path = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let output = std::process::Command::new(shell)
                .args(["-lc", "command -v cloudl"])
                .output()
                .map_err(|e| format!("无法查找 cloudl：{e}"))?;
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find(|s| std::path::Path::new(s).is_file())
                .unwrap_or("")
                .to_owned()
        };
        #[cfg(windows)]
        let path = "cloudl".to_string();
        if path.is_empty() {
            return Err("未找到 cloudl，请先安装并连接浏览器".into());
        }
        let who = crate::setup::run_command(
            &path,
            &["twitter", "whoami", "-f", "json"],
            Duration::from_secs(30),
        )
        .map_err(|e| format!("无法检查 X 登录：{e}"))?;
        if !who.status.success() {
            return Err("无法检查 X 登录状态，请检查 cloudl 浏览器连接".into());
        }
        let identity: serde_json::Value =
            serde_json::from_slice(&who.stdout).map_err(|_| "无法读取 X 登录状态")?;
        let account = identity
            .get("username")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or("请先登录 X")?
            .to_string();
        let output = crate::setup::run_command(
            &path,
            &["twitter", "trending", "--limit", "20", "-f", "json"],
            Duration::from_secs(45),
        )
        .map_err(|e| format!("获取 X 热点失败：{e}"))?;
        if !output.status.success() {
            return Err(format!(
                "获取 X 热点失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let rows: Vec<serde_json::Value> =
            serde_json::from_slice(&output.stdout).map_err(|_| "无法读取 X 热点结果")?;
        let items = rows
            .into_iter()
            .filter_map(|v| {
                Some(Trend {
                    title: v.get("topic")?.as_str()?.to_string(),
                    source: "X 热点".into(),
                    url: String::new(),
                    note: v
                        .get("category")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
            })
            .collect();
        Ok(TrendResult { account, items })
    })
    .await
    .map_err(|e| format!("热点读取失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imported_media_is_copied_and_original_is_preserved() {
        let base = std::env::temp_dir().join(format!(
            "seabird-media-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let workspace = base.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let source = base.join("original image.jpg");
        std::fs::write(&source, b"test image").unwrap();
        let (media, dir) =
            copy_media(workspace.to_str().unwrap(), source.to_str().unwrap()).unwrap();
        assert_eq!(media.kind, "image");
        assert_eq!(media.name, "original image.jpg");
        assert_eq!(std::fs::read(&media.path).unwrap(), b"test image");
        assert_eq!(std::fs::read(&source).unwrap(), b"test image");
        assert_eq!(
            std::path::Path::new(&media.path).parent(),
            Some(dir.as_path())
        );
        let mut db = Connection::open_in_memory().unwrap();
        let root = workspace
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let material = Material {
            id: 0,
            title: "图片素材".into(),
            source: String::new(),
            url: String::new(),
            note: String::new(),
            tags: String::new(),
            media: vec![media.clone()],
            updated_at: String::new(),
        };
        let id = save_material(&mut db, &root, &material).unwrap();
        assert_eq!(
            load(&db, &root).unwrap().materials[0].media[0].path,
            media.path
        );
        delete(&db, &root, "material", id).unwrap();
        assert!(std::path::Path::new(&media.path).exists());
        let mut invalid = material;
        invalid.media[0].path = source.to_string_lossy().into_owned();
        assert!(save_material(&mut db, &root, &invalid).is_err());
        assert!(load(&db, &root).unwrap().materials.is_empty());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn materials_articles_and_links_are_workspace_scoped() {
        let mut db = Connection::open_in_memory().unwrap();
        let m = Material {
            id: 0,
            title: "素材".into(),
            source: "X".into(),
            url: "https://x.com".into(),
            note: "备注".into(),
            tags: "AI".into(),
            media: Vec::new(),
            updated_at: String::new(),
        };
        let mid = save_material(&mut db, "/one", &m).unwrap();
        let mut versions = BTreeMap::new();
        versions.insert(
            "x".into(),
            Version {
                title: "标题".into(),
                body: "正文".into(),
            },
        );
        let a = Article {
            id: 0,
            title: "文章".into(),
            body: "原稿".into(),
            versions,
            material_ids: vec![mid],
            updated_at: String::new(),
        };
        let aid = save_article(&mut db, "/one", &a).unwrap();
        let data = load(&db, "/one").unwrap();
        assert_eq!(data.articles[0].material_ids, vec![mid]);
        assert_eq!(data.articles[0].versions["x"].body, "正文");
        assert!(load(&db, "/two").unwrap().materials.is_empty());
        assert!(save_article(&mut db, "/two", &a).is_err());
        assert!(load(&db, "/two").unwrap().articles.is_empty());
        delete(&db, "/one", "material", mid).unwrap();
        assert!(load(&db, "/one").unwrap().articles[0]
            .material_ids
            .is_empty());
        delete(&db, "/one", "article", aid).unwrap();
    }
}
