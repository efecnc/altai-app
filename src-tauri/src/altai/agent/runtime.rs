use serde::{Deserialize, Serialize};
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

use super::tauri_channel::{map_telemetry_to_event, TauriChannel};

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
    Done {
        reason: String,
    },
    Error {
        message: String,
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

/// Runtime state managed by Tauri — holds the IsanAgent channel and bus.
pub struct AgentRuntime {
    pub channel: Arc<TauriChannel>,
    pub app: AppHandle,
    initialized: std::sync::Mutex<bool>,
}

pub fn init(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let chat_id = uuid::Uuid::new_v4().to_string();
    let channel = Arc::new(TauriChannel::new(app.clone(), chat_id));

    app.manage(AgentRuntime {
        channel,
        app: app.clone(),
        initialized: std::sync::Mutex::new(false),
    });

    Ok(())
}

/// Start the full IsanAgent runtime. Called lazily on first message.
///
/// This bootstraps the workspace, tools, provider, and agent logic,
/// then wires the TauriChannel as the output channel.
///
/// `persona_instructions` is the active altai agent's `instructions`
/// field. When `Some`, it is appended to the workspace-derived system
/// prompt under a `## Persona` block so the runtime honors the
/// user-configured persona (e.g. Coder vs Architect vs custom agent).
///
/// `base_url_override`, when `Some`, replaces the workspace-config
/// base URL. Pass the *full* endpoint (e.g.
/// `https://api.openai.com/v1/chat/completions`,
/// `https://api.anthropic.com/v1/messages`,
/// `http://localhost:1234/v1/chat/completions`). IsanAgent's HTTP
/// clients POST to this URL as-is.
pub async fn start_agent(
    runtime: &AgentRuntime,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
) -> Result<(), String> {
    {
        let mut guard = runtime.initialized.lock().map_err(|e| e.to_string())?;
        if *guard {
            return Ok(()); // Already initialized
        }
        *guard = true;
    }

    let app = runtime.app.clone();
    let channel = runtime.channel.clone();

    // Resolve workspace (default: ~/.isanagent)
    let workspace_dir = resolve_workspace_root(None);
    if !workspace_dir.exists() {
        // Auto-create minimal workspace
        let _ = std::fs::create_dir_all(workspace_dir.join(".system_generated"));
    }

    let workspace = IsanagentWorkspace::new(None, None).map_err(|e| {
        format!("Failed to load IsanAgent workspace: {}", e)
    })?;

    // Memory (SQLite)
    let db_path = workspace
        .dir
        .join(".system_generated")
        .join("agent_memory.db");
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let db_path_str = db_path
        .to_str()
        .ok_or("workspace DB path is not valid UTF-8")?;

    let memory_actor =
        isanagent::memory::SqliteMemoryActor::new(db_path_str).map_err(|e| {
            format!("Failed to initialize SqliteMemoryActor: {}", e)
        })?;
    let memory_node = NodeHandle::<isanagent::memory::MemoryMessage>::new(
        memory_actor,
        100,
        1,
        Duration::from_millis(5),
    );

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
        subagent: None,
        doom_loop_enabled: workspace.config.doom_loop_enabled(),
        harness_runtime_summary: String::new(),
        subagent_system_prompt: String::new(),
        forbid_final_without_tools: false,
        shell_policy,
        hook_tool_ctx,
    });

    let agent_node = NodeHandle::<BusMessage>::new(agent_logic, 100, 3, Duration::from_millis(50));

    // Start the TauriChannel
    channel.start(bus_tx.clone()).await.map_err(|e| format!("TauriChannel start failed: {}", e))?;

    // Bus router: forward inbound → agent, outbound/telemetry → frontend
    let app_for_bus = app.clone();
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
                BusMessage::Telemetry(ref telemetry) => {
                    if let Some(event) = map_telemetry_to_event(telemetry) {
                        let _ = app_for_bus.emit("agent://event", &event);
                    }
                }
                BusMessage::Cancel(chat_id) => {
                    let _ = agent_node
                        .send_packet(BusMessage::Cancel(chat_id))
                        .await;
                }
                _ => {}
            }
        }
    });

    // Outbound router: agent output → channel
    let app_for_outbound = app.clone();
    async_runtime::spawn(async move {
        while let Some(out_msg) = global_outbound_rx.recv().await {
            if let BusMessage::Outbound(ref outbound) = out_msg {
                let event = Event::AgentMessage {
                    content: outbound.content.clone(),
                    role: "assistant".to_string(),
                };
                let _ = app_for_outbound.emit("agent://event", &event);
            }
        }
    });

    // Emit ready event
    let _ = app.emit(
        "agent://event",
        &Event::AgentMessage {
            content: "IsanAgent runtime initialized.".to_string(),
            role: "system".to_string(),
        },
    );

    Ok(())
}
