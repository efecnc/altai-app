use super::runtime::{self, AgentRuntime};
use tauri::State;

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
) -> Result<(), String> {
    let pname = provider_name.unwrap_or_else(|| "gemini".to_string());
    let key = api_key.unwrap_or_default();
    let model = model_name.unwrap_or_else(|| "gemini-2.5-flash".to_string());
    let persona = instructions
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let base = base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
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

    runtime::start_agent(&state, &pname, &key, &model, persona, base, workspace, permission).await
}

/// Send a user message into the IsanAgent bus, with optional image
/// attachments (base64 data URIs or https URLs) for vision-capable models.
///
/// `chat_id` scopes the message to one ALTAI chat tab (its session id), so
/// each tab keeps an isolated conversation. Empty → the channel default.
#[tauri::command]
pub async fn agent_send(
    state: State<'_, AgentRuntime>,
    message: String,
    images: Option<Vec<String>>,
    chat_id: Option<String>,
) -> Result<(), String> {
    state
        .channel
        .inject_user_message(message, images.unwrap_or_default(), chat_id.unwrap_or_default())
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

/// Cancel the current agent reasoning loop for a chat. `chat_id` empty → the
/// channel default.
#[tauri::command]
pub async fn agent_cancel(
    state: State<'_, AgentRuntime>,
    chat_id: Option<String>,
) -> Result<(), String> {
    state.channel.cancel(chat_id.unwrap_or_default()).await
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
    let workspace =
        isanagent::workspace::IsanagentWorkspace::new(workspace_root.as_deref(), None)?;
    let mut registry = isanagent::skills::SkillRegistry::new(workspace.skills_path());
    let skill = skill.as_deref().map(str::trim).filter(|s| !s.is_empty());
    registry.install_skills_from_repo(repo, skill).await
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
