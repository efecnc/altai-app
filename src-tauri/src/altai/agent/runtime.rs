use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::async_runtime;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use isanagent::agent::{AgentLogic, AgentLogicParams};
use isanagent::bus::BusMessage;
use isanagent::channels::Channel;
use isanagent::clarification::ClarificationHub;
use isanagent::config::ShellPolicyMode;
use isanagent::provider;
use isanagent::session::SessionManager;
use isanagent::skills::SkillRegistry;
use isanagent::tools::builtin::{
    EditFileTool, GlobFilesTool, ListDirTool, ReadFileTool, SearchTextTool, ShellExecTool,
    WebFetchTool, WebSearchTool, WriteFileTool,
};
use isanagent::tools::ml_domain::{ArxivFetchTool, ArxivSearchTool, HfHubFileFetchTool};
use isanagent::tools::workflow::TodoWriteTool;
use isanagent::tools::ToolRegistry;
use isanagent::workspace::{resolve_workspace_root, IsanagentWorkspace};
use isanagent::NodeHandle;

use super::tauri_channel::{map_telemetry_to_event, telemetry_chat_id, TauriChannel};

/// Serializable agent event surface sent to the frontend.
/// Stabilize this enum — every change is a breaking downstream contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    AgentMessage {
        content: String,
        role: String,
    },
    ToolCallStart {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolCallEnd {
        id: String,
        output: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    EditDiff {
        file: String,
        before: String,
        after: String,
        hunk_id: String,
    },
    ApprovalRequest {
        id: String,
        action: String,
        payload: serde_json::Value,
    },
    Thinking {
        content: String,
    },
    /// An `ask_user` clarification surfaced by IsanAgent's ClarificationHub.
    /// `content` is the question; `choices` are optional preset answers the UI
    /// can render as buttons. Replying with a normal message resolves it (the
    /// runtime routes the next inbound message to the pending wait).
    Clarification {
        content: String,
        choices: Vec<String>,
    },
    /// Per-LLM-call token accounting forwarded from IsanAgent's `AgentUsage`
    /// telemetry. The frontend accumulates these into the run's token meter.
    Usage {
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
        cache_read_tokens: u32,
        cache_creation_tokens: u32,
    },
    Done {
        reason: String,
    },
    Error {
        message: String,
    },
    /// A synchronous `execution_run` completed.
    ExecutionRunFinished {
        provider_id: String,
        session_id: String,
        exit_code: Option<i32>,
        duration_ms: u64,
        stdout_len: usize,
        stderr_len: usize,
        artifact_count: usize,
        git_head: Option<String>,
        description: Option<String>,
    },
    /// A background `execution_run_background` job reached a terminal state.
    ExecutionJobFinished {
        job_id: String,
        session_id: String,
        provider_id: String,
        /// `completed`, `failed`, `cancelled`, or `timeout`.
        status: String,
        exit_code: Option<i32>,
        duration_ms: u64,
        stdout_len: usize,
        stderr_len: usize,
        artifact_count: usize,
        description: Option<String>,
    },
    /// A background job changed state (spawned → running → terminal).
    BackgroundJobUpdated {
        job_id: String,
        state: String,
        kind: String,
        detail: Option<String>,
    },
    /// A subagent task was spawned by the main agent (via `subagent_spawn`).
    SubagentSpawned {
        task_id: String,
        child_chat_id: String,
        display_name: Option<String>,
        agent_name: Option<String>,
        background_job_id: Option<String>,
    },
    /// A subagent task reached a terminal state.
    SubagentFinished {
        task_id: String,
        child_chat_id: String,
        /// `completed`, `failed`, or `cancelled`.
        status: String,
        agent_name: Option<String>,
    },
    NotebookOutput {
        notebook_id: String,
        cell_index: usize,
        output: serde_json::Value,
    },
    ExperimentResult {
        experiment_id: String,
        metrics: serde_json::Value,
        artifacts: Vec<String>,
    },
}

/// Wire envelope for `agent://event`: every event carries the `chat_id` of the
/// ALTAI chat tab it belongs to, so the frontend can drop events that aren't
/// for the chat currently on screen (per-session isolation).
#[derive(Serialize)]
struct AgentEventEnvelope<'a> {
    chat_id: &'a str,
    #[serde(flatten)]
    event: &'a Event,
}

fn emit_event(app: &AppHandle, chat_id: &str, event: &Event) {
    let _ = app.emit("agent://event", &AgentEventEnvelope { chat_id, event });
}

/// Identifies a particular `(provider, model, key, base_url, persona)`
/// configuration of the running runtime. When `start_agent` is called
/// with a different fingerprint we tear down the existing bus and
/// agent node and re-init — without this guard the runtime locked in
/// the first model the user picked and silently ignored every later
/// switch, surfacing as cross-provider 4xx errors that pointed at the
/// previous endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RuntimeFingerprint {
    provider_name: String,
    model_name: String,
    api_key: String,
    base_url: String,
    persona: String,
    /// Resolved IsanAgent workspace root (`<selected-folder>/.isanagent`, or
    /// the `~/.isanagent` default). Switching workspaces reinitializes the
    /// runtime AND its memory so chats don't bleed across projects.
    workspace_root: String,
    /// Active permission mode ("ask" | "auto-edit" | "bypass"). The shell policy is baked into
    /// `AgentLogic` at construction, so a different mode must select a different instance — hence
    /// it is part of the fingerprint. Without this, flipping the UI permission toggle would route
    /// to the already-built instance and silently keep the old shell gate.
    permission_mode: String,
}

/// Map the ALTAI UI permission mode to an IsanAgent shell-policy mode for interactive sessions.
///
/// The runtime gate is exec/code-only — it does NOT gate file edits — so this maps only the
/// shell/code-execution dimension:
/// - `ask` and `auto-edit` → `Ask`: code-exec / destructive-shell still require approval. This
///   honors the UI contract that "Edit automatically" auto-approves file *edits* (which the
///   runtime never gates) while **shell commands still require approval**. Only `bypass` (which
///   the UI gates behind an explicit Settings toggle + warning) auto-approves shell.
/// - `bypass` → `Allow`: no prompts.
/// - unknown / None → leaves the on-disk config default untouched (which defaults to `Ask`).
///
/// Fail-safe: any unrecognized value returns `None`, so it can never silently downgrade to
/// `Allow`.
fn permission_mode_to_shell_mode(mode: Option<&str>) -> Option<ShellPolicyMode> {
    match mode.map(str::trim) {
        Some("ask") | Some("ask_before_edit") | Some("ask-before-edit") | Some("auto-edit")
        | Some("auto_edit") | Some("auto") | Some("edit_automatically") => {
            Some(ShellPolicyMode::Ask)
        }
        Some("bypass") | Some("bypass_permissions") => Some(ShellPolicyMode::Allow),
        _ => None,
    }
}

/// One running IsanAgent instance — its own channel + agent node + bus routers.
struct Instance {
    channel: Arc<TauriChannel>,
    /// Fires the bus router's shutdown so its task exits and drops `agent_node`.
    /// Needed because `agent_node` holds `bus_tx` clones (execution-job manager,
    /// subagent harness), so `channel.stop()` alone can't make `bus_rx.recv()`
    /// return `None` — the task would otherwise leak on teardown.
    shutdown: tokio::sync::oneshot::Sender<()>,
}

/// Runtime state managed by Tauri. Instead of a single runtime, holds a
/// registry of instances keyed by config (fingerprint) so different models /
/// personas can run **concurrently** — dispatching a run on a new config spins
/// up its own instance rather than tearing down the others.
pub struct AgentRuntime {
    pub app: AppHandle,
    /// One instance per distinct config. All emit to `agent://event` tagged by
    /// chat_id, which the frontend routes on.
    instances: tokio::sync::Mutex<HashMap<RuntimeFingerprint, Instance>>,
    /// One shared SQLite memory actor per workspace root — reused across the
    /// workspace's model-instances so history transfers and a single actor
    /// serializes DB access (no contention).
    memory_by_workspace:
        tokio::sync::Mutex<HashMap<String, NodeHandle<isanagent::memory::MemoryMessage>>>,
}

pub fn init(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(AgentRuntime {
        app: app.clone(),
        instances: tokio::sync::Mutex::new(HashMap::new()),
        memory_by_workspace: tokio::sync::Mutex::new(HashMap::new()),
    });

    Ok(())
}

/// Build the config fingerprint + its resolved workspace root.
fn make_fingerprint(
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
    permission_mode: Option<&str>,
) -> RuntimeFingerprint {
    let workspace_root = workspace_path
        .map(|p| format!("{}/.isanagent", p.trim_end_matches('/')))
        .unwrap_or_default();
    RuntimeFingerprint {
        provider_name: provider_name.to_string(),
        model_name: model_name.to_string(),
        api_key: api_key.to_string(),
        base_url: base_url_override.unwrap_or("").to_string(),
        persona: persona_instructions.unwrap_or("").to_string(),
        workspace_root,
        permission_mode: permission_mode.unwrap_or("").to_string(),
    }
}

/// Get-or-create the shared memory actor for a workspace root (`""` = default).
async fn ensure_memory(
    runtime: &AgentRuntime,
    workspace_root: &str,
) -> Result<NodeHandle<isanagent::memory::MemoryMessage>, String> {
    let mut guard = runtime.memory_by_workspace.lock().await;
    if let Some(existing) = guard.get(workspace_root) {
        return Ok(existing.clone());
    }
    let ws_opt = if workspace_root.is_empty() {
        None
    } else {
        Some(workspace_root)
    };
    let dir = resolve_workspace_root(ws_opt);
    let db_path = dir.join(".system_generated").join("agent_memory.db");
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let db_path_str = db_path
        .to_str()
        .ok_or("workspace DB path is not valid UTF-8")?;
    let memory_actor = isanagent::memory::SqliteMemoryActor::new(db_path_str)
        .map_err(|e| format!("Failed to initialize SqliteMemoryActor: {}", e))?;
    let node = NodeHandle::<isanagent::memory::MemoryMessage>::new(
        memory_actor,
        100,
        1,
        Duration::from_millis(5),
    );
    guard.insert(workspace_root.to_string(), node.clone());
    Ok(node)
}

/// Ensure an instance exists for this config and return its channel. The app
/// runs one workspace at a time, so instances (and memory) of *other*
/// workspaces are torn down here to bound growth.
#[allow(clippy::too_many_arguments)]
async fn ensure_instance(
    runtime: &AgentRuntime,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Arc<TauriChannel>, String> {
    let fp = make_fingerprint(
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
        permission_mode,
    );
    let workspace_root = fp.workspace_root.clone();

    // Fine-grained locking: the `instances` lock is only ever held for cheap
    // map ops, never across the heavy `build_instance().await` or any channel
    // teardown — so a build/cancel on one config can't block sends/cancels on
    // another (the whole point of concurrent instances). Note: within a single
    // workspace, distinct configs accrete instances for the session (only
    // other-workspace instances are torn down) — acceptable given typical
    // config churn; revisit with idle-eviction if that proves heavy.

    // Fast path: instance already built for this exact config.
    {
        let instances = runtime.instances.lock().await;
        if let Some(inst) = instances.get(&fp) {
            return Ok(inst.channel.clone());
        }
    }

    // Tear down instances of other workspaces (the UI uses one at a time).
    // Remove them under the lock, but defer the async teardown until the lock
    // is released. Firing `shutdown` stops the bus-router task (so `agent_node`
    // drops and the `bus_tx` cycle unwinds); `stop()` then closes the channel.
    let stale: Vec<Instance> = {
        let mut instances = runtime.instances.lock().await;
        let keys: Vec<RuntimeFingerprint> = instances
            .keys()
            .filter(|k| k.workspace_root != workspace_root)
            .cloned()
            .collect();
        keys.into_iter().filter_map(|k| instances.remove(&k)).collect()
    };
    runtime
        .memory_by_workspace
        .lock()
        .await
        .retain(|k, _| k == &workspace_root);
    for inst in stale {
        let _ = inst.shutdown.send(());
        let _ = inst.channel.cancel(String::new()).await;
        let _ = inst.channel.stop().await;
    }

    // Build the (heavy) instance WITHOUT holding the instances lock.
    let memory_node = ensure_memory(runtime, &workspace_root).await?;
    let workspace_root_opt = if workspace_root.is_empty() {
        None
    } else {
        Some(workspace_root.as_str())
    };
    let (channel, shutdown) = build_instance(
        runtime.app.clone(),
        memory_node,
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_root_opt,
        permission_mode,
    )
    .await?;

    // Re-acquire to insert. If a concurrent call built the same config while we
    // were building, keep theirs and tear down our now-duplicate instance.
    let mut instances = runtime.instances.lock().await;
    if let Some(inst) = instances.get(&fp) {
        let winner = inst.channel.clone();
        drop(instances);
        let _ = shutdown.send(());
        let _ = channel.stop().await;
        return Ok(winner);
    }
    instances.insert(
        fp,
        Instance {
            channel: channel.clone(),
            shutdown,
        },
    );
    Ok(channel)
}

/// Route a user message to the instance for `config` (built or reused).
#[allow(clippy::too_many_arguments)]
pub async fn route_send(
    runtime: &AgentRuntime,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
    permission_mode: Option<&str>,
    message: String,
    images: Vec<String>,
    chat_id: String,
) -> Result<(), String> {
    let channel = ensure_instance(
        runtime,
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
        permission_mode,
    )
    .await?;
    channel.inject_user_message(message, images, chat_id).await
}

/// Cancel a chat's run. Fan out to every live instance rather than tracking a
/// chat→instance owner: cancellation is `chat_id`-scoped and idempotent inside
/// IsanAgent, so a stray cancel to an instance that doesn't own the chat is a
/// harmless no-op. Targeted ownership would be stale after a mid-session
/// model/persona switch (the chat's old instance still draining), silently
/// dropping the cancel — fanning out can't.
pub async fn route_cancel(runtime: &AgentRuntime, chat_id: String) -> Result<(), String> {
    // Clone the channels under a short-lived lock, then cancel outside it so the
    // cancel awaits don't block concurrent sends/cancels on the registry.
    let channels: Vec<Arc<TauriChannel>> = {
        let instances = runtime.instances.lock().await;
        instances.values().map(|inst| inst.channel.clone()).collect()
    };
    for channel in channels {
        let _ = channel.cancel(chat_id.clone()).await;
    }
    Ok(())
}

/// Warm up (or ensure) the instance for a config. Kept for the `agent_start`
/// command; dispatch now happens through `route_send`.
#[allow(clippy::too_many_arguments)]
pub async fn start_agent(
    runtime: &AgentRuntime,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<(), String> {
    ensure_instance(
        runtime,
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
        permission_mode,
    )
    .await
    .map(|_| ())
}

/// Build ONE IsanAgent instance: a fresh `TauriChannel` + agent node + bus
/// routers, sharing the passed-in (per-workspace) memory actor. Returns the
/// instance's channel. No teardown/fingerprint logic — the registry
/// (`ensure_instance`) owns instance lifecycle now.
///
/// `persona_instructions`, when `Some`, is appended to the system prompt under
/// a `## Persona` block. `base_url_override`, when `Some`, is the *full*
/// chat-completions endpoint POSTed as-is.
///
/// `permission_mode` ("ask" | "auto-edit" | "bypass"), when it maps to a shell
/// mode, overrides the interactive shell-policy gate so the UI permission
/// toggle actually governs code-exec / destructive-shell for this instance.
#[allow(clippy::too_many_arguments)]
async fn build_instance(
    app: AppHandle,
    memory_node: NodeHandle<isanagent::memory::MemoryMessage>,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_root: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<(Arc<TauriChannel>, tokio::sync::oneshot::Sender<()>), String> {
    // Each instance gets its own channel with a unique bootstrap chat_id;
    // actual routing is by per-message chat_id.
    let channel = Arc::new(TauriChannel::new(
        app.clone(),
        uuid::Uuid::new_v4().to_string(),
    ));

    // Resolve workspace — `<selected-folder>/.isanagent`, or `~/.isanagent`.
    let workspace_dir = resolve_workspace_root(workspace_root);
    if !workspace_dir.exists() {
        // Auto-create minimal workspace
        let _ = std::fs::create_dir_all(workspace_dir.join(".system_generated"));
    }

    let workspace =
        IsanagentWorkspace::new(workspace_root, None).map_err(|e| {
            format!("Failed to load IsanAgent workspace: {}", e)
        })?;

    // Memory (SQLite) is the shared per-workspace actor passed in by
    // `ensure_instance` — one actor per project, reused across this
    // workspace's model-instances so history transfers and DB access is
    // serialized through a single actor (no contention).
    let session_manager = SessionManager::new(memory_node.clone());
    let skills = SkillRegistry::new(workspace.skills_path());
    let clarification_hub = ClarificationHub::shared();

    // Outbound channel for agent → UI (typed as BusMessage per IsanAgent API)
    let (global_outbound_tx, mut global_outbound_rx) = mpsc::channel::<BusMessage>(100);
    // Inbound bus
    let (bus_tx, mut bus_rx) = mpsc::channel::<BusMessage>(100);

    // Tools
    let mut tools = ToolRegistry::new();
    let restrict = workspace.config.restrict_to_workspace.unwrap_or(true);
    let sandbox_dir = workspace.sandbox_dir.clone();

    tools.register(Box::new(ReadFileTool {
        workspace_dir: sandbox_dir.clone(),
        restrict_to_workspace: restrict,
    }));
    tools.register(Box::new(WriteFileTool {
        workspace_dir: sandbox_dir.clone(),
        restrict_to_workspace: restrict,
    }));
    tools.register(Box::new(EditFileTool {
        workspace_dir: sandbox_dir.clone(),
        restrict_to_workspace: restrict,
    }));
    tools.register(Box::new(ListDirTool {
        workspace_dir: sandbox_dir.clone(),
        restrict_to_workspace: restrict,
    }));
    tools.register(Box::new(GlobFilesTool {
        workspace_dir: sandbox_dir.clone(),
        restrict_to_workspace: restrict,
    }));
    tools.register(Box::new(SearchTextTool {
        workspace_dir: sandbox_dir.clone(),
        restrict_to_workspace: restrict,
        ripgrep_timeout_secs: workspace
            .config
            .effective_search_text_ripgrep_timeout_secs(),
    }));
    tools.register(Box::new(ShellExecTool {
        workspace_dir: sandbox_dir.clone(),
        restrict_to_workspace: restrict,
    }));

    // Pre-edit checkpoints for one-step undo of agent edits (isanagent
    // #53/#56). WriteFileTool/EditFileTool snapshot a file's prior content
    // before mutating it; the `checkpoint` tool (and the `checkpoint_*` Tauri
    // commands) roll them back. isanagent's store is process-global and
    // set-once, while this runtime is rebuilt per workspace — so we root it at
    // an APP-level directory (not the workspace) and restore by absolute path
    // (`base = None`), which stays correct across workspace switches. Restores
    // are safe here because every checkpoint is created by our own sandboxed
    // edit tools. Trade-off: `base = None` forgoes isanagent's symlink/TOCTOU
    // restore guard (which only applies when a sandbox `base` is set) — an
    // acceptable choice since restores act only on agent-authored snapshots of
    // already sandbox-confined paths, and a single set-once `base` could not
    // stay correct once the workspace changes. Enabled by default; opt out with
    // `checkpoint_enabled = false` in `<workspace>/.isanagent/config.toml`.
    if workspace.config.checkpoint_enabled.unwrap_or(true) {
        // `init` sets a process-global set-once `OnceLock`. build_instance runs
        // again on every workspace/model switch, so only initialize when the
        // store isn't already up — a second `init` would allocate a throwaway
        // store the OnceLock silently drops. The app-level root means the first
        // init stays correct for the whole session regardless of workspace.
        if isanagent::checkpoint::store().is_none() {
            match app.path().app_data_dir() {
                Ok(data_dir) => isanagent::checkpoint::init(data_dir.join("checkpoints"), None),
                Err(e) => log::warn!(
                    "checkpoint: app data dir unavailable ({e}); edit undo disabled"
                ),
            }
        }
        // Register the tool on every runtime build (each gets a fresh
        // ToolRegistry), but only while the store is actually active.
        if isanagent::checkpoint::store().is_some() {
            tools.register(Box::new(isanagent::checkpoint::CheckpointTool));
        }
    }

    // ML domain tools
    let max_web_chars = workspace.config.effective_max_web_tool_output_chars();
    let jina = workspace.config.jina_web_backend();
    tools.register(Box::new(WebSearchTool {
        jina: jina.clone(),
        max_output_chars: max_web_chars,
    }));
    tools.register(Box::new(WebFetchTool {
        jina,
        max_output_chars: max_web_chars,
        workspace_dir: workspace.dir.clone(),
    }));
    tools.register(Box::new(ArxivSearchTool {
        max_output_chars: max_web_chars,
    }));
    tools.register(Box::new(ArxivFetchTool {
        workspace_dir: workspace.dir.clone(),
    }));
    tools.register(Box::new(HfHubFileFetchTool {
        max_output_chars: max_web_chars,
    }));
    tools.register(Box::new(TodoWriteTool {
        memory_node: memory_node.clone(),
    }));

    // Compaction overhaul (upstream isanagent — altaidevorg/isanagent#39). The agent can
    // now schedule a between-turns context compaction via `compact_context`
    // and re-fetch a tool result that fell out of the live context via
    // `recall_tool_result`. Both surface in the chat as their own tool
    // entries (TOOL_META in tool.tsx) so the user can see when compaction
    // ran and what got recalled.
    tools.register(Box::new(isanagent::tools::compact::CompactContextTool {
        outbound_tx: global_outbound_tx.clone(),
    }));
    tools.register(Box::new(isanagent::tools::recall::RecallToolResultTool {
        memory_node: memory_node.clone(),
        outbound_tx: global_outbound_tx.clone(),
    }));

    // Execution harness (if enabled)
    if workspace.config.execution_harness_enabled() {
        let harness = isanagent::execution::build_execution_harness(
            workspace.dir.clone(),
            sandbox_dir.clone(),
            restrict,
            &workspace.config,
        )
        .map_err(|e| format!("execution harness: {e}"))?;

        let execution_jobs = Arc::new(isanagent::execution::ExecutionJobManager::new(
            harness.clone(),
            global_outbound_tx.clone(),
            Some(bus_tx.clone()),
            workspace.config.execution_wake_on_job_terminal(),
        ));
        let inflight_sync = Arc::new(isanagent::execution::InflightSyncRegistry::new());

        tools.register(Box::new(isanagent::tools::execution::ExecutionSessionCreateTool {
            harness: harness.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionRunTool {
            harness: harness.clone(),
            outbound_tx: global_outbound_tx.clone(),
            jobs: Some(execution_jobs.clone()),
            inflight: Some(inflight_sync.clone()),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionRunBackgroundTool {
            harness: harness.clone(),
            jobs: execution_jobs.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionJobStatusTool {
            jobs: execution_jobs.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionJobResultTool {
            jobs: execution_jobs.clone(),
            max_tool_output_chars: workspace.config.resolved_max_tool_output_chars().unwrap_or(3000),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionJobListTool {
            jobs: execution_jobs.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionJobCancelTool {
            jobs: execution_jobs.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionArtifactListTool {
            harness: harness.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionEnvInfoTool {
            harness: harness.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionSessionCloseTool {
            harness: harness.clone(),
        }));
        tools.register(Box::new(isanagent::tools::execution::ExecutionCancelTool {
            harness: harness.clone(),
        }));

        // Read background-job stdout/stderr line-by-line — lets the agent
        // inspect a long-running job's logs without fetching the full result.
        tools.register(Box::new(isanagent::tools::execution::ExecutionReadLogTool {
            jobs: execution_jobs.clone(),
            harness: harness.clone(),
        }));

        // (The colab_mcp extra-tool-call proxy was removed upstream in
        // isanagent #47 "Colab CLI" — ColabMcpToolCallTool /
        // compile_colab_mcp_tool_allowlist and the related config accessors no
        // longer exist, so there's nothing to register here.)
    }

    // Provider — `base_url_override` (from the JS side, derived from the
    // active model) wins. Otherwise fall back to workspace config, then
    // to Gemini's `v1beta` as a last resort.
    //
    // Note: `cfg.resolved_base_url()` has shifted between `Option<String>`
    // and `Result<String, String>` across isanagent revisions. `.unwrap_or`
    // is defined on both, so this branch survives that drift without
    // pinning the crate.
    let resolved_base_url = if let Some(override_url) = base_url_override {
        override_url.to_string()
    } else {
        // Gemini's OpenAI-compatible chat-completions endpoint. The runtime
        // POSTs to `base_url` as-is (no path appended), so this must be the
        // *full* endpoint — `…/v1beta` alone would 404.
        let default = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
            .to_string();
        if let Some(ref cfg) = workspace.config.provider {
            cfg.resolved_base_url().unwrap_or(default)
        } else {
            default
        }
    };
    let llm_provider = provider::create_provider(provider_name, &resolved_base_url, api_key, model_name);

    // System prompt
    let mut system_prompt = workspace.compile_system_prompt();
    if workspace.config.ml_engineer_harness_enabled() {
        system_prompt.push_str("\n\n");
        system_prompt.push_str(isanagent::ml_engineer::HARNESS_OVERLAY);
    }
    if let Some(persona) = persona_instructions {
        system_prompt.push_str("\n\n## Persona\n\n");
        system_prompt.push_str(persona);
    }

    // Subagent prompt/summary fields are derived from the system prompt as it
    // stands *before* the named-agent catalog is appended below — subagents do
    // not spawn nested subagents, so they don't need the catalog. This mirrors
    // the ordering in isanagent's reference binary (src/main.rs).
    let subagent_system_prompt = if workspace.config.ml_engineer_subagent_research_overlay() {
        format!(
            "{}\n{}",
            system_prompt,
            isanagent::ml_engineer::SUBAGENT_RESEARCH_APPEND
        )
    } else {
        system_prompt.clone()
    };
    let harness_runtime_summary = workspace.config.runtime_harness_summary_lines().join("\n");
    let forbid_final_without_tools = workspace.config.ml_engineer_forbid_final_without_tools();

    // Named-agent registry (researcher / coder / evaluator, plus any defined in
    // `.isanagent/config.toml` under `[harness.agents.*]`). Fall back to the
    // crate's built-in defaults when none are configured. The catalog is
    // injected into the main agent's system prompt so the LLM knows which
    // specialized agents it can dispatch via `subagent_spawn`.
    let agent_defs = {
        let defs = workspace.config.agent_definitions();
        if defs.is_empty() {
            isanagent::agent::registry::default_agent_definitions()
        } else {
            defs
        }
    };
    let agent_registry = Arc::new(isanagent::agent::AgentRegistry::from_definitions(
        &agent_defs,
        &sandbox_dir,
    ));
    let agent_prompt_section = agent_registry.compile_agent_prompt_section();
    if !agent_prompt_section.is_empty() {
        system_prompt.push_str(&agent_prompt_section);
    }

    // Build the subagent harness params only when enabled in config
    // (`[harness.subagents] enabled = true`). When disabled, no subagent tools
    // are registered and no spawn can happen — but note this is *not* a total
    // no-op vs. the pre-subagent runtime: `harness_runtime_summary` (a per-step
    // harness snapshot) and the named-agent catalog are now always built into
    // the prompt regardless of this flag, matching isanagent's reference binary.
    // Subagent lifecycle telemetry (SubagentSpawned / SubagentFinished) is
    // emitted on `outbound_tx` and surfaced to the UI by the outbound router
    // below; wake-on-completion follow-ups ride `bus_tx`.
    let subagent = if workspace.config.subagent_harness_enabled() {
        Some(isanagent::agent::SubagentHarnessParams {
            cancel_children_on_parent_cancel: workspace
                .config
                .subagent_cancel_children_on_parent_cancel(),
            allowed_tools: workspace
                .config
                .subagent_allowed_tools_set()
                .map(Arc::new),
            max_tasks: workspace.config.subagent_max_tasks(),
            max_wait_secs: workspace.config.subagent_max_wait_secs(),
            agent_registry: Some(agent_registry),
            wake_on_completion: workspace.config.subagent_wake_on_completion(),
            task_history_retention: workspace.config.subagent_task_history_retention(),
            bus_tx: Some(bus_tx.clone()),
        })
    } else {
        None
    };

    let max_iterations = workspace.config.resolved_max_iterations().unwrap_or(50);
    let max_tool_output_chars = workspace.config.resolved_max_tool_output_chars().unwrap_or(3000);
    // Start from the on-disk shell policy, then let the active UI permission mode override the
    // interactive gate so the toolbar toggle actually governs code-exec/destructive-shell. The
    // mode is baked into `AgentLogic` here, which is why it is part of the instance fingerprint.
    let mut shell_policy = workspace.config.resolved_shell_policy();
    if let Some(mode) = permission_mode_to_shell_mode(permission_mode) {
        shell_policy.interactive_mode = mode;
    }
    let default_harness = isanagent::config::HarnessConfig::default();
    let harness_ref = workspace
        .config
        .harness
        .as_ref()
        .unwrap_or(&default_harness);
    let hook_tool_ctx = isanagent::hooks::ToolCallHookContext::from_harness_config(
        &workspace.dir,
        &sandbox_dir,
        harness_ref,
    );

    let agent_logic = AgentLogic::new(AgentLogicParams {
        name: "altai-agent".to_string(),
        provider: llm_provider,
        session_manager,
        tools,
        skills,
        system_prompt,
        max_iterations,
        max_tool_output_chars,
        max_recent_summaries: 5,
        short_term_threshold_turns: 20,
        short_term_threshold_tokens: 100000,
        outbound_tx: global_outbound_tx.clone(),
        logger_tx: isanagent::logging::create_logger_channel(256).0,
        clarification_hub,
        subagent,
        doom_loop_enabled: workspace.config.doom_loop_enabled(),
        harness_runtime_summary,
        subagent_system_prompt,
        forbid_final_without_tools,
        shell_policy,
        hook_tool_ctx,
    });

    let agent_node = NodeHandle::<BusMessage>::new(agent_logic, 100, 3, Duration::from_millis(50));

    // Start the TauriChannel
    channel.start(bus_tx.clone()).await.map_err(|e| format!("TauriChannel start failed: {}", e))?;

    // Bus router: forward inbound → agent, outbound → channel. (Telemetry is
    // emitted by the outbound router below, not here — see note in the loop.)
    let channel_for_outbound = channel.clone();
    // Shutdown trigger: `agent_node` (moved into this task) holds `bus_tx`
    // clones, so `channel.stop()` can't drop the last sender. On teardown we
    // fire `shutdown_tx`; the task breaks, drops `agent_node`, and the cycle
    // unwinds (its `global_outbound_tx` clones drop, ending the outbound task).
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    async_runtime::spawn(async move {
        loop {
            let msg = tokio::select! {
                m = bus_rx.recv() => m,
                _ = &mut shutdown_rx => break,
            };
            let Some(msg) = msg else { break };
            match msg {
                BusMessage::Inbound(inbound) => {
                    let _ = agent_node.send_packet(BusMessage::Inbound(inbound)).await;
                }
                BusMessage::Outbound(outbound) => {
                    let _ = channel_for_outbound.send(outbound).await;
                }
                // NOTE: telemetry is intentionally NOT handled here. Agent and
                // tool telemetry flows through `global_outbound_tx` (the
                // outbound router below) and is emitted there exactly once.
                // `bus_tx` only ever carries Inbound (user + synthetic
                // execution-job follow-ups) and Cancel, so handling Telemetry
                // here would be dead code today and a double-emit footgun if
                // anything later routed telemetry to this channel.
                BusMessage::Cancel(chat_id) => {
                    let _ = agent_node
                        .send_packet(BusMessage::Cancel(chat_id))
                        .await;
                }
                _ => {}
            }
        }
    });

    // Outbound router: forward everything the agent emits on its outbound
    // channel — final assistant messages AND telemetry (tool calls, thoughts,
    // progress). Previously this task only handled `Outbound`, so every
    // `BusMessage::Telemetry(...)` the AgentLogic emitted was silently
    // dropped — the UI saw no tool calls or thinking between "Sending to
    // ALTAI…" and the final answer.
    let app_for_outbound = app.clone();
    async_runtime::spawn(async move {
        while let Some(out_msg) = global_outbound_rx.recv().await {
            match out_msg {
                BusMessage::Outbound(outbound) => {
                    // Clarifications (`ask_user`) ride on outbound metadata —
                    // surface them as a distinct event so the UI can render the
                    // preset choices as buttons. A normal reply resolves them.
                    let chat_id = outbound.chat_id.clone();
                    let event = if outbound
                        .metadata
                        .contains_key(isanagent::clarification::METADATA_CLARIFICATION)
                    {
                        let choices = outbound
                            .metadata
                            .get(isanagent::clarification::METADATA_CLARIFICATION_CHOICES)
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|x| x.as_str().map(str::to_string))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        Event::Clarification {
                            content: outbound.content,
                            choices,
                        }
                    } else {
                        Event::AgentMessage {
                            content: outbound.content,
                            role: "assistant".to_string(),
                        }
                    };
                    emit_event(&app_for_outbound, &chat_id, &event);
                }
                BusMessage::Telemetry(ref telemetry) => {
                    if let Some(event) = map_telemetry_to_event(telemetry) {
                        let chat_id = telemetry_chat_id(telemetry).unwrap_or("");
                        emit_event(&app_for_outbound, chat_id, &event);
                    }
                }
                _ => {}
            }
        }
    });

    // Emit ready event under the runtime's bootstrap chat_id. It does not match
    // any ALTAI chat tab, so the frontend filters it out — it exists only as a
    // lifecycle signal, not a message to render in a user's chat.
    emit_event(
        &app,
        channel.chat_id(),
        &Event::AgentMessage {
            content: "IsanAgent runtime initialized.".to_string(),
            role: "system".to_string(),
        },
    );

    Ok((channel, shutdown_tx))
}

#[cfg(test)]
mod permission_mode_tests {
    use super::*;

    #[test]
    fn only_bypass_allows_shell() {
        // ask and auto-edit must still gate shell/code (UI contract: auto-edit auto-approves
        // edits only). bypass is the sole mode that maps to Allow.
        assert_eq!(
            permission_mode_to_shell_mode(Some("ask")),
            Some(ShellPolicyMode::Ask)
        );
        assert_eq!(
            permission_mode_to_shell_mode(Some("auto-edit")),
            Some(ShellPolicyMode::Ask)
        );
        assert_eq!(
            permission_mode_to_shell_mode(Some("bypass")),
            Some(ShellPolicyMode::Allow)
        );
        // Unknown / empty must not downgrade to Allow — leave the on-disk default.
        assert_eq!(permission_mode_to_shell_mode(Some("nonsense")), None);
        assert_eq!(permission_mode_to_shell_mode(None), None);
    }
}
