//! Model Context Protocol (MCP) server configuration and stdio client.
//!
//! MCP stdio transports are newline-delimited JSON-RPC messages.  We keep the
//! process alive for the lifetime of an agent instance, discover its tools at
//! startup, and expose every discovered tool through IsanAgent's `Tool` trait.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use isanagent::traits::Tool;

use super::workspace::WorkspaceRegistry;

const CONFIG_FILE: &str = "mcp.json";
const PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct ToolsListResult {
    #[serde(default)]
    tools: Vec<RemoteTool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTool {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "empty_schema")]
    input_schema: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProbeTool {
    pub name: String,
    pub description: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpProbeResult {
    pub tools: Vec<McpProbeTool>,
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn config_path(workspace: &Path) -> PathBuf {
    workspace.join(".isanagent").join(CONFIG_FILE)
}

fn validate_server(server: &McpServerConfig) -> Result<(), String> {
    if server.id.trim().is_empty()
        || !server
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Server id may only contain letters, numbers, '-' and '_'.".into());
    }
    if server.name.trim().is_empty() {
        return Err("Server name is required.".into());
    }
    if server.command.trim().is_empty() {
        return Err("Server command is required.".into());
    }
    Ok(())
}

fn authorized_workspace(
    workspace_path: &str,
    registry: &WorkspaceRegistry,
) -> Result<PathBuf, String> {
    let canonical = registry
        .canonicalize_cached(workspace_path)
        .map_err(|e| format!("Workspace is not accessible: {e}"))?;
    if !canonical.is_dir() || !registry.is_authorized(&canonical) {
        return Err("Workspace is not authorized.".into());
    }
    Ok(canonical)
}

/// Read the workspace's saved server definitions. Invalid/missing config is
/// deliberately non-fatal at runtime: a bad optional integration must not
/// stop the built-in agent from starting.
pub fn load_servers(workspace: &Path) -> Result<Vec<McpServerConfig>, String> {
    let path = config_path(workspace);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("Could not read MCP config: {e}"))?;
    let servers: Vec<McpServerConfig> =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid MCP config: {e}"))?;
    for server in &servers {
        validate_server(server)?;
    }
    Ok(servers)
}

#[tauri::command]
pub fn mcp_get_servers(
    workspace_path: String,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<Vec<McpServerConfig>, String> {
    load_servers(&authorized_workspace(&workspace_path, &registry)?)
}

#[tauri::command]
pub fn mcp_save_servers(
    workspace_path: String,
    servers: Vec<McpServerConfig>,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<(), String> {
    let workspace = authorized_workspace(&workspace_path, &registry)?;
    let mut ids = std::collections::HashSet::new();
    for server in &servers {
        validate_server(server)?;
        if !ids.insert(server.id.clone()) {
            return Err(format!("Duplicate MCP server id: {}", server.id));
        }
    }
    let path = config_path(&workspace);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid MCP config path".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Could not create MCP directory: {e}"))?;
    let serialized = serde_json::to_string_pretty(&servers)
        .map_err(|e| format!("Could not serialize MCP config: {e}"))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, serialized).map_err(|e| format!("Could not write MCP config: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("Could not save MCP config: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_probe_server(
    workspace_path: String,
    server: McpServerConfig,
    registry: State<'_, WorkspaceRegistry>,
) -> Result<McpProbeResult, String> {
    validate_server(&server)?;
    let workspace = authorized_workspace(&workspace_path, &registry)?;
    probe_server(&server, &workspace).await
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

struct McpClient {
    writer: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Pending,
    next_id: AtomicU64,
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // The runtime drops MCP tools with the agent instance. `start_kill` is
        // non-blocking, so it is safe in Drop and prevents orphaned stdio
        // servers after a model/workspace switch.
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

impl McpClient {
    async fn start(server: &McpServerConfig, cwd: &Path) -> Result<Arc<Self>, String> {
        let mut command = Command::new(server.command.trim());
        command
            .args(&server.args)
            .current_dir(cwd)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "");
        command.envs(&server.env);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start '{}': {e}", server.name))?;
        let writer = child
            .stdin
            .take()
            .ok_or_else(|| "MCP stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP stdout unavailable".to_string())?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_for_reader = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                let result = if let Some(error) = message.get("error") {
                    Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("MCP server returned an error")
                        .to_string())
                } else {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                };
                if let Some(tx) = pending_for_reader.lock().await.remove(&id) {
                    let _ = tx.send(result);
                }
            }
            let mut waiting = pending_for_reader.lock().await;
            for (_, tx) in waiting.drain() {
                let _ = tx.send(Err("MCP server closed its connection.".into()));
            }
        });
        Ok(Arc::new(Self {
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pending,
            next_id: AtomicU64::new(1),
        }))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let write = async {
            let mut writer = self.writer.lock().await;
            writer
                .write_all(message.to_string().as_bytes())
                .await
                .map_err(|e| format!("MCP write failed: {e}"))?;
            writer
                .write_all(b"\n")
                .await
                .map_err(|e| format!("MCP write failed: {e}"))?;
            writer
                .flush()
                .await
                .map_err(|e| format!("MCP flush failed: {e}"))
        }
        .await;
        if let Err(error) = write {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("MCP response channel closed.".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("MCP request '{method}' timed out."))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut writer = self.writer.lock().await;
        writer
            .write_all(message.to_string().as_bytes())
            .await
            .map_err(|e| format!("MCP write failed: {e}"))?;
        writer
            .write_all(b"\n")
            .await
            .map_err(|e| format!("MCP write failed: {e}"))?;
        writer
            .flush()
            .await
            .map_err(|e| format!("MCP flush failed: {e}"))
    }
}

pub struct McpTool {
    name: String,
    description: String,
    parameters: Value,
    remote_name: String,
    client: Arc<McpClient>,
}

#[async_trait::async_trait]
impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn parameters(&self) -> Value {
        self.parameters.clone()
    }

    async fn execute(&self, args: Value) -> Result<String, String> {
        let result = self
            .client
            .request(
                "tools/call",
                json!({
                    "name": self.remote_name,
                    "arguments": args,
                }),
            )
            .await?;
        serde_json::to_string(&result).map_err(|e| format!("Could not read MCP tool result: {e}"))
    }
}

fn tool_name(server_id: &str, remote_name: &str) -> String {
    let normalized: String = remote_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    format!("mcp_{server_id}_{normalized}")
}

/// Connect an enabled server and transform its advertised tools into agent
/// tools. A single failed optional server is returned as an error to the
/// caller, which can log-and-continue with the remaining integrations.
pub async fn connect_server(server: &McpServerConfig, cwd: &Path) -> Result<Vec<McpTool>, String> {
    let client = McpClient::start(server, cwd).await?;
    client
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "ALTAI", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await?;
    client
        .notify("notifications/initialized", json!({}))
        .await?;
    let listed: ToolsListResult =
        serde_json::from_value(client.request("tools/list", json!({})).await?)
            .map_err(|e| format!("Invalid tools/list response from '{}': {e}", server.name))?;
    Ok(listed
        .tools
        .into_iter()
        .map(|remote| McpTool {
            name: tool_name(&server.id, &remote.name),
            description: if remote.description.trim().is_empty() {
                format!("MCP tool '{}' from {}", remote.name, server.name)
            } else {
                format!("[MCP: {}] {}", server.name, remote.description)
            },
            parameters: remote.input_schema,
            remote_name: remote.name,
            client: client.clone(),
        })
        .collect())
}

/// Start a short-lived server connection and report its advertised tools.
/// Used by Settings' Test button; dropping the returned client terminates the
/// child immediately after discovery, so it cannot leak into the next run.
pub async fn probe_server(server: &McpServerConfig, cwd: &Path) -> Result<McpProbeResult, String> {
    let client = McpClient::start(server, cwd).await?;
    client
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "ALTAI", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await?;
    client
        .notify("notifications/initialized", json!({}))
        .await?;
    let listed: ToolsListResult =
        serde_json::from_value(client.request("tools/list", json!({})).await?)
            .map_err(|e| format!("Invalid tools/list response from '{}': {e}", server.name))?;
    Ok(McpProbeResult {
        tools: listed
            .tools
            .into_iter()
            .map(|tool| McpProbeTool {
                name: tool.name,
                description: tool.description,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_names_are_stable_and_safe() {
        assert_eq!(tool_name("files", "Read File"), "mcp_files_read_file");
        assert_eq!(tool_name("github", "issues/list"), "mcp_github_issues_list");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connects_and_discovers_tools_over_stdio() {
        // A tiny newline-JSON-RPC fixture validates the same initialize →
        // initialized notification → tools/list path used by a real MCP server.
        let server = McpServerConfig {
            id: "fixture".into(),
            name: "Fixture".into(),
            command: "sh".into(),
            args: vec![
                "-c".into(),
                r#"while IFS= read -r line; do case "$line" in *"initialize"*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;; *"tools/list"*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echoes input","inputSchema":{"type":"object"}}]}}' ;; esac; done"#.into(),
            ],
            env: HashMap::new(),
            enabled: true,
        };
        let tools = connect_server(&server, Path::new("/tmp")).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name(), "mcp_fixture_echo");
        assert_eq!(tools[0].description(), "[MCP: Fixture] Echoes input");
    }
}
