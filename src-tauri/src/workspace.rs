//! Shared workspace path and text-file operations for the UI and MCP.
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

pub fn root(path: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(path).map_err(|e| format!("无法打开工作目录：{e}"))?;
    if !root.is_dir() {
        return Err("工作目录必须是文件夹".into());
    }
    Ok(root)
}

pub fn resolve(
    root: &Path,
    path: &str,
    allow_new: bool,
    relative_only: bool,
) -> Result<PathBuf, String> {
    let path = Path::new(path);
    if relative_only
        && (path.is_absolute()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)))
    {
        return Err("路径必须位于工作目录内".into());
    }
    let joined = root.join(path);
    let checked = if allow_new
        && fs::symlink_metadata(&joined).is_err_and(|e| e.kind() == io::ErrorKind::NotFound)
    {
        let parent = joined
            .parent()
            .ok_or("路径没有父目录")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        parent.join(joined.file_name().ok_or("路径缺少文件名")?)
    } else {
        joined.canonicalize().map_err(|e| e.to_string())?
    };
    if !checked.starts_with(root) {
        return Err("路径不在工作目录内".into());
    }
    Ok(checked)
}

pub fn read(path: &Path) -> Result<String, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > 2_000_000 {
        return Err("文件超过 2 MB".into());
    }
    fs::read_to_string(path).map_err(|e| format!("无法读取文本文件：{e}"))
}

pub fn write(path: &Path, content: &str) -> Result<(), String> {
    if content.len() > 2_000_000 {
        return Err("文件超过 2 MB".into());
    }
    fs::write(path, content).map_err(|e| format!("保存失败：{e}"))
}
