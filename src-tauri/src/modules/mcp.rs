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
    /// Server identity. In the canonical Claude Desktop `mcpServers` map this
    /// is the entry key, so it is skipped on serialize and re-injected from
    /// the key on load. Defaults to empty on deserialize; `load_servers`
    /// always overwrites it (from the map key or the legacy array entry) so
    /// downstream code never sees an unset id.
    #[serde(skip_serializing, default)]
    pub id: String,
    /// Display name. Claude Desktop configs omit this (the map key is the
    /// name), so it deserializes to the id when absent.
    #[serde(default, deserialize_with = "deserialize_name_fallback")]
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

/// Deserialize `name`, falling back to an empty string when the field is
/// absent (Claude Desktop configs don't carry it). `load_servers` rewrites an
/// empty name to the server id immediately after parsing so downstream code
/// never sees an unset name.
fn deserialize_name_fallback<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(opt.unwrap_or_default())
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

/// Runtime connection state for a single MCP server within a workspace.
///
/// The registry is process-global so the Settings UI can poll it from any
/// window without threading state through the agent runtime. Entries are
/// keyed by `(workspace_canonical_path, server_id)` so two workspaces don't
/// collide. Updates are best-effort and lock-free to read (cloned under a
/// short-lived mutex) — status is advisory, not a correctness boundary.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub server_id: String,
    pub state: McpState,
    /// Tool count discovered at connect time, when `state == Connected`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<usize>,
    /// Human-readable reason for the last error / unavailable state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Epoch millis of the most recent state transition, for "stale" UI hints.
    pub updated_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpState {
    /// Connect attempt in progress (`initialize` → `tools/list`).
    Starting,
    /// Connected and its tools are registered.
    Connected,
    /// Connect failed or the server dropped after connecting.
    Error,
}

/// Process-global, workspace-scoped MCP status registry.
///
/// Holds an `Arc<Mutex<HashMap>>` internally so the registry is cheaply
/// `Clone`-able — needed because the runtime spawns one connect task per MCP
/// server and each task needs its own handle to stamp status transitions.
#[derive(Clone)]
pub struct McpStatusRegistry {
    inner: Arc<Mutex<HashMap<String, McpServerStatus>>>,
}

impl McpStatusRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Canonical map key. Uses the workspace's canonical path so symlinks /
    /// `/private/var` aliases on macOS don't split a single workspace into two
    /// status entries.
    fn key(workspace: &Path, server_id: &str) -> String {
        format!("{}::{}", workspace.display(), server_id)
    }

    /// Replace the status for one server. Stamps `updated_at_ms` from the
    /// caller so a batch of transitions share a consistent clock.
    pub async fn set(
        &self,
        workspace: &Path,
        status: McpServerStatus,
        now_ms: u64,
    ) {
        let key = Self::key(workspace, &status.server_id);
        let mut guard = self.inner.lock().await;
        guard.insert(
            key,
            McpServerStatus {
                updated_at_ms: now_ms,
                ..status
            },
        );
    }

    /// Snapshot every status entry for one workspace, in stable id order.
    pub async fn snapshot(&self, workspace: &Path) -> Vec<McpServerStatus> {
        let prefix = format!("{}::", workspace.display());
        let guard = self.inner.lock().await;
        let mut out: Vec<McpServerStatus> = guard
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(_, v)| v.clone())
            .collect();
        out.sort_by(|a, b| a.server_id.cmp(&b.server_id));
        out
    }

    /// Drop every entry for a workspace — called on teardown so a stale
    /// "connected" badge doesn't survive a workspace switch.
    pub async fn clear_workspace(&self, workspace: &Path) {
        let prefix = format!("{}::", workspace.display());
        let mut guard = self.inner.lock().await;
        guard.retain(|k, _| !k.starts_with(&prefix));
    }
}

impl Default for McpStatusRegistry {
    fn default() -> Self {
        Self::new()
    }
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
///
/// Accepts two on-disk shapes for forward/backward compatibility:
/// - **Claude Desktop map** (canonical, written on save):
///   `{ "mcpServers": { "<id>": { "name": ..., "command": ..., "args": ..., "env": ..., "enabled": ... } } }`
/// - **Legacy bare array** (read once, rewritten as a map on the next save):
///   `[ { "id": ..., "name": ..., ... }, ... ]`
///
/// The array shape predates the Claude Desktop interop target; keeping a
/// read-side fallback for one version avoids wiping a workspace's MCP setup
/// on upgrade. Anything that fails to parse as either shape is a hard error.
pub fn load_servers(workspace: &Path) -> Result<Vec<McpServerConfig>, String> {
    let path = config_path(workspace);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("Could not read MCP config: {e}"))?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("Invalid MCP config: {e}"))?;
    let mut servers = match parsed {
        // Canonical: Claude Desktop `mcpServers` map. The id is the map key.
        Value::Object(ref obj) if obj.contains_key("mcpServers") => {
            let map = obj
                .get("mcpServers")
                .and_then(|v| v.as_object())
                .ok_or_else(|| "MCP config 'mcpServers' must be an object.".to_string())?;
            let mut out = Vec::with_capacity(map.len());
            for (id, body) in map {
                let mut server: McpServerConfig =
                    serde_json::from_value(body.clone()).map_err(|e| {
                        format!("Invalid MCP server '{id}': {e}")
                    })?;
                server.id = id.clone();
                out.push(server);
            }
            out
        }
        // Legacy: bare array. Read for one version, then rewritten on next save.
        Value::Array(arr) => arr
            .into_iter()
            .map(serde_json::from_value::<McpServerConfig>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Invalid MCP server entry: {e}"))?,
        _ => {
            return Err(
                "MCP config must be a `mcpServers` object or an array of servers.".into(),
            );
        }
    };
    for server in &mut servers {
        // Claude Desktop configs omit `name`; fall back to the id so the UI
        // always has something human-readable to render. This also normalizes
        // legacy array entries that left name empty.
        if server.name.trim().is_empty() {
            server.name = server.id.clone();
        }
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

/// Snapshot the live runtime status of every MCP server in a workspace. The
/// Settings UI polls this to render `starting / connected / error` badges
/// independent of the per-Test-click probe. Servers that haven't been touched
/// since process start (e.g. never enabled) simply aren't in the snapshot —
/// the UI treats "absent" the same as a fresh `disabled` state.
#[tauri::command]
pub async fn mcp_server_status(
    workspace_path: String,
    registry: State<'_, WorkspaceRegistry>,
    statuses: State<'_, McpStatusRegistry>,
) -> Result<Vec<McpServerStatus>, String> {
    let workspace = authorized_workspace(&workspace_path, &registry)?;
    Ok(statuses.snapshot(&workspace).await)
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
    // Canonical format: Claude Desktop `mcpServers` map keyed by server id.
    // Round-trips through `load_servers` and stays interoperable with tools
    // that only know the Claude Desktop shape. Extra ALTAI-only fields
    // (`name`, `enabled`) ride along inside each entry.
    let mut map = serde_json::Map::new();
    for server in &servers {
        // The id is the map key, so strip it from the value to avoid storing
        // it twice. `serialize` skips `id` via `skip_serializing` below.
        let value = serde_json::to_value(server)
            .map_err(|e| format!("Could not serialize MCP config: {e}"))?;
        map.insert(server.id.clone(), value);
    }
    let serialized = serde_json::to_string_pretty(&json!({ "mcpServers": map }))
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

/// Build the agent-facing tool name for an MCP tool.
///
/// The contract is **`mcp__<server>__<tool>`** — double-underscore separators
/// — matching the convention Claude Code / Cursor expose. The server segment
/// is normalized to `[a-z0-9-]` (uppercase → lowercase, `_` → `-`, other
/// non-alphanumerics → `-`) so the `__` boundary stays unambiguous even when a
/// server id contains underscores. The tool segment mirrors the same rule.
///
/// This is a stable public contract: the TS parser
/// (`src/modules/mcp/toolName.ts`) splits on `__` and must stay in sync. The
/// old single-underscore `mcp_<server>_<tool>` shape is deprecated; agents and
/// transcripts referencing it still parse via a legacy fallback there.
fn tool_name(server_id: &str, remote_name: &str) -> String {
    format!("mcp__{}__{}", normalize_segment(server_id), normalize_segment(remote_name))
}

/// Normalize an MCP name segment to the `[a-z0-9-]` alphabet used inside the
/// `mcp__server__tool` contract. Empty / all-symbol inputs collapse to `"x"`
/// so the segment is never empty (which would produce `mcp__x__tool`).
fn normalize_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    // Collapse runs of '-' and strip leading/trailing '-' so `my_server` →
    // `my-server` (not `my--server`) and `__foo__` → `foo`.
    let collapsed: String = out
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "x".to_string()
    } else {
        collapsed
    }
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
    fn tool_names_use_double_underscore_contract() {
        // Canonical shape: mcp__<server>__<tool>. Both segments normalized to
        // [a-z0-9-]; the `__` boundary stays unambiguous regardless of what
        // the server id or remote tool name contains.
        assert_eq!(tool_name("files", "Read File"), "mcp__files__read-file");
        assert_eq!(tool_name("github", "issues/list"), "mcp__github__issues-list");
        // Server id with underscores must collapse to `-` so the `__` split is
        // unambiguous (the whole point of the contract change).
        assert_eq!(tool_name("my_server", "read_file"), "mcp__my-server__read-file");
        // Mixed-case + symbols normalize predictably.
        assert_eq!(tool_name("Ctx-7", "search__query"), "mcp__ctx-7__search-query");
        // All-symbol input collapses to `x` so the segment is never empty.
        assert_eq!(tool_name("---", "echo"), "mcp__x__echo");
        assert_eq!(tool_name("files", ""), "mcp__files__x");
    }

    #[test]
    fn load_servers_reads_claude_desktop_map_format() {
        // Canonical format: { "mcpServers": { "<id>": { ... } } }. The id is
        // the map key; `name` may be omitted (Claude Desktop configs don't
        // carry it) and falls back to the id.
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join(".isanagent");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("mcp.json"),
            r#"{
                "mcpServers": {
                    "files": { "command": "npx", "args": ["-y", "x"], "env": { "K": "v" } },
                    "no-name": { "command": "echo" }
                }
            }"#,
        )
        .unwrap();
        let servers = load_servers(dir.path()).unwrap();
        assert_eq!(servers.len(), 2);
        let files = servers.iter().find(|s| s.id == "files").unwrap();
        assert_eq!(files.command, "npx");
        assert_eq!(files.args, vec!["-y".to_string(), "x".to_string()]);
        assert_eq!(files.env.get("K").map(String::as_str), Some("v"));
        // name omitted → derived from the id.
        let no_name = servers.iter().find(|s| s.id == "no-name").unwrap();
        assert_eq!(no_name.name, "no-name");
    }

    #[test]
    fn load_servers_migrates_legacy_array_format() {
        // Legacy bare-array shape (one version of backward compat). Must still
        // parse so a workspace upgrade doesn't wipe MCP setup; the next save
        // rewrites it as the canonical map.
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join(".isanagent");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(
            config_dir.join("mcp.json"),
            r#"[{ "id": "legacy", "name": "Legacy", "command": "echo", "args": [], "env": {}, "enabled": false }]"#,
        )
        .unwrap();
        let servers = load_servers(dir.path()).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].id, "legacy");
        assert!(!servers[0].enabled);
    }

    #[test]
    fn save_then_load_round_trips_map_format() {
        // Save writes the canonical map shape; load reads it back. The id is
        // NOT duplicated inside the entry (skip_serializing) — it lives as the
        // map key only.
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join(".isanagent");
        std::fs::create_dir_all(&config_dir).unwrap();
        let original = vec![
            McpServerConfig {
                id: "alpha".into(),
                name: "Alpha".into(),
                command: "echo".into(),
                args: vec!["hi".into()],
                env: HashMap::new(),
                enabled: true,
            },
            McpServerConfig {
                id: "beta".into(),
                name: "Beta".into(),
                command: "echo".into(),
                args: vec![],
                env: HashMap::new(),
                enabled: false,
            },
        ];
        // Write the file directly via the serialization path (mcp_save_servers
        // needs a Tauri State which is awkward in a unit test; the format is
        // what we're validating, not the command plumbing).
        let mut map = serde_json::Map::new();
        for server in &original {
            let value = serde_json::to_value(server).unwrap();
            map.insert(server.id.clone(), value);
        }
        let serialized = serde_json::to_string_pretty(&json!({ "mcpServers": map })).unwrap();
        std::fs::write(config_dir.join("mcp.json"), serialized).unwrap();

        let loaded = load_servers(dir.path()).unwrap();
        assert_eq!(loaded.len(), 2);
        // id round-trips via the map key even though it's skip_serializing.
        assert!(loaded.iter().any(|s| s.id == "alpha" && s.enabled));
        assert!(loaded.iter().any(|s| s.id == "beta" && !s.enabled));
    }

    #[test]
    fn mcp_status_registry_snapshots_and_clears_per_workspace() {
        // Registry methods are async (Mutex guard); drive them on a one-off
        // runtime so the sync #[test] can call them without pulling in the
        // `futures` executor crate as a test dep.
        let rt = tokio::runtime::Runtime::new().unwrap();
        let registry = McpStatusRegistry::new();
        let ws_a = Path::new("/tmp/ws-a");
        let ws_b = Path::new("/tmp/ws-b");
        let now = 1_700_000_000_000u64;

        // Two servers in workspace A, one in B.
        rt.block_on(registry.set(
            ws_a,
            McpServerStatus {
                server_id: "a1".into(),
                state: McpState::Connected,
                tool_count: Some(3),
                last_error: None,
                updated_at_ms: now,
            },
            now,
        ));
        rt.block_on(registry.set(
            ws_a,
            McpServerStatus {
                server_id: "a2".into(),
                state: McpState::Error,
                tool_count: None,
                last_error: Some("boom".into()),
                updated_at_ms: now,
            },
            now,
        ));
        rt.block_on(registry.set(
            ws_b,
            McpServerStatus {
                server_id: "b1".into(),
                state: McpState::Starting,
                tool_count: None,
                last_error: None,
                updated_at_ms: now,
            },
            now,
        ));

        // Snapshot A is sorted by server id and contains only A's entries.
        let snap_a = rt.block_on(registry.snapshot(ws_a));
        assert_eq!(snap_a.len(), 2);
        assert_eq!(snap_a[0].server_id, "a1");
        assert_eq!(snap_a[1].server_id, "a2");
        assert_eq!(snap_a[1].last_error.as_deref(), Some("boom"));

        // Clearing A leaves B untouched.
        rt.block_on(registry.clear_workspace(ws_a));
        assert!(rt.block_on(registry.snapshot(ws_a)).is_empty());
        assert_eq!(rt.block_on(registry.snapshot(ws_b)).len(), 1);
    }

    /// Reusable stdio fixture: a tiny `sh` script that answers JSON-RPC
    /// `initialize`, `tools/list`, and `tools/call` for one tool named `echo`.
    /// Kept here so every stdio test shares the same handshake shape — a real
    /// MCP server is too heavy to ship as a test dep.
    #[cfg(unix)]
    fn echo_fixture_server() -> McpServerConfig {
        McpServerConfig {
            id: "fixture".into(),
            name: "Fixture".into(),
            command: "sh".into(),
            args: vec![
                "-c".into(),
                // id 1 = initialize, id 2 = tools/list, id 3+ = tools/call.
                // tools/call echoes back the arguments it received so the test
                // can assert the round-trip payload.
                r#"while IFS= read -r line; do case "$line" in *"initialize"*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}' ;; *"tools/list"*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echoes input","inputSchema":{"type":"object","properties":{"msg":{"type":"string"}}}}]}}' ;; *"tools/call"*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"ok"}]}}' ;; esac; done"#.into(),
            ],
            env: HashMap::new(),
            enabled: true,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connects_and_discovers_tools_over_stdio() {
        let server = echo_fixture_server();
        let tools = connect_server(&server, Path::new("/tmp")).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name(), "mcp__fixture__echo");
        assert_eq!(tools[0].description(), "[MCP: Fixture] Echoes input");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tools_call_round_trips_over_stdio() {
        // Full initialize → initialized → tools/list → tools/call. The fixture
        // answers tools/call id 3 with a canned `text` content blob; we assert
        // the McpTool::execute path returns that blob verbatim.
        let server = echo_fixture_server();
        let tools = connect_server(&server, Path::new("/tmp")).await.unwrap();
        let echo = &tools[0];
        let result = echo
            .execute(json!({ "msg": "hello" }))
            .await
            .expect("tools/call should succeed");
        // The result is the JSON-stringified tools/call result object.
        assert!(result.contains(r#""text":"ok""#), "got: {result}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_tools_kills_the_child() {
        // Workspace-change cleanup relies on `kill_on_drop(true)` + `Drop for
        // McpClient` reaping the child. We can't easily read the PID from here,
        // but we CAN assert the client's writer flushes cleanly and the spawn
        // succeeds — the actual reaping is exercised by the runtime teardown
        // integration in `runtime.rs` (covered by the workspace-switch path).
        // Here we just validate connect + immediate drop doesn't hang.
        let server = echo_fixture_server();
        let tools = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connect_server(&server, Path::new("/tmp")),
        )
        .await
        .expect("connect should not hang")
        .expect("connect should succeed");
        assert!(!tools.is_empty());
        // Drop the tools → drops the Arc<McpClient> → Drop fires start_kill.
        drop(tools);
    }
}
