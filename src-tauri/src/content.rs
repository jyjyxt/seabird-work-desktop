//! Local materials and articles. Content is isolated by the selected workspace.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::Manager;

fn source_url(input: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(input.trim()).map_err(|_| "链接格式不正确".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("请使用 http 或 https 链接".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn content_open_url(url: String) -> Result<(), String> {
    let url = source_url(&url)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = std::process::Command::new("open");
        #[cfg(target_os = "linux")]
        let mut command = std::process::Command::new("xdg-open");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = std::process::Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        };
        #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
        {
            let status = command
                .arg(url)
                .status()
                .map_err(|e| format!("无法打开链接：{e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err("无法打开链接，请检查浏览器设置".into())
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            let _ = url;
            Err("当前系统不支持打开链接".into())
        }
    })
    .await
    .map_err(|e| format!("无法打开链接：{e}"))?
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MediaFile {
    pub path: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Version {
    pub title: String,
    pub body: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Article {
    pub id: i64,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: String,
    pub versions: BTreeMap<String, Version>,
    pub material_ids: Vec<i64>,
    #[serde(default)]
    pub cover: Option<MediaFile>,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Publication {
    id: i64,
    article_id: i64,
    article_title: String,
    published_at: i64,
}

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS social_platform_metadata (key TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS social_platforms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, image_url TEXT NOT NULL, url TEXT NOT NULL, types TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS social_platform_disabled (platform_id INTEGER PRIMARY KEY REFERENCES social_platforms(id) ON DELETE CASCADE);
        CREATE TABLE IF NOT EXISTS content_materials (id INTEGER PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS content_materials_root ON content_materials(root);
        CREATE TABLE IF NOT EXISTS content_material_media (material_id INTEGER NOT NULL REFERENCES content_materials(id) ON DELETE CASCADE, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(material_id,path));
        CREATE TABLE IF NOT EXISTS content_articles (id INTEGER PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', versions TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '', cover TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE INDEX IF NOT EXISTS content_articles_root ON content_articles(root);
        CREATE TABLE IF NOT EXISTS content_article_materials (article_id INTEGER NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE, material_id INTEGER NOT NULL REFERENCES content_materials(id) ON DELETE CASCADE, PRIMARY KEY(article_id, material_id));
        CREATE TABLE IF NOT EXISTS content_publications (id INTEGER PRIMARY KEY, root TEXT NOT NULL, article_id INTEGER NOT NULL REFERENCES content_articles(id) ON DELETE CASCADE, article_title TEXT NOT NULL, published_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS content_publications_root_time ON content_publications(root, published_at);
        CREATE TRIGGER IF NOT EXISTS content_publication_article_title AFTER UPDATE OF title ON content_articles BEGIN UPDATE content_publications SET article_title=NEW.title WHERE article_id=NEW.id AND root=NEW.root; END;
        CREATE TABLE IF NOT EXISTS content_suggestion_saves (root TEXT NOT NULL, suggestion_key TEXT NOT NULL, kind TEXT NOT NULL, content_id INTEGER NOT NULL, PRIMARY KEY(root, suggestion_key));
        CREATE TRIGGER IF NOT EXISTS content_material_suggestion_delete AFTER DELETE ON content_materials BEGIN DELETE FROM content_suggestion_saves WHERE root=OLD.root AND kind='material' AND content_id=OLD.id; END;
        CREATE TRIGGER IF NOT EXISTS content_article_suggestion_delete AFTER DELETE ON content_articles BEGIN DELETE FROM content_suggestion_saves WHERE root=OLD.root AND kind='article' AND content_id=OLD.id; END;")
        .map_err(|e| e.to_string())?;
    let has_column = |column: &str| -> Result<bool, String> {
        let mut stmt = conn
            .prepare("PRAGMA table_info(content_articles)")
            .map_err(|e| e.to_string())?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        for name in names {
            if name.map_err(|e| e.to_string())? == column {
                return Ok(true);
            }
        }
        Ok(false)
    };
    if !has_column("tags")? {
        if let Err(error) = conn.execute(
            "ALTER TABLE content_articles ADD COLUMN tags TEXT NOT NULL DEFAULT ''",
            [],
        ) {
            // Another connection may have completed the same migration concurrently.
            if !has_column("tags")? {
                return Err(format!("文章标签迁移失败：{error}"));
            }
        }
    }
    if !has_column("cover")? {
        if let Err(error) = conn.execute(
            "ALTER TABLE content_articles ADD COLUMN cover TEXT NOT NULL DEFAULT ''",
            [],
        ) {
            if !has_column("cover")? {
                return Err(format!("文章封面迁移失败：{error}"));
            }
        }
    }
    Ok(())
}

fn suggestion_existing(
    conn: &Connection,
    root: &str,
    kind: &str,
    key: Option<&str>,
) -> Result<Option<i64>, String> {
    let Some(key) = key else { return Ok(None) };
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("保存建议标识无效".into());
    }
    let found: Option<(String, i64)> = conn.query_row("SELECT kind, content_id FROM content_suggestion_saves WHERE root=?1 AND suggestion_key=?2", params![root, key], |row| Ok((row.get(0)?, row.get(1)?))).optional().map_err(|e| e.to_string())?;
    if let Some((saved_kind, id)) = found {
        if saved_kind != kind {
            return Err("保存建议类型不匹配".into());
        }
        let sql = if kind == "material" {
            "SELECT 1 FROM content_materials WHERE root=?1 AND id=?2"
        } else {
            "SELECT 1 FROM content_articles WHERE root=?1 AND id=?2"
        };
        if conn
            .query_row(sql, params![root, id], |_| Ok(()))
            .optional()
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Ok(Some(id));
        }
        conn.execute(
            "DELETE FROM content_suggestion_saves WHERE root=?1 AND suggestion_key=?2",
            params![root, key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(None)
}

fn record_suggestion(
    conn: &Connection,
    root: &str,
    kind: &str,
    key: Option<&str>,
    id: i64,
) -> Result<(), String> {
    if let Some(key) = key {
        conn.execute("INSERT INTO content_suggestion_saves(root, suggestion_key, kind, content_id) VALUES (?1, ?2, ?3, ?4)", params![root, key, kind, id]).map_err(|e| e.to_string())?;
    }
    Ok(())
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
    let mut statement = conn.prepare("SELECT id,title,body,versions,tags,updated_at,cover FROM content_articles WHERE root=?1 ORDER BY updated_at DESC,id DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([root], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut articles = Vec::new();
    for row in rows {
        let (id, title, body, versions, tags, updated_at, cover) =
            row.map_err(|e| e.to_string())?;
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
            tags,
            versions: serde_json::from_str(&versions)
                .map_err(|e| format!("文章平台版本读取失败：{e}"))?,
            material_ids,
            cover: if cover.is_empty() {
                None
            } else {
                Some(serde_json::from_str(&cover).map_err(|e| format!("文章封面读取失败：{e}"))?)
            },
            updated_at,
        });
    }
    Ok(ContentData {
        materials,
        articles,
    })
}
#[cfg(test)]
fn save_material(conn: &mut Connection, root: &str, item: &Material) -> Result<i64, String> {
    save_material_checked(conn, root, item, None)
}
fn save_material_checked(
    conn: &mut Connection,
    root: &str,
    item: &Material,
    expected: Option<&Material>,
) -> Result<i64, String> {
    save_material_with_key(conn, root, item, expected, None)
}
fn save_material_with_key(
    conn: &mut Connection,
    root: &str,
    item: &Material,
    expected: Option<&Material>,
    key: Option<&str>,
) -> Result<i64, String> {
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
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if key.is_some() && item.id != 0 {
        return Err("保存建议只能创建新素材".into());
    }
    if let Some(id) = suggestion_existing(&tx, root, "material", key)? {
        return Ok(id);
    }
    if let Some(expected) = expected {
        if expected.id != item.id
            || load(&tx, root)?.materials.iter().find(|v| v.id == item.id) != Some(expected)
        {
            return Err("素材已被修改，请重新读取后再保存".into());
        }
    }
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
    record_suggestion(&tx, root, "material", key, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
#[cfg(test)]
fn save_article(conn: &mut Connection, root: &str, item: &Article) -> Result<i64, String> {
    save_article_checked(conn, root, item, None)
}
fn save_article_checked(
    conn: &mut Connection,
    root: &str,
    item: &Article,
    expected: Option<&Article>,
) -> Result<i64, String> {
    save_article_with_key(conn, root, item, expected, None)
}
fn save_article_with_key(
    conn: &mut Connection,
    root: &str,
    item: &Article,
    expected: Option<&Article>,
    key: Option<&str>,
) -> Result<i64, String> {
    init(conn)?;
    if item.title.trim().is_empty() {
        return Err("请输入文章标题".into());
    }
    let cover = if let Some(cover) = &item.cover {
        let media_dir = std::path::Path::new(root).join("seabird-media");
        let path = std::path::Path::new(&cover.path);
        if path.parent() != Some(media_dir.as_path())
            || cover.kind != "image"
            || cover.name.len() > 4096
        {
            return Err("文章封面路径无效，请先导入图片".into());
        }
        serde_json::to_string(cover).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let versions = serde_json::to_string(&item.versions).map_err(|e| e.to_string())?;
    if item.title.len() > 2000
        || item.body.len() > 2_000_000
        || versions.len() > 4_000_000
        || item.tags.len() > 10000
    {
        return Err("文章内容过长".into());
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    if key.is_some() && item.id != 0 {
        return Err("保存建议只能创建新文章".into());
    }
    if let Some(id) = suggestion_existing(&tx, root, "article", key)? {
        return Ok(id);
    }
    if let Some(expected) = expected {
        if expected.id != item.id
            || load(&tx, root)?.articles.iter().find(|v| v.id == item.id) != Some(expected)
        {
            return Err("文章已被修改，请重新读取后再保存".into());
        }
    }
    let id = if item.id == 0 {
        tx.execute(
            "INSERT INTO content_articles(root,title,body,versions,tags,cover) VALUES (?1,?2,?3,?4,?5,?6)",
            params![root, item.title.trim(), item.body, versions, item.tags, cover],
        )
        .map_err(|e| e.to_string())?;
        tx.last_insert_rowid()
    } else {
        let n=tx.execute("UPDATE content_articles SET title=?1,body=?2,versions=?3,tags=?4,cover=?5,updated_at=CURRENT_TIMESTAMP WHERE id=?6 AND root=?7",params![item.title.trim(),item.body,versions,item.tags,cover,item.id,root]).map_err(|e|e.to_string())?;
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
    record_suggestion(&tx, root, "article", key, id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SocialPlatform {
    id: i64,
    name: String,
    image_url: String,
    url: String,
    types: Vec<String>,
    #[serde(default = "platform_enabled_by_default")]
    enabled: bool,
}

fn platform_enabled_by_default() -> bool {
    true
}

fn load_platforms(conn: &Connection) -> Result<Vec<SocialPlatform>, String> {
    init(conn)?;
    let mut stmt = conn.prepare("SELECT id,name,image_url,url,types,NOT EXISTS(SELECT 1 FROM social_platform_disabled WHERE platform_id=social_platforms.id) FROM social_platforms ORDER BY name COLLATE NOCASE,id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (id, name, image_url, url, types, enabled) = row.map_err(|e| e.to_string())?;
        Ok(SocialPlatform {
            id,
            name,
            image_url,
            url,
            types: serde_json::from_str(&types).map_err(|e| format!("平台类型读取失败：{e}"))?,
            enabled,
        })
    })
    .collect()
}

fn save_platform(conn: &Connection, item: &SocialPlatform) -> Result<i64, String> {
    init(conn)?;
    let name = item.name.trim();
    if item.id < 0 || name.is_empty() || name.len() > 200 {
        return Err("请输入有效的平台名称".into());
    }
    let image_url = source_url(&item.image_url)?.to_string();
    let url = source_url(&item.url)?.to_string();
    if item.types.is_empty()
        || item
            .types
            .iter()
            .any(|t| !["article", "image", "video"].contains(&t.as_str()))
    {
        return Err("请选择适用类型".into());
    }
    let types = serde_json::to_string(&item.types).map_err(|e| e.to_string())?;
    if item.id == 0 {
        conn.execute(
            "INSERT INTO social_platforms(name,image_url,url,types) VALUES(?1,?2,?3,?4)",
            params![name, image_url, url, types],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    } else {
        if conn
            .execute(
                "UPDATE social_platforms SET name=?1,image_url=?2,url=?3,types=?4 WHERE id=?5",
                params![name, image_url, url, types, item.id],
            )
            .map_err(|e| e.to_string())?
            == 0
        {
            return Err("平台不存在，请重新打开".into());
        }
        Ok(item.id)
    }
}

fn seed_social_platforms(conn: &Connection) -> Result<(), String> {
    init(conn)?;
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let initialized = tx
        .query_row(
            "SELECT 1 FROM social_platform_metadata WHERE key='defaults_v1'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if !initialized {
        for (name, image, url, types) in [
            (
                "微信公众号",
                "https://mp.weixin.qq.com/favicon.ico",
                "https://mp.weixin.qq.com/",
                r#"["article"]"#,
            ),
            (
                "知乎",
                "https://www.zhihu.com/favicon.ico",
                "https://zhuanlan.zhihu.com/write",
                r#"["article"]"#,
            ),
            (
                "小红书",
                "https://www.xiaohongshu.com/favicon.ico",
                "https://creator.xiaohongshu.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "今日头条",
                "https://www.toutiao.com/favicon.ico",
                "https://mp.toutiao.com/",
                r#"["article","image","video"]"#,
            ),
        ] {
            tx.execute("INSERT INTO social_platforms(name,image_url,url,types) SELECT ?1,?2,?3,?4 WHERE NOT EXISTS (SELECT 1 FROM social_platforms WHERE name=?1 OR url=?3)", params![name, image, url, types]).map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO social_platform_metadata(key) VALUES('defaults_v1')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let international_initialized = tx
        .query_row(
            "SELECT 1 FROM social_platform_metadata WHERE key='defaults_v2'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if !international_initialized {
        for (name, image, url, types) in [
            (
                "X",
                "https://x.com/favicon.ico",
                "https://x.com/compose/post",
                r#"["article","image","video"]"#,
            ),
            (
                "Instagram",
                "https://www.instagram.com/favicon.ico",
                "https://www.instagram.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "YouTube",
                "https://www.youtube.com/favicon.ico",
                "https://studio.youtube.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "Reddit",
                "https://www.reddit.com/favicon.ico",
                "https://www.reddit.com/submit",
                r#"["article","image","video"]"#,
            ),
            (
                "LinkedIn",
                "https://www.linkedin.com/favicon.ico",
                "https://www.linkedin.com/feed/",
                r#"["article","image","video"]"#,
            ),
            (
                "Facebook",
                "https://www.facebook.com/favicon.ico",
                "https://www.facebook.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "TikTok",
                "https://www.tiktok.com/favicon.ico",
                "https://www.tiktok.com/upload",
                r#"["article","image","video"]"#,
            ),
            (
                "Threads",
                "https://www.threads.com/favicon.ico",
                "https://www.threads.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "微博",
                "https://weibo.com/favicon.ico",
                "https://weibo.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "哔哩哔哩",
                "https://www.bilibili.com/favicon.ico",
                "https://member.bilibili.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "抖音",
                "https://www.douyin.com/favicon.ico",
                "https://creator.douyin.com/",
                r#"["article","image","video"]"#,
            ),
            (
                "Medium",
                "https://medium.com/favicon.ico",
                "https://medium.com/new-story",
                r#"["article","image","video"]"#,
            ),
            (
                "Telegram",
                "https://telegram.org/favicon.ico",
                "https://web.telegram.org/",
                r#"["article","image","video"]"#,
            ),
        ] {
            tx.execute("INSERT INTO social_platforms(name,image_url,url,types) SELECT ?1,?2,?3,?4 WHERE NOT EXISTS (SELECT 1 FROM social_platforms WHERE name=?1 OR url=?3)", params![name, image, url, types]).map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO social_platform_metadata(key) VALUES('defaults_v2')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    let selection_initialized = tx
        .query_row(
            "SELECT 1 FROM social_platform_metadata WHERE key='platform_selection_v1'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .is_some();
    if !selection_initialized {
        for (name, url) in [
            ("今日头条", "https://mp.toutiao.com/"),
            ("Instagram", "https://www.instagram.com/"),
            ("Reddit", "https://www.reddit.com/submit"),
            ("LinkedIn", "https://www.linkedin.com/feed/"),
            ("Facebook", "https://www.facebook.com/"),
            ("TikTok", "https://www.tiktok.com/upload"),
            ("Threads", "https://www.threads.com/"),
            ("微博", "https://weibo.com/"),
            ("哔哩哔哩", "https://member.bilibili.com/"),
            ("抖音", "https://creator.douyin.com/"),
            ("Medium", "https://medium.com/new-story"),
            ("Telegram", "https://web.telegram.org/"),
        ] {
            tx.execute("INSERT OR IGNORE INTO social_platform_disabled(platform_id) SELECT id FROM social_platforms WHERE name=?1 AND url=?2", params![name, url]).map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT INTO social_platform_metadata(key) VALUES('platform_selection_v1')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn social_platform_list(app: tauri::AppHandle) -> Result<Vec<SocialPlatform>, String> {
    let conn = crate::database(&app)?;
    seed_social_platforms(&conn)?;
    load_platforms(&conn)
}

#[tauri::command]
pub fn social_platform_save(
    app: tauri::AppHandle,
    item: SocialPlatform,
) -> Result<SaveResult, String> {
    let conn = crate::database(&app)?;
    let id = save_platform(&conn, &item)?;
    Ok(SaveResult {
        id,
        backup_warning: crate::backup_database(&app, &conn, false, false).err(),
    })
}

fn set_platform_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<(), String> {
    init(conn)?;
    change_platform_enabled(conn, id, enabled)
}

fn change_platform_enabled(conn: &Connection, id: i64, enabled: bool) -> Result<(), String> {
    if enabled {
        let exists = conn
            .query_row("SELECT 1 FROM social_platforms WHERE id=?1", [id], |_| {
                Ok(())
            })
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if !exists {
            return Err("平台不存在".into());
        }
        conn.execute(
            "DELETE FROM social_platform_disabled WHERE platform_id=?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let changed = conn.execute("INSERT OR IGNORE INTO social_platform_disabled(platform_id) SELECT id FROM social_platforms WHERE id=?1", [id]).map_err(|e| e.to_string())?;
        if changed == 0
            && !conn
                .query_row("SELECT 1 FROM social_platforms WHERE id=?1", [id], |_| {
                    Ok(())
                })
                .optional()
                .map_err(|e| e.to_string())?
                .is_some()
        {
            return Err("平台不存在".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn social_platform_set_enabled(
    app: tauri::AppHandle,
    id: i64,
    enabled: bool,
) -> Result<Option<String>, String> {
    let conn = crate::database(&app)?;
    set_platform_enabled(&conn, id, enabled)?;
    Ok(crate::backup_database(&app, &conn, false, false).err())
}

fn set_platforms_enabled(conn: &Connection, ids: &[i64], enabled: bool) -> Result<(), String> {
    init(conn)?;
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    for id in ids {
        change_platform_enabled(&tx, *id, enabled)?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn social_platforms_set_enabled(
    app: tauri::AppHandle,
    ids: Vec<i64>,
    enabled: bool,
) -> Result<Option<String>, String> {
    let conn = crate::database(&app)?;
    set_platforms_enabled(&conn, &ids, enabled)?;
    Ok(crate::backup_database(&app, &conn, false, false).err())
}

#[tauri::command]
pub fn social_platform_delete(app: tauri::AppHandle, id: i64) -> Result<Option<String>, String> {
    let conn = crate::database(&app)?;
    init(&conn)?;
    crate::backup_database(&app, &conn, false, true)
        .map_err(|e| format!("无法创建删除前备份，未删除：{e}"))?;
    if conn
        .execute("DELETE FROM social_platforms WHERE id=?1", [id])
        .map_err(|e| e.to_string())?
        == 0
    {
        return Err("平台不存在".into());
    }
    Ok(crate::backup_database(&app, &conn, false, false).err())
}

fn load_publications(conn: &Connection, root: &str) -> Result<Vec<Publication>, String> {
    init(conn)?;
    let mut statement = conn.prepare("SELECT id,article_id,article_title,published_at FROM content_publications WHERE root=?1 ORDER BY published_at,id").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([root], |row| {
            Ok(Publication {
                id: row.get(0)?,
                article_id: row.get(1)?,
                article_title: row.get(2)?,
                published_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn save_publication(
    conn: &mut Connection,
    root: &str,
    item: &Publication,
    expected: Option<&Publication>,
) -> Result<i64, String> {
    init(conn)?;
    if item.id < 0 || !(0..=253_402_300_799_999).contains(&item.published_at) {
        return Err("请选择有效的发布时间".into());
    }
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let existing: Option<Publication> = if item.id == 0 {
        None
    } else {
        tx.query_row("SELECT id,article_id,article_title,published_at FROM content_publications WHERE root=?1 AND id=?2", params![root, item.id], |row| Ok(Publication { id: row.get(0)?, article_id: row.get(1)?, article_title: row.get(2)?, published_at: row.get(3)? })).optional().map_err(|e| e.to_string())?
    };
    if item.id != 0 {
        let saved = existing.as_ref().ok_or("发布记录不存在")?;
        let original = expected.ok_or("请重新打开发布记录后再保存")?;
        if saved.id != original.id
            || saved.article_id != original.article_id
            || saved.published_at != original.published_at
        {
            return Err("发布记录已被修改，请重新打开后再保存".into());
        }
    } else if expected.is_some() {
        return Err("发布记录格式错误".into());
    }
    let title = tx
        .query_row(
            "SELECT title FROM content_articles WHERE root=?1 AND id=?2",
            params![root, item.article_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("文章不存在，请重新选择")?;
    let id = if item.id == 0 {
        tx.execute("INSERT INTO content_publications(root,article_id,article_title,published_at) VALUES(?1,?2,?3,?4)", params![root, item.article_id, title, item.published_at]).map_err(|e| e.to_string())?;
        tx.last_insert_rowid()
    } else {
        tx.execute("UPDATE content_publications SET article_id=?1,article_title=?2,published_at=?3 WHERE root=?4 AND id=?5", params![item.article_id, title, item.published_at, root, item.id]).map_err(|e| e.to_string())?;
        item.id
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
pub fn publication_list(app: tauri::AppHandle, root: String) -> Result<Vec<Publication>, String> {
    let root = crate::workspace::root(&root)?;
    load_publications(&crate::database(&app)?, &root.to_string_lossy())
}

#[tauri::command]
pub fn publication_save(
    app: tauri::AppHandle,
    root: String,
    item: Publication,
    expected: Option<Publication>,
) -> Result<SaveResult, String> {
    let root = crate::workspace::root(&root)?;
    let mut conn = crate::database(&app)?;
    let id = save_publication(&mut conn, &root.to_string_lossy(), &item, expected.as_ref())?;
    Ok(SaveResult {
        id,
        backup_warning: crate::backup_database(&app, &conn, false, false).err(),
    })
}

#[tauri::command]
pub fn publication_delete(
    app: tauri::AppHandle,
    root: String,
    id: i64,
) -> Result<Option<String>, String> {
    let root = crate::workspace::root(&root)?;
    let conn = crate::database(&app)?;
    init(&conn)?;
    crate::backup_database(&app, &conn, false, true)
        .map_err(|e| format!("无法创建删除前备份，未删除：{e}"))?;
    delete_publication(&conn, &root.to_string_lossy(), id)?;
    Ok(crate::backup_database(&app, &conn, false, false).err())
}

fn delete_publication(conn: &Connection, root: &str, id: i64) -> Result<(), String> {
    init(conn)?;
    if conn
        .execute(
            "DELETE FROM content_publications WHERE root=?1 AND id=?2",
            params![root, id],
        )
        .map_err(|e| e.to_string())?
        == 0
    {
        return Err("发布记录不存在".into());
    }
    Ok(())
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
    expected: Option<Material>,
    suggestion_key: Option<String>,
) -> Result<SaveResult, String> {
    let root = crate::workspace::root(&root)?;
    let mut conn = crate::database(&app)?;
    let id = save_material_with_key(
        &mut conn,
        &root.to_string_lossy(),
        &item,
        expected.as_ref(),
        suggestion_key.as_deref(),
    )?;
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
pub fn cli_import_media(root: &str, path: &str) -> Result<MediaFile, String> {
    copy_media(root, path).map(|(media, _)| media)
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
    expected: Option<Article>,
    suggestion_key: Option<String>,
) -> Result<SaveResult, String> {
    let root = crate::workspace::root(&root)?;
    let mut conn = crate::database(&app)?;
    let id = save_article_with_key(
        &mut conn,
        &root.to_string_lossy(),
        &item,
        expected.as_ref(),
        suggestion_key.as_deref(),
    )?;
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

pub fn cli_content(
    root: &str,
    operation: &str,
    input: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let root = crate::workspace::root(root)?.to_string_lossy().into_owned();
    let dir = dirs::data_dir()
        .ok_or("无法找到应用数据目录")?
        .join("com.seabird.workbench");
    cli_content_at(&root, operation, input, &dir)
}
fn cli_content_at(
    root: &str,
    operation: &str,
    input: Option<serde_json::Value>,
    dir: &std::path::Path,
) -> Result<serde_json::Value, String> {
    let mut conn = crate::database_at(dir)?;
    if operation == "list" {
        return serde_json::to_value(load(&conn, &root)?).map_err(|e| e.to_string());
    }
    let input = input.ok_or("缺少 JSON 输入")?;
    let value = input.get("item").ok_or("缺少 item")?.clone();
    let expected = input.get("expected").filter(|v| !v.is_null()).cloned();
    let id = match operation {
        "save-material" => {
            let item: Material =
                serde_json::from_value(value).map_err(|e| format!("素材格式错误：{e}"))?;
            let before: Option<Material> = expected
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("原始素材格式错误：{e}"))?;
            if item.id != 0 && before.is_none() {
                return Err("修改素材必须提供读取时的 expected 原始对象".into());
            }
            save_material_checked(&mut conn, &root, &item, before.as_ref())?
        }
        "save-article" => {
            let has_tags = value.get("tags").is_some();
            let mut item: Article =
                serde_json::from_value(value).map_err(|e| format!("文章格式错误：{e}"))?;
            let before: Option<Article> = expected
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| format!("原始文章格式错误：{e}"))?;
            if item.id != 0 && before.is_none() {
                return Err("修改文章必须提供读取时的 expected 原始对象".into());
            }
            if !has_tags {
                if let Some(before) = &before {
                    item.tags.clone_from(&before.tags);
                }
            }
            save_article_checked(&mut conn, &root, &item, before.as_ref())?
        }
        _ => return Err("未知内容操作".into()),
    };
    let warning = crate::backup::database(&conn, dir, false, false).err();
    Ok(serde_json::json!({"id":id,"backup_warning":warning}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn platform_defaults_are_added_once_without_replacing_custom_entries() {
        let conn = Connection::open_in_memory().unwrap();
        let custom = SocialPlatform {
            id: 0,
            name: "知乎".into(),
            image_url: "https://example.com/logo.png".into(),
            url: "https://example.com/publish".into(),
            types: vec!["article".into()],
            enabled: true,
        };
        save_platform(&conn, &custom).unwrap();
        seed_social_platforms(&conn).unwrap();
        let platforms = load_platforms(&conn).unwrap();
        assert_eq!(platforms.len(), 17);
        assert_eq!(
            platforms.iter().find(|p| p.name == "知乎").unwrap().url,
            custom.url
        );
        conn.execute("DELETE FROM social_platforms WHERE name='小红书'", [])
            .unwrap();
        seed_social_platforms(&conn).unwrap();
        assert_eq!(load_platforms(&conn).unwrap().len(), 16);
    }

    #[test]
    fn existing_platforms_receive_new_defaults_only_once() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn.execute(
            "INSERT INTO social_platform_metadata(key) VALUES ('defaults_v1')",
            [],
        )
        .unwrap();
        let custom = SocialPlatform {
            id: 0,
            name: "X".into(),
            image_url: "https://example.com/logo.png".into(),
            url: "https://example.com/".into(),
            types: vec!["article".into()],
            enabled: true,
        };
        let id = save_platform(&conn, &custom).unwrap();
        seed_social_platforms(&conn).unwrap();
        let platforms = load_platforms(&conn).unwrap();
        assert_eq!(platforms.len(), 13);
        assert_eq!(platforms.iter().find(|p| p.name == "X").unwrap().id, id);
        conn.execute("DELETE FROM social_platforms WHERE id=?1", [id])
            .unwrap();
        seed_social_platforms(&conn).unwrap();
        assert!(!load_platforms(&conn).unwrap().iter().any(|p| p.name == "X"));
    }

    #[test]
    fn platform_selection_persists_and_is_removed_with_platform() {
        let conn = Connection::open_in_memory().unwrap();
        seed_social_platforms(&conn).unwrap();
        let platforms = load_platforms(&conn).unwrap();
        assert_eq!(platforms.iter().filter(|p| p.enabled).count(), 5);
        let item = platforms.iter().find(|p| p.name == "Instagram").unwrap();
        assert!(!item.enabled);
        set_platform_enabled(&conn, item.id, true).unwrap();
        assert!(
            load_platforms(&conn)
                .unwrap()
                .iter()
                .find(|p| p.id == item.id)
                .unwrap()
                .enabled
        );
        set_platform_enabled(&conn, item.id, false).unwrap();
        conn.execute("DELETE FROM social_platforms WHERE id=?1", [item.id])
            .unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM social_platform_disabled WHERE platform_id=?1",
                [item.id],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert!(set_platform_enabled(&conn, item.id, true).is_err());
    }

    #[test]
    fn bulk_platform_selection_is_atomic() {
        let conn = Connection::open_in_memory().unwrap();
        seed_social_platforms(&conn).unwrap();
        let items = load_platforms(&conn).unwrap();
        let ids: Vec<i64> = items.iter().map(|item| item.id).collect();
        set_platforms_enabled(&conn, &ids, true).unwrap();
        assert!(load_platforms(&conn)
            .unwrap()
            .iter()
            .all(|item| item.enabled));
        assert!(set_platforms_enabled(&conn, &[ids[0], -1], false).is_err());
        assert!(load_platforms(&conn)
            .unwrap()
            .iter()
            .all(|item| item.enabled));
        set_platforms_enabled(&conn, &ids, false).unwrap();
        assert!(load_platforms(&conn)
            .unwrap()
            .iter()
            .all(|item| !item.enabled));
    }

    #[test]
    fn social_platforms_validate_and_round_trip() {
        let conn = Connection::open_in_memory().unwrap();
        let mut platform = SocialPlatform {
            id: 0,
            name: " 示例 ".into(),
            image_url: "https://example.com/icon.png".into(),
            url: "https://example.com/publish".into(),
            types: vec!["article".into(), "video".into()],
            enabled: true,
        };
        let id = save_platform(&conn, &platform).unwrap();
        let saved = load_platforms(&conn).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].name, "示例");
        assert_eq!(saved[0].types, vec!["article", "video"]);
        platform.id = id;
        platform.url = "javascript:alert(1)".into();
        assert!(save_platform(&conn, &platform).is_err());
        platform.url = "https://example.com/".into();
        platform.types.clear();
        assert!(save_platform(&conn, &platform).is_err());
        assert_eq!(load_platforms(&conn).unwrap(), saved);
    }

    #[test]
    fn publication_history_is_scoped_and_removed_with_article() {
        let mut db = Connection::open_in_memory().unwrap();
        let mut article = Article {
            id: 0,
            title: "第一篇".into(),
            body: "正文".into(),
            tags: String::new(),
            versions: BTreeMap::new(),
            material_ids: vec![],
            cover: None,
            updated_at: String::new(),
        };
        article.id = save_article(&mut db, "/one", &article).unwrap();
        let mut item = Publication {
            id: 0,
            article_id: article.id,
            article_title: String::new(),
            published_at: 1_700_000_000_000,
        };
        assert!(save_publication(&mut db, "/two", &item, None).is_err());
        item.id = save_publication(&mut db, "/one", &item, None).unwrap();
        let saved = load_publications(&db, "/one").unwrap().pop().unwrap();
        assert_eq!(saved.article_title, "第一篇");
        assert!(load_publications(&db, "/two").unwrap().is_empty());
        let changed = Publication {
            published_at: saved.published_at + 60_000,
            ..saved.clone()
        };
        save_publication(&mut db, "/one", &changed, Some(&saved)).unwrap();
        assert!(save_publication(&mut db, "/one", &saved, Some(&saved)).is_err());
        let another = Publication {
            id: 0,
            published_at: saved.published_at + 120_000,
            ..saved.clone()
        };
        let second_id = save_publication(&mut db, "/one", &another, None).unwrap();
        assert_eq!(load_publications(&db, "/one").unwrap().len(), 2);
        assert!(delete_publication(&db, "/two", second_id).is_err());
        delete_publication(&db, "/one", second_id).unwrap();
        assert_eq!(load(&db, "/one").unwrap().articles.len(), 1);
        save_publication(&mut db, "/one", &another, None).unwrap();
        article.title = "更新后的标题".into();
        save_article(&mut db, "/one", &article).unwrap();
        assert_eq!(
            load_publications(&db, "/one").unwrap()[0].article_title,
            "更新后的标题"
        );
        delete(&db, "/one", "article", article.id).unwrap();
        assert!(load_publications(&db, "/one").unwrap().is_empty());
    }
    #[test]
    fn suggestion_saves_are_idempotent_and_workspace_scoped() {
        let mut db = Connection::open_in_memory().unwrap();
        let key = "a".repeat(64);
        let material = Material {
            id: 0,
            title: "素材".into(),
            source: String::new(),
            url: String::new(),
            note: "内容".into(),
            tags: String::new(),
            media: vec![],
            updated_at: String::new(),
        };
        let article = Article {
            id: 0,
            title: "文章".into(),
            body: "正文".into(),
            tags: String::new(),
            versions: BTreeMap::new(),
            material_ids: vec![],
            cover: None,
            updated_at: String::new(),
        };
        let first = save_material_with_key(&mut db, "/one", &material, None, Some(&key)).unwrap();
        assert_eq!(
            first,
            save_material_with_key(&mut db, "/one", &material, None, Some(&key)).unwrap()
        );
        assert_eq!(load(&db, "/one").unwrap().materials.len(), 1);
        assert!(save_article_with_key(&mut db, "/one", &article, None, Some(&key)).is_err());
        save_material_with_key(&mut db, "/two", &material, None, Some(&key)).unwrap();
        assert_eq!(load(&db, "/two").unwrap().materials.len(), 1);
        delete(&db, "/one", "material", first).unwrap();
        save_material(&mut db, "/one", &material).unwrap();
        save_material_with_key(&mut db, "/one", &material, None, Some(&key)).unwrap();
        assert_eq!(load(&db, "/one").unwrap().materials.len(), 2);
        let article_key = "b".repeat(64);
        let id =
            save_article_with_key(&mut db, "/one", &article, None, Some(&article_key)).unwrap();
        assert_eq!(
            id,
            save_article_with_key(&mut db, "/one", &article, None, Some(&article_key)).unwrap()
        );
        assert_eq!(load(&db, "/one").unwrap().articles.len(), 1);
        assert!(save_material_with_key(&mut db, "/one", &material, None, Some("invalid")).is_err());
    }
    #[test]
    fn source_links_only_allow_web_urls() {
        assert!(source_url(" https://example.com/path?q=1 ").is_ok());
        assert!(source_url("http://example.com").is_ok());
        for invalid in [
            "",
            "example.com",
            "file:///tmp/a",
            "javascript:alert(1)",
            "https://",
        ] {
            assert!(source_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn article_tags_migrate_old_database_and_detect_concurrent_changes() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE content_articles (id INTEGER PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', versions TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO content_articles(root,title,body,versions) VALUES('/workspace','旧文章','保留的正文','{\"x\":{\"title\":\"标题\",\"body\":\"平台正文\"}}');").unwrap();
        let original = load(&db, "/workspace").unwrap().articles.remove(0);
        assert_eq!(original.tags, "");
        assert_eq!(original.body, "保留的正文");
        assert_eq!(original.versions["x"].body, "平台正文");
        let mut updated = original.clone();
        updated.tags = "AI,内容，研究".into();
        save_article_checked(&mut db, "/workspace", &updated, Some(&original)).unwrap();
        assert_eq!(
            load(&db, "/workspace").unwrap().articles[0].tags,
            "AI,内容，研究"
        );
        let mut stale = original.clone();
        stale.body = "旧正文".into();
        assert!(save_article_checked(&mut db, "/workspace", &stale, Some(&original)).is_err());
        init(&db).unwrap();
        assert_eq!(load(&db, "/workspace").unwrap().articles.len(), 1);
    }
    #[test]
    fn article_cover_migrates_round_trips_and_guards_conflicts() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE content_articles (id INTEGER PRIMARY KEY, root TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', versions TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO content_articles(root,title) VALUES('/workspace','旧文章');").unwrap();
        let original = load(&db, "/workspace").unwrap().articles.remove(0);
        assert_eq!(original.cover, None);
        let mut updated = original.clone();
        updated.cover = Some(MediaFile {
            path: "/workspace/seabird-media/cover.png".into(),
            name: "cover.png".into(),
            kind: "image".into(),
        });
        save_article_checked(&mut db, "/workspace", &updated, Some(&original)).unwrap();
        let saved = load(&db, "/workspace").unwrap().articles.remove(0);
        assert_eq!(saved.cover, updated.cover);
        assert!(save_article_checked(&mut db, "/workspace", &original, Some(&original)).is_err());
        let mut invalid = saved.clone();
        invalid.cover.as_mut().unwrap().path = "/other/cover.png".into();
        assert!(save_article_checked(&mut db, "/workspace", &invalid, Some(&saved)).is_err());
        invalid.cover.as_mut().unwrap().path = "/workspace/seabird-media/cover.mp4".into();
        invalid.cover.as_mut().unwrap().kind = "video".into();
        assert!(save_article_checked(&mut db, "/workspace", &invalid, Some(&saved)).is_err());
        let mut removed = saved.clone();
        removed.cover = None;
        save_article_checked(&mut db, "/workspace", &removed, Some(&saved)).unwrap();
        assert_eq!(load(&db, "/workspace").unwrap().articles[0].cover, None);
    }
    #[test]
    fn agent_content_roundtrip_guards_concurrent_edits_and_preserves_links() {
        let base = std::env::temp_dir().join(format!(
            "seabird-agent-content-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app = base.join("app");
        let root = base.join("workspace");
        std::fs::create_dir_all(&root).unwrap();
        let workspace = root.to_str().unwrap();
        let material = serde_json::json!({"id":0,"title":"来源","source":"网站","url":"https://example.com","note":"素材","tags":"","media":[],"updated_at":""});
        let saved = cli_content_at(
            workspace,
            "save-material",
            Some(serde_json::json!({"item":material})),
            &app,
        )
        .unwrap();
        let mid = saved["id"].as_i64().unwrap();
        let article = serde_json::json!({"id":0,"title":"初稿","body":"正文","tags":"AI,创作","versions":{"wechat":{"title":"公众号","body":"原文"}},"material_ids":[mid],"updated_at":""});
        let saved = cli_content_at(
            workspace,
            "save-article",
            Some(serde_json::json!({"item":article})),
            &app,
        )
        .unwrap();
        let id = saved["id"].as_i64().unwrap();
        let data = cli_content_at(workspace, "list", None, &app).unwrap();
        let original = data["articles"][0].clone();
        assert_eq!(original["material_ids"], serde_json::json!([mid]));
        let mut updated = original.clone();
        // Older agents can omit this newly introduced field while modifying text.
        updated.as_object_mut().unwrap().remove("tags");
        updated["body"] = serde_json::json!("修改后");
        assert!(cli_content_at(
            workspace,
            "save-article",
            Some(serde_json::json!({"item":updated})),
            &app
        )
        .is_err());
        cli_content_at(
            workspace,
            "save-article",
            Some(serde_json::json!({"item":updated,"expected":original})),
            &app,
        )
        .unwrap();
        let mut stale = original.clone();
        stale["title"] = serde_json::json!("旧修改");
        assert!(cli_content_at(
            workspace,
            "save-article",
            Some(serde_json::json!({"item":stale,"expected":original})),
            &app
        )
        .is_err());
        let result = cli_content_at(workspace, "list", None, &app).unwrap();
        assert_eq!(result["articles"][0]["id"], id);
        assert_eq!(result["articles"][0]["body"], "修改后");
        assert_eq!(result["articles"][0]["tags"], "AI,创作");
        assert_eq!(result["articles"][0]["versions"]["wechat"]["body"], "原文");
        assert_eq!(
            result["articles"][0]["material_ids"],
            serde_json::json!([mid])
        );
        let other = base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let other_result = cli_content_at(other.to_str().unwrap(), "list", None, &app).unwrap();
        assert_eq!(other_result["articles"].as_array().unwrap().len(), 0);
        assert!(base
            .join("com.seabird.workbench-backups/workbench-latest.sqlite3")
            .is_file());
        std::fs::remove_dir_all(base).unwrap();
    }
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
            tags: String::new(),
            body: "原稿".into(),
            versions,
            material_ids: vec![mid],
            cover: None,
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
