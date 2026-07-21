use super::runtime::{self, AgentRuntime, CompactionArg};
use crate::modules::workspace::WorkspaceRegistry;
use serde::{Deserialize, Serialize};
use tauri::State;

/// The inbox exposes persisted prompts, notifications, and job errors. Unlike
/// the generic agent startup path, it must never open an arbitrary renderer-
/// supplied directory just to inspect a SQLite database.
fn authorized_inbox_workspace(
    workspace_path: Option<&str>,
    registry: &WorkspaceRegistry,
) -> Result<String, String> {
    let raw = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "workspacePath is required for agent inbox access".to_string())?;
    let canonical = registry
        .canonicalize_cached(raw)
        .map_err(|error| format!("Workspace is not accessible: {error}"))?;
    if !canonical.is_dir() || !registry.is_authorized(&canonical) {
        return Err("Workspace is not authorized.".to_string());
    }
    Ok(canonical.to_string_lossy().replace('\\', "/"))
}

/// Cross-provider failover spec sent from JS (camelCase) — the model the agent
/// retries on when the primary provider is exhausted. Maps to the isanagent
/// crate's `FallbackProviderSpec`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FallbackArg {
    pub provider_name: String,
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
}

/// A model-native document attachment. The desktop host deliberately carries
/// the original bytes so the selected model can parse/OCR PDFs itself.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentArg {
    pub data: String,
    pub media_type: String,
    pub name: Option<String>,
}

/// Start (or ensure running) the IsanAgent runtime.
///
/// The caller should pass provider/model info so the runtime can
/// bootstrap an LLM provider. Falls back to workspace config if empty.
///
/// `instructions` is the persona override from the active altai agent
/// (the `instructions` field on Agent). When non-empty, it is appended
/// to the workspace system prompt so custom personas survive routing
/// through IsanAgent.
///
/// `base_url`, when provided, is the *full* chat-completions (or
/// `/v1/messages` for Anthropic) endpoint to POST against. It overrides
/// the workspace-config default. The JS side derives it from the
/// active model so the model picker actually controls where requests
/// go (OpenAI vs xAI vs Groq vs LM Studio etc.).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command surface: each field is an explicit IPC arg.
pub async fn agent_start(
    state: State<'_, AgentRuntime>,
    provider_name: Option<String>,
    api_key: Option<String>,
    model_name: Option<String>,
    instructions: Option<String>,
    base_url: Option<String>,
    workspace_path: Option<String>,
    permission_mode: Option<String>,
    compaction: Option<CompactionArg>,
) -> Result<(), String> {
    let pname = provider_name.unwrap_or_else(|| "gemini".to_string());
    let key = api_key.unwrap_or_default();
    let model = model_name.unwrap_or_else(|| "gemini-2.5-flash".to_string());
    let persona = instructions
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let base = base_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // The user-selected workspace folder. IsanAgent roots its workspace at
    // `<folder>/.isanagent` so memory/sandbox/config live with the project,
    // not under `~/.isanagent`.
    let workspace = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // Active UI permission mode ("ask" | "auto-edit" | "bypass"). Maps to the
    // IsanAgent shell policy so the toolbar toggle actually governs the gate.
    let permission = permission_mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    runtime::start_agent(
        &state,
        &pname,
        &key,
        &model,
        persona,
        base,
        workspace,
        permission,
        compaction.as_ref(),
    )
    .await
}

/// Send a user message, routing it to the runtime instance that owns this
/// chat. The per-message `config` (provider/model/key/persona/base/workspace/
/// permission) lets different chats run on different models concurrently
/// without tearing anything down — `route_send` picks or creates the matching
/// instance. Defaults mirror `agent_start`.
///
/// `chat_id` scopes the message to one ALTAI chat tab (its session id), so
/// each tab keeps an isolated conversation. Empty → the channel default.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command surface: each field is an explicit IPC arg.
pub async fn agent_send(
    state: State<'_, AgentRuntime>,
    message: String,
    images: Option<Vec<String>>,
    documents: Option<Vec<DocumentArg>>,
    chat_id: Option<String>,
    provider_name: Option<String>,
    api_key: Option<String>,
    model_name: Option<String>,
    instructions: Option<String>,
    base_url: Option<String>,
    workspace_path: Option<String>,
    permission_mode: Option<String>,
    fallback: Option<FallbackArg>,
    compaction: Option<CompactionArg>,
) -> Result<(), String> {
    let pname = provider_name.unwrap_or_else(|| "gemini".to_string());
    let key = api_key.unwrap_or_default();
    let model = model_name.unwrap_or_else(|| "gemini-2.5-flash".to_string());
    let persona = instructions
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let base = base_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let workspace = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let permission = permission_mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let fb = fallback.map(|f| isanagent::agent::FallbackProviderSpec {
        provider_name: f.provider_name,
        base_url: f.base_url,
        api_key: f.api_key,
        model_name: f.model_name,
    });

    runtime::route_send(
        &state,
        &pname,
        &key,
        &model,
        persona,
        base,
        workspace,
        permission,
        compaction.as_ref(),
        fb,
        message,
        images.unwrap_or_default(),
        documents.unwrap_or_default(),
        chat_id.unwrap_or_default(),
    )
    .await
}

/// Approve or deny an agent action.
///
/// Note: code-exec / destructive-shell approvals do NOT flow through this command. The runtime
/// gate (driven by the active permission mode via `agent_start`) raises an `ask_user`
/// clarification, which surfaces to the UI as a `Clarification` event with approve/deny choices;
/// replying resolves the pending wait. This ID-based command is retained for a future
/// non-clarification approval surface and is intentionally a no-op today.
#[tauri::command]
pub async fn agent_approve(
    _state: State<'_, AgentRuntime>,
    _approval_id: String,
    _approved: bool,
) -> Result<(), String> {
    Ok(())
}

/// Cancel the current agent reasoning loop for a chat, routed to the instance
/// that owns `chat_id`. Empty → the default instance.
#[tauri::command]
pub async fn agent_cancel(
    state: State<'_, AgentRuntime>,
    chat_id: Option<String>,
) -> Result<(), String> {
    runtime::route_cancel(&state, chat_id.unwrap_or_default()).await
}

/// List all chat sessions persisted in the active workspace's backend memory DB.
///
/// This is the reconciliation source for the frontend chat-history list: it
/// returns every conversation the agent actually ran (keyed by `tauri:<chat_id>:`),
/// including chats that were closed and dropped from the ephemeral
/// `altai-ai-sessions.json`. The frontend merges these in on hydration so closed
/// chats reappear in history — matching Claude Code / Cursor, where the durable
/// backend store is the source of truth.
#[tauri::command]
pub async fn agent_list_sessions(
    state: State<'_, AgentRuntime>,
    workspace_path: Option<String>,
) -> Result<Vec<runtime::SessionInfo>, String> {
    let ws = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    runtime::list_sessions(&state, ws).await
}

/// Load the full message history for a single chat from the backend memory DB.
///
/// Counterpart to `agent_list_sessions`: recovers the *contents* of a session so
/// a reopened (previously-closed) chat renders its real conversation instead of
/// an empty thread. Returns raw OpenAI-style messages; the frontend maps them to
/// its UIMessage shape.
#[tauri::command]
pub async fn agent_get_session_messages(
    state: State<'_, AgentRuntime>,
    chat_id: String,
    workspace_path: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let ws = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let messages = runtime::get_session_messages(&state, ws, &chat_id).await?;
    // ChatMessage is serde::Serialize in the isanagent crate; map to Value here so
    // the Tauri IPC layer serializes plain JSON objects (stable across versions).
    messages
        .into_iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to serialize messages: {}", e))
}

/// Rewind a chat's backend history to the N-th user message.
///
/// Sends `TruncateAfterUserMessage` to the per-workspace memory actor: keep
/// everything up to and including the `keep_user_messages`-th user-role message
/// (1-based, insert order), delete the rest. Returns the number of deleted rows
/// (`0` is a no-op; `keep_user_messages == 0` wipes the whole thread). This
/// backs the frontend's conversation edit / retry / checkpoint-rollback — the
/// durable history lives in the backend, so the rewind must too.
#[tauri::command]
pub async fn agent_truncate_after_user_message(
    state: State<'_, AgentRuntime>,
    chat_id: String,
    keep_user_messages: usize,
    workspace_path: Option<String>,
) -> Result<usize, String> {
    let ws = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    runtime::truncate_after_user_message(&state, ws, &chat_id, keep_user_messages).await
}

#[tauri::command]
pub async fn agent_list_notifications(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: Option<String>,
    unseen_only: Option<bool>,
    limit: Option<usize>,
) -> Result<Vec<runtime::AgentNotificationInfo>, String> {
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    let chat = chat_id
        .as_deref()
        .map(runtime::validate_tauri_chat_id)
        .transpose()?;
    runtime::list_notifications(
        &state,
        Some(&workspace),
        chat,
        unseen_only.unwrap_or(false),
        limit.unwrap_or(100),
    )
    .await
}

#[tauri::command]
pub async fn agent_notification_mark_seen(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: String,
    notification_id: String,
) -> Result<(), String> {
    let chat = runtime::validate_tauri_chat_id(&chat_id)?;
    let id = notification_id.trim();
    if id.is_empty() {
        return Err("notificationId is required".to_string());
    }
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    runtime::mark_notification_seen(&state, Some(&workspace), chat, id).await
}

#[tauri::command]
pub async fn agent_notification_resolve(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: String,
    notification_id: String,
) -> Result<(), String> {
    let chat = runtime::validate_tauri_chat_id(&chat_id)?;
    let id = notification_id.trim();
    if id.is_empty() {
        return Err("notificationId is required".to_string());
    }
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    runtime::resolve_notification(&state, Some(&workspace), chat, id).await
}

#[tauri::command]
pub async fn agent_list_background_jobs(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<runtime::AgentBackgroundJobInfo>, String> {
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    let chat = chat_id
        .as_deref()
        .map(runtime::validate_tauri_chat_id)
        .transpose()?;
    runtime::list_background_jobs(&state, Some(&workspace), chat, limit.unwrap_or(100)).await
}

#[tauri::command]
pub async fn agent_background_job_dismiss(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: String,
    job_id: String,
) -> Result<(), String> {
    let chat = runtime::validate_tauri_chat_id(&chat_id)?;
    let id = job_id.trim();
    if id.is_empty() {
        return Err("jobId is required".to_string());
    }
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    runtime::dismiss_background_job(&state, Some(&workspace), chat, id).await
}

#[tauri::command]
pub async fn agent_list_clarification_tickets(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: Option<String>,
    status: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<runtime::AgentClarificationTicketInfo>, String> {
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    let chat = chat_id
        .as_deref()
        .map(runtime::validate_tauri_chat_id)
        .transpose()?;
    let ticket_status = status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    runtime::list_clarification_tickets(
        &state,
        Some(&workspace),
        chat,
        ticket_status,
        limit.unwrap_or(100),
    )
    .await
}

#[tauri::command]
pub async fn agent_clarification_ticket_dismiss(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: String,
    ticket_id: String,
) -> Result<(), String> {
    let chat = runtime::validate_tauri_chat_id(&chat_id)?;
    let id = ticket_id.trim();
    if id.is_empty() {
        return Err("ticketId is required".to_string());
    }
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    runtime::dismiss_clarification_ticket(&state, Some(&workspace), chat, id).await
}

/// Reply to a persisted background clarification. The runtime validates the
/// ticket's workspace/chat ownership before routing a trusted synthetic
/// inbound to exactly one bound agent instance.
#[tauri::command]
pub async fn agent_clarification_ticket_reply(
    state: State<'_, AgentRuntime>,
    registry: State<'_, WorkspaceRegistry>,
    workspace_path: Option<String>,
    chat_id: String,
    ticket_id: String,
    response: String,
) -> Result<(), String> {
    let chat = runtime::validate_tauri_chat_id(&chat_id)?;
    let id = ticket_id.trim();
    if id.is_empty() {
        return Err("ticketId is required".to_string());
    }
    let workspace = authorized_inbox_workspace(workspace_path.as_deref(), &registry)?;
    runtime::reply_to_clarification_ticket(&state, Some(&workspace), chat, id, &response).await
}

/// Fetch paper metadata directly from the arXiv Atom API.
/// Returns `{ title, authors, abstract, url }` for the confirmation card.
/// Does NOT require the IsanAgent runtime to be running.
#[tauri::command]
pub async fn agent_fetch_paper(url: String) -> Result<serde_json::Value, String> {
    let arxiv_id = extract_arxiv_id(&url).ok_or_else(|| {
        "Invalid arXiv URL. Expected format: arxiv.org/abs/XXXX.XXXXX".to_string()
    })?;

    let api_url = format!("https://export.arxiv.org/api/query?id_list={}", arxiv_id);
    let client = reqwest::Client::new();
    let response = client
        .get(&api_url)
        .send()
        .await
        .map_err(|e| format!("arXiv request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("arXiv returned status {}", response.status()));
    }

    let xml = response
        .text()
        .await
        .map_err(|e| format!("Failed to read arXiv response: {}", e))?;

    parse_arxiv_atom(&xml, &arxiv_id)
}

/// One pre-edit checkpoint, as exposed to the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointInfo {
    pub id: String,
    /// Absolute path of the file that was (or would be) mutated.
    pub path: String,
    /// The tool that triggered the snapshot (e.g. `edit_file`).
    pub label: String,
    /// Unix ms when the snapshot was taken.
    pub created_ms: u64,
    /// False when the file did not exist pre-edit — restoring it removes the file.
    pub existed: bool,
}

fn to_info(e: isanagent::checkpoint::CheckpointEntry) -> CheckpointInfo {
    CheckpointInfo {
        id: e.id,
        path: e.path,
        label: e.label,
        // ms timestamp — fits u64 comfortably (u128 source guards against overflow).
        created_ms: e.created_ms as u64,
        existed: e.existed,
    }
}

/// List available pre-edit checkpoints, newest first. Empty when checkpointing
/// is disabled or nothing has been edited yet. Does not require the runtime.
#[tauri::command]
pub fn checkpoint_list() -> Vec<CheckpointInfo> {
    isanagent::checkpoint::store()
        .map(|s| s.list().into_iter().map(to_info).collect())
        .unwrap_or_default()
}

/// Restore the file recorded by checkpoint `id` to its pre-edit state (undo a
/// single agent edit). Returns a human-readable summary of what was restored.
#[tauri::command]
pub fn checkpoint_restore(id: String) -> Result<String, String> {
    match isanagent::checkpoint::store() {
        Some(s) => s.restore(&id),
        None => Err("Checkpoints are not enabled.".to_string()),
    }
}

/// Install one or more agent skills from a GitHub repository into the active
/// workspace's `skills/` directory (isanagent #45). `repo_url` accepts a full
/// URL or `owner/repo` shorthand; `skill`, when given, installs only that one
/// skill from the repo. Returns the names of the installed skills.
///
/// Does not require the runtime: it builds a throwaway registry over the
/// workspace skills path and clones into it, mirroring isanagent's own
/// `skills add` CLI. A running agent picks the new skill up on its next
/// `load_skill` miss (isanagent #55) — no restart needed.
#[tauri::command]
pub async fn agent_install_skill(
    workspace_path: Option<String>,
    repo_url: String,
    skill: Option<String>,
) -> Result<Vec<String>, String> {
    let repo = repo_url.trim();
    if repo.is_empty() {
        return Err("A repository URL or owner/repo is required.".to_string());
    }
    // Same workspace rooting as `start_agent`: `<folder>/.isanagent`, or the
    // crate default (`~/.isanagent`) when no folder is selected.
    let workspace_root = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|p| format!("{}/.isanagent", p.trim_end_matches('/')));
    let workspace = isanagent::workspace::IsanagentWorkspace::new(workspace_root.as_deref(), None)?;
    let mut registry = isanagent::skills::SkillRegistry::new(workspace.skills_path());
    let skill = skill.as_deref().map(str::trim).filter(|s| !s.is_empty());
    registry.install_skills_from_repo(repo, skill).await
}

/// A lightweight index of skills installed in this workspace. Skills remain
/// owned and loaded by IsanAgent; this only gives ALTAI a safe UI catalogue.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkillInfo {
    pub name: String,
    pub description: Option<String>,
}

#[tauri::command]
pub fn agent_list_skills(
    workspace_path: Option<String>,
) -> Result<Vec<InstalledSkillInfo>, String> {
    let workspace_root = workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|p| format!("{}/.isanagent", p.trim_end_matches('/')));
    let workspace = isanagent::workspace::IsanagentWorkspace::new(workspace_root.as_deref(), None)?;
    let path = workspace.skills_path();
    let entries = match std::fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut skills = entries
        .flatten()
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            if !kind.is_dir() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().trim().to_string();
            if name.is_empty() || name.starts_with('.') {
                return None;
            }
            let description = std::fs::read_to_string(entry.path().join("SKILL.md"))
                .ok()
                .and_then(|text| skill_description(&text));
            Some(InstalledSkillInfo { name, description })
        })
        .collect::<Vec<_>>();
    skills.sort_by_key(|skill| skill.name.to_lowercase());
    Ok(skills)
}

fn skill_description(text: &str) -> Option<String> {
    for line in text.lines().take(40) {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("description:") {
            let value = value.trim().trim_matches(['\'', '"']);
            if !value.is_empty() {
                return Some(value.chars().take(180).collect());
            }
        }
    }
    None
}

fn extract_arxiv_id(url: &str) -> Option<String> {
    let url = url.trim();
    for prefix in &["arxiv.org/abs/", "arxiv.org/pdf/"] {
        if let Some(pos) = url.find(prefix) {
            let after = &url[pos + prefix.len()..];
            let id: String = after
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    let bare = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    if bare
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false)
    {
        let id: String = bare
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if id.contains('.') {
            return Some(id);
        }
    }
    None
}

fn parse_arxiv_atom(xml: &str, arxiv_id: &str) -> Result<serde_json::Value, String> {
    let title = extract_tag(xml, "title")
        .and_then(|titles| titles.into_iter().nth(1))
        .unwrap_or_else(|| "Unknown title".to_string())
        .trim()
        .replace('\n', " ");

    let summary = extract_tag(xml, "summary")
        .and_then(|v| v.into_iter().next())
        .unwrap_or_default()
        .trim()
        .replace('\n', " ");

    let authors: Vec<String> = extract_nested_tag(xml, "author", "name");

    if authors.is_empty() && title == "Unknown title" {
        return Err(format!("Paper {} not found on arXiv", arxiv_id));
    }

    Ok(serde_json::json!({
        "title": title,
        "authors": authors,
        "abstract": summary,
        "url": format!("https://arxiv.org/abs/{}", arxiv_id),
    }))
}

fn extract_tag(xml: &str, tag: &str) -> Option<Vec<String>> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    let mut results = Vec::new();
    let mut search_from = 0;

    while let Some(start_pos) = xml[search_from..].find(&open) {
        let abs_start = search_from + start_pos;
        let content_start = match xml[abs_start..].find('>') {
            Some(p) => abs_start + p + 1,
            None => break,
        };
        let content_end = match xml[content_start..].find(&close) {
            Some(p) => content_start + p,
            None => break,
        };
        results.push(xml[content_start..content_end].to_string());
        search_from = content_end + close.len();
    }

    if results.is_empty() {
        None
    } else {
        Some(results)
    }
}

fn extract_nested_tag(xml: &str, outer: &str, inner: &str) -> Vec<String> {
    let open_outer = format!("<{}", outer);
    let close_outer = format!("</{}>", outer);
    let mut results = Vec::new();
    let mut search_from = 0;

    while let Some(start_pos) = xml[search_from..].find(&open_outer) {
        let abs_start = search_from + start_pos;
        let block_end = match xml[abs_start..].find(&close_outer) {
            Some(p) => abs_start + p + close_outer.len(),
            None => break,
        };
        let block = &xml[abs_start..block_end];
        if let Some(names) = extract_tag(block, inner) {
            for name in names {
                results.push(name.trim().to_string());
            }
        }
        search_from = block_end;
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_workspace_must_be_explicit_and_authorized() {
        let root = tempfile::tempdir().expect("temp workspace");
        let registry = WorkspaceRegistry::default();
        let path = root.path().to_string_lossy().to_string();

        assert!(authorized_inbox_workspace(None, &registry).is_err());
        assert!(authorized_inbox_workspace(Some(&path), &registry).is_err());

        registry.authorize(root.path()).expect("authorize workspace");
        let canonical = authorized_inbox_workspace(Some(&path), &registry)
            .expect("authorized workspace");
        assert_eq!(
            canonical,
            std::fs::canonicalize(root.path())
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
    }

    #[test]
    fn checkpoint_entry_maps_to_camel_case_info() {
        let info = to_info(isanagent::checkpoint::CheckpointEntry {
            id: "abc".into(),
            path: "/w/file.rs".into(),
            label: "edit_file".into(),
            created_ms: 1_700_000_000_000,
            existed: true,
        });
        assert_eq!(info.id, "abc");
        assert_eq!(info.path, "/w/file.rs");
        assert_eq!(info.created_ms, 1_700_000_000_000);
        assert!(info.existed);
        // Serializes camelCase for the frontend (`createdMs`, not `created_ms`).
        let json = serde_json::to_value(&info).unwrap();
        assert!(json.get("createdMs").is_some());
        assert!(json.get("created_ms").is_none());
    }

    #[test]
    fn checkpoint_list_is_empty_when_store_uninitialized() {
        // The global checkpoint store is only init'd by the live runtime, never
        // in unit tests — so listing yields nothing rather than panicking.
        assert!(checkpoint_list().is_empty());
    }
}
