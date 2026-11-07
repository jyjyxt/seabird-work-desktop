//! Local backups in an application-data sibling directory, outside the workspace.
use rusqlite::Connection;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn folder(app_dir: &Path) -> Result<PathBuf, String> {
    let path = app_dir
        .parent()
        .ok_or("无法找到应用数据目录")?
        .join("com.seabird.workbench-backups");
    fs::create_dir_all(&path).map_err(|e| format!("无法创建备份目录：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(path)
}
fn private_file(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn unique(path: &Path, suffix: &str) -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.join(format!(".{suffix}-{}-{now}.tmp", std::process::id()))
}
fn with_lock<T>(dir: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let mut lock = Connection::open(dir.join("backup-lock.sqlite3")).map_err(|e| e.to_string())?;
    private_file(&dir.join("backup-lock.sqlite3"))?;
    lock.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    let transaction = lock
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let result = f()?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(result)
}
pub fn database(
    conn: &Connection,
    app_dir: &Path,
    throttle: bool,
    preserve: bool,
) -> Result<(), String> {
    let dir = folder(app_dir)?;
    with_lock(&dir, || {
        let latest = dir.join("workbench-latest.sqlite3");
        if throttle
            && latest
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|d| d < Duration::from_secs(300))
        {
            return Ok(());
        }
        let temp = unique(&dir, "database");
        let name = temp.to_str().ok_or("备份路径无效")?;
        if let Err(error) = conn.execute("VACUUM INTO ?1", [name]) {
            let _ = fs::remove_file(&temp);
            return Err(format!("数据库备份失败：{error}"));
        }
        private_file(&temp)?;
        if preserve {
            let prior = unique(&dir, "before-delete");
            fs::copy(&temp, &prior).map_err(|e| e.to_string())?;
            private_file(&prior)?;
            fs::rename(&prior, dir.join("workbench-before-delete.sqlite3"))
                .map_err(|e| e.to_string())?;
        }
        fs::rename(&temp, &latest).map_err(|e| format!("数据库备份失败：{e}"))?;
        Ok(())
    })
}
pub fn configuration(source: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    let app_dir = dirs::data_dir()
        .ok_or("无法找到应用数据目录")?
        .join("com.seabird.workbench");
    configuration_at(source, &app_dir)
}
fn configuration_at(source: &Path, app_dir: &Path) -> Result<(), String> {
    let dir = folder(app_dir)?;
    with_lock(&dir, || {
        let temp = unique(&dir, "config");
        fs::copy(source, &temp).map_err(|e| e.to_string())?;
        private_file(&temp)?;
        fs::rename(&temp, dir.join("connections-latest.json")).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_are_readable_without_daily_copies() {
        let base = std::env::temp_dir().join(format!(
            "seabird-backup-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let app = base.join("app");
        fs::create_dir_all(&app).unwrap();
        let conn = Connection::open(app.join("workbench.sqlite3")).unwrap();
        let config = app.join("connections.json");
        fs::write(&config, "original").unwrap();
        configuration_at(&config, &app).unwrap();
        fs::write(&config, "updated").unwrap();
        configuration_at(&config, &app).unwrap();
        conn.execute_batch("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('before');")
            .unwrap();
        database(&conn, &app, false, false).unwrap();
        conn.execute("UPDATE data SET value='after'", []).unwrap();
        database(&conn, &app, true, false).unwrap();
        let dir = base.join("com.seabird.workbench-backups");
        let throttled = Connection::open(dir.join("workbench-latest.sqlite3")).unwrap();
        assert_eq!(
            throttled
                .query_row("SELECT value FROM data", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "before"
        );
        drop(throttled);
        database(&conn, &app, false, true).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("connections-latest.json")).unwrap(),
            "updated"
        );
        let latest = Connection::open(dir.join("workbench-latest.sqlite3")).unwrap();
        assert_eq!(
            latest
                .query_row("SELECT value FROM data", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "after"
        );
        assert!(!fs::read_dir(&dir).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("-day-")));
        let old_daily = dir.join("workbench-day-1.sqlite3");
        fs::write(&old_daily, "old backup").unwrap();
        database(&conn, &app, false, false).unwrap();
        assert_eq!(fs::read_to_string(old_daily).unwrap(), "old backup");
        let before_delete = Connection::open(dir.join("workbench-before-delete.sqlite3")).unwrap();
        assert_eq!(
            before_delete
                .query_row("SELECT value FROM data", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "after"
        );
        drop(before_delete);
        drop(latest);
        drop(conn);
        fs::remove_dir_all(base).unwrap();
    }
}
