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
}

/// One running IsanAgent instance — its own channel + agent node + bus routers.
struct Instance {
    channel: Arc<TauriChannel>,
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
    /// Which instance (by config) owns a given chat_id, so `send`/`cancel`
    /// route to the right instance.
    chat_owner: tokio::sync::Mutex<HashMap<String, RuntimeFingerprint>>,
}

pub fn init(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(AgentRuntime {
        app: app.clone(),
        instances: tokio::sync::Mutex::new(HashMap::new()),
        memory_by_workspace: tokio::sync::Mutex::new(HashMap::new()),
        chat_owner: tokio::sync::Mutex::new(HashMap::new()),
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
async fn ensure_instance(
    runtime: &AgentRuntime,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
) -> Result<Arc<TauriChannel>, String> {
    let fp = make_fingerprint(
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
    );
    let workspace_root = fp.workspace_root.clone();

    let mut instances = runtime.instances.lock().await;

    // Tear down instances of other workspaces (the UI uses one at a time).
    let stale: Vec<RuntimeFingerprint> = instances
        .keys()
        .filter(|k| k.workspace_root != workspace_root)
        .cloned()
        .collect();
    for key in stale {
        if let Some(inst) = instances.remove(&key) {
            let _ = inst.channel.cancel(String::new()).await;
            let _ = inst.channel.stop().await;
        }
    }
    runtime
        .memory_by_workspace
        .lock()
        .await
        .retain(|k, _| k == &workspace_root);

    if let Some(inst) = instances.get(&fp) {
        return Ok(inst.channel.clone());
    }

    let memory_node = ensure_memory(runtime, &workspace_root).await?;
    let workspace_root_opt = if workspace_root.is_empty() {
        None
    } else {
        Some(workspace_root.as_str())
    };
    let channel = build_instance(
        runtime.app.clone(),
        memory_node,
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_root_opt,
    )
    .await?;
    instances.insert(
        fp,
        Instance {
            channel: channel.clone(),
        },
    );
    Ok(channel)
}

/// Route a user message to the instance for `config`, recording the chat→config
/// ownership so cancel can find it later.
#[allow(clippy::too_many_arguments)]
pub async fn route_send(
    runtime: &AgentRuntime,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
    fallback: Option<isanagent::agent::FallbackProviderSpec>,
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
    )
    .await?;
    let fp = make_fingerprint(
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
    );
    runtime
        .chat_owner
        .lock()
        .await
        .insert(chat_id.clone(), fp);

    // Cross-provider failover: refresh the process-global fallback list per send
    // so it tracks the current primary. `build_fallback_specs` drops the
    // candidate if it equals the primary (so the primary is never its own
    // fallback). Empty list = failover off. The list is process-global, so with
    // several different-model runs in flight the most recent send's primary is
    // the one excluded — correct for the common (sequential) case; acceptable
    // for concurrent multi-model.
    match fallback {
        Some(fb) => {
            let specs = isanagent::agent::build_fallback_specs(
                provider_name,
                base_url_override.unwrap_or(""),
                model_name,
                vec![fb],
            );
            isanagent::agent::set_fallback_providers(specs);
        }
        None => isanagent::agent::set_fallback_providers(Vec::new()),
    }

    channel.inject_user_message(message, images, chat_id).await
}

/// Cancel a chat's run by routing to the instance that owns it.
pub async fn route_cancel(runtime: &AgentRuntime, chat_id: String) -> Result<(), String> {
    let fp = runtime.chat_owner.lock().await.get(&chat_id).cloned();
    let Some(fp) = fp else {
        return Ok(());
    };
    let instances = runtime.instances.lock().await;
    if let Some(inst) = instances.get(&fp) {
        inst.channel.cancel(chat_id).await
    } else {
        Ok(())
    }
}

/// Warm up (or ensure) the instance for a config. Kept for the `agent_start`
/// command; dispatch now happens through `route_send`.
pub async fn start_agent(
    runtime: &AgentRuntime,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    ensure_instance(
        runtime,
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
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
) -> Result<Arc<TauriChannel>, String> {
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

        // (The colab_mcp `extra_mcp_tool_call` proxy was removed upstream in
        // isanagent; its registration block was dropped on the bump that brought
        // re-settable fallback providers.)
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
    let shell_policy = workspace.config.resolved_shell_policy();
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
    async_runtime::spawn(async move {
        while let Some(msg) = bus_rx.recv().await {
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

    Ok(channel)
}
