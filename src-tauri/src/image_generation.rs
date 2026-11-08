//! Image generation using the user's configured Codex provider, without exposing credentials to agents.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRequest {
    pub prompt: String,
}

struct Provider {
    base: reqwest::Url,
    key: String,
}

fn read_provider(home: &Path) -> Result<Provider, String> {
    let config = std::fs::read_to_string(home.join("config.toml"))
        .map_err(|_| "无法读取 Codex 配置，请先配置支持生图的服务".to_string())?;
    let config: toml::Value =
        toml::from_str(&config).map_err(|_| "Codex 配置格式不正确".to_string())?;
    let provider_name = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .ok_or("Codex 未配置自定义模型服务")?;
    let provider = config
        .get("model_providers")
        .and_then(|v| v.get(provider_name))
        .ok_or("未找到 Codex 模型服务配置")?;
    let base = provider
        .get("base_url")
        .and_then(toml::Value::as_str)
        .ok_or("Codex 模型服务未配置地址")?;
    let mut base = reqwest::Url::parse(base).map_err(|_| "Codex 模型服务地址无效")?;
    if base.scheme() != "https"
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err("Codex 模型服务地址必须是安全的 HTTPS 地址".into());
    }
    let path = format!("{}/", base.path().trim_end_matches('/'));
    base.set_path(&path);
    let key = if let Some(env_key) = provider.get("env_key").and_then(toml::Value::as_str) {
        std::env::var(env_key)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or("Codex 模型服务配置的凭据不可用")?
    } else if provider
        .get("requires_openai_auth")
        .and_then(toml::Value::as_bool)
        == Some(true)
    {
        let auth: Value = serde_json::from_slice(
            &std::fs::read(home.join("auth.json"))
                .map_err(|_| "无法读取 Codex 登录信息".to_string())?,
        )
        .map_err(|_| "Codex 登录信息格式不正确")?;
        auth.get("OPENAI_API_KEY")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .ok_or("当前 Codex 登录没有可用于该服务的凭据")?
            .to_owned()
    } else {
        return Err("当前 Codex 服务没有配置可用的生图凭据".into());
    };
    Ok(Provider { base, key })
}

fn response_json(response: reqwest::blocking::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "生图服务拒绝了当前凭据，请检查 Codex 服务配置".into(),
            429 => "生图服务暂时达到使用限制，请稍后重试".into(),
            _ => format!("生图服务请求失败（HTTP {}）", status.as_u16()),
        });
    }
    const MAX_RESPONSE: u64 = 45 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > MAX_RESPONSE) {
        return Err("生图服务返回的图片过大".into());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_RESPONSE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取生图服务结果失败")?;
    if bytes.len() as u64 > MAX_RESPONSE {
        return Err("生图服务返回的图片过大".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "生图服务返回的数据格式不正确".into())
}

fn select_model(value: &Value) -> Option<&str> {
    let models = value.get("data")?.as_array()?;
    // Prefer the models explicitly supported by the configured service. Do not silently downgrade to 1.5.
    ["gpt-image-2.5", "gpt-image-2"]
        .into_iter()
        .find(|candidate| {
            models
                .iter()
                .any(|m| m.get("id").and_then(Value::as_str) == Some(candidate))
        })
}

fn request_image(provider: &Provider, prompt: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(240))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法连接生图服务")?;
    let models_url = provider
        .base
        .join("models")
        .map_err(|_| "Codex 模型服务地址无效")?;
    let models = response_json(
        client
            .get(models_url)
            .bearer_auth(&provider.key)
            .send()
            .map_err(|_| "无法连接生图服务，请检查网络和服务地址")?,
    )?;
    let model = select_model(&models).ok_or("当前 Codex 服务未提供支持的生图模型")?;
    let url = provider
        .base
        .join("images/generations")
        .map_err(|_| "Codex 模型服务地址无效")?;
    let result = response_json(
        client
            .post(url)
            .bearer_auth(&provider.key)
            .json(&json!({"model": model, "prompt": prompt, "size":"1536x1024", "n":1}))
            .send()
            .map_err(|_| "生图请求失败，请检查网络后重试")?,
    )?;
    let encoded = result
        .get("data")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .and_then(|v| v.get("b64_json"))
        .and_then(Value::as_str)
        .ok_or("生图服务没有返回图片")?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "生图服务返回的图片无法读取")?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("生图服务返回的图片格式不是 PNG".into());
    }
    Ok(bytes)
}

pub fn generate(workspace: &str, prompt: &str) -> Result<crate::content::MediaFile, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > 50_000 {
        return Err("图片描述不能为空或超过长度限制".into());
    }
    let root = crate::workspace::root(workspace)?;
    let home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .ok_or("无法找到 Codex 配置目录")?;
    let provider = read_provider(&home)?;
    let bytes = request_image(&provider, prompt)?;
    let directory = root.join("seabird-media");
    std::fs::create_dir_all(&directory).map_err(|_| "无法创建素材目录")?;
    let directory = directory.canonicalize().map_err(|_| "无法打开素材目录")?;
    if directory.parent() != Some(root.as_path()) {
        return Err("素材目录不能指向工作目录之外".into());
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let target = directory.join(format!("{timestamp}.png"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|_| "无法保存生成的图片")?;
    use std::io::Write;
    if file.write_all(&bytes).is_err() {
        drop(file);
        let _ = std::fs::remove_file(&target);
        return Err("无法保存生成的图片".into());
    }
    Ok(crate::content::MediaFile {
        path: target.to_string_lossy().into_owned(),
        name: "生成的图片.png".into(),
        kind: "image".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_provider_from_normal_toml_document() {
        let path =
            std::env::temp_dir().join(format!("seabird-image-config-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("config.toml"), "model_provider = \"test\"\n[model_providers.test]\nbase_url = \"https://example.test/v1\"\nrequires_openai_auth = true\n").unwrap();
        std::fs::write(
            path.join("auth.json"),
            r#"{"OPENAI_API_KEY":"test-secret"}"#,
        )
        .unwrap();
        let provider = read_provider(&path).unwrap();
        assert_eq!(provider.base.as_str(), "https://example.test/v1/");
        assert_eq!(provider.key, "test-secret");
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn model_selection_uses_available_image_model_without_downgrade() {
        assert_eq!(
            select_model(&json!({"data":[{"id":"gpt-image-2"},{"id":"gpt-image-2.5"}]})),
            Some("gpt-image-2.5")
        );
        assert_eq!(
            select_model(&json!({"data":[{"id":"gpt-image-2"}]})),
            Some("gpt-image-2")
        );
        assert_eq!(
            select_model(&json!({"data":[{"id":"gpt-image-1.5"}]})),
            None
        );
    }
}
