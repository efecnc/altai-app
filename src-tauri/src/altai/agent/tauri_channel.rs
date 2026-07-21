use async_trait::async_trait;
use isanagent::bus::{BusMessage, OutboundMessage};
use isanagent::channels::Channel;
use log::info;
use std::any::Any;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::Sender;
use tokio::sync::Mutex;

use super::commands::DocumentArg;
use super::runtime::Event;

/// A Tauri-native channel that bridges IsanAgent's bus system to the
/// frontend via the Tauri event bus (`agent://event`).
///
/// Replaces the old sidecar HTTP bridge — IsanAgent runs in-process.
pub struct TauriChannel {
    app: AppHandle,
    chat_id: String,
    bus_tx: Mutex<Option<Sender<BusMessage>>>,
}

impl TauriChannel {
    pub fn new(app: AppHandle, chat_id: String) -> Self {
        Self {
            app,
            chat_id,
            bus_tx: Mutex::new(None),
        }
    }

    /// Send an inbound user message into the IsanAgent bus.
    ///
    /// `image_urls` are base64 data URIs (`data:<media_type>;base64,…`) or
    /// https URLs; they become multimodal `ImageUrl` attachments that the
    /// provider layer forwards to vision-capable models.
    ///
    /// `chat_id` scopes the conversation to one ALTAI chat tab — IsanAgent
    /// keys history/memory by `inbound.chat_id`, so a distinct id per tab
    /// keeps each tab's conversation isolated. Falls back to the channel's
    /// default id when empty.
    pub async fn inject_user_message(
        &self,
        content: String,
        image_urls: Vec<String>,
        documents: Vec<DocumentArg>,
        chat_id: String,
    ) -> Result<(), String> {
        let guard = self.bus_tx.lock().await;
        let tx = guard.as_ref().ok_or("TauriChannel not started")?;
        let mut attachments: Vec<_> = image_urls
            .into_iter()
            .map(|url| isanagent::utils::ContentPart::ImageUrl {
                image_url: isanagent::utils::ImageUrl { url, detail: None },
            })
            .collect();
        attachments.extend(documents.into_iter().map(|document| {
            isanagent::utils::ContentPart::Document {
                document: isanagent::utils::Document {
                    data: document.data,
                    media_type: document.media_type,
                    name: document.name,
                },
            }
        }));
        let chat_id = if chat_id.is_empty() {
            self.chat_id.clone()
        } else {
            chat_id
        };
        let msg = isanagent::bus::InboundMessage {
            channel: self.name().to_string(),
            sender_id: "tauri_user".to_string(),
            chat_id,
            thread_id: None,
            content,
            attachments,
            metadata: std::collections::HashMap::new(),
        };
        tx.send(BusMessage::Inbound(msg))
            .await
            .map_err(|e| format!("Failed to send to bus: {}", e))
    }

    /// Signal cancellation for a chat. `chat_id` empty → the channel default.
    pub async fn cancel(&self, chat_id: String) -> Result<(), String> {
        let guard = self.bus_tx.lock().await;
        let tx = guard.as_ref().ok_or("TauriChannel not started")?;
        let chat_id = if chat_id.is_empty() {
            self.chat_id.clone()
        } else {
            chat_id
        };
        tx.send(BusMessage::Cancel(chat_id))
            .await
            .map_err(|e| format!("Cancel failed: {}", e))
    }

    /// Get the chat ID for this channel session.
    #[allow(dead_code)]
    pub fn chat_id(&self) -> &str {
        &self.chat_id
    }
}

#[async_trait]
impl Channel for TauriChannel {
    fn name(&self) -> &str {
        "tauri"
    }

    async fn start(&self, bus_tx: Sender<BusMessage>) -> Result<(), String> {
        let mut guard = self.bus_tx.lock().await;
        *guard = Some(bus_tx);
        info!("TauriChannel started for chat_id={}", self.chat_id);
        Ok(())
    }

    async fn stop(&self) -> Result<(), String> {
        let mut guard = self.bus_tx.lock().await;
        *guard = None;
        info!("TauriChannel stopped");
        Ok(())
    }

    async fn send(&self, msg: OutboundMessage) -> Result<(), String> {
        let event = Event::AgentMessage {
            content: msg.content,
            role: "assistant".to_string(),
        };
        self.app
            .emit("agent://event", &event)
            .map_err(|e| format!("Tauri emit failed: {}", e))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// Forward IsanAgent telemetry events to the Tauri frontend.
///
/// Called from the bus router in runtime.rs to map `TelemetryEvent`
/// variants to the `Event` enum the frontend already understands.
pub fn map_telemetry_to_event(telemetry: &isanagent::bus::TelemetryEvent) -> Option<Event> {
    use isanagent::bus::TelemetryEvent;
    match telemetry {
        TelemetryEvent::ToolCall {
            tool_name,
            tool_call_id,
            args,
            ..
        } => Some(Event::ToolCallStart {
            id: tool_call_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: tool_name.clone(),
            input: serde_json::from_str(args).unwrap_or(serde_json::Value::String(args.clone())),
        }),
        TelemetryEvent::ToolResult {
            tool_name,
            tool_call_id,
            result,
            is_error,
            ..
        } => Some(Event::ToolCallEnd {
            id: tool_call_id.clone().unwrap_or_else(|| tool_name.clone()),
            name: tool_name.clone(),
            output: serde_json::Value::String(result.clone()),
            // isanagent sets `is_error` accurately for both in-band tool
            // failures (e.g. `edit_file` "old_text not found") and non-zero
            // `exec`/`python_run` exit codes. Forward it so the UI renders a
            // failed tool call in its error state instead of as successful
            // output. When `error` is set the frontend uses it as the error
            // body and omits `output`, so the text isn't duplicated.
            error: is_error.then(|| result.clone()),
        }),
        TelemetryEvent::AgentThought { thought, .. } => Some(Event::Thinking {
            content: thought.clone(),
        }),
        TelemetryEvent::AgentUsage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cache_read_tokens,
            cache_creation_tokens,
            ..
        } => Some(Event::Usage {
            prompt_tokens: *prompt_tokens,
            completion_tokens: *completion_tokens,
            total_tokens: *total_tokens,
            cache_read_tokens: *cache_read_tokens,
            cache_creation_tokens: *cache_creation_tokens,
        }),
        TelemetryEvent::ToolProgress {
            tool_name, message, ..
        } => Some(Event::Thinking {
            content: format!("[{}] {}", tool_name, message),
        }),
        TelemetryEvent::ExecutionRunFinished {
            provider_id,
            session_id,
            exit_code,
            duration_ms,
            stdout_len,
            stderr_len,
            artifact_count,
            git_head,
            description,
            ..
        } => Some(Event::ExecutionRunFinished {
            provider_id: provider_id.clone(),
            session_id: session_id.clone(),
            exit_code: *exit_code,
            duration_ms: *duration_ms,
            stdout_len: *stdout_len,
            stderr_len: *stderr_len,
            artifact_count: *artifact_count,
            git_head: git_head.clone(),
            description: description.clone(),
        }),
        TelemetryEvent::ExecutionJobFinished {
            job_id,
            session_id,
            provider_id,
            status,
            exit_code,
            duration_ms,
            stdout_len,
            stderr_len,
            artifact_count,
            description,
            ..
        } => Some(Event::ExecutionJobFinished {
            job_id: job_id.clone(),
            session_id: session_id.clone(),
            provider_id: provider_id.clone(),
            status: status.clone(),
            exit_code: *exit_code,
            duration_ms: *duration_ms,
            stdout_len: *stdout_len,
            stderr_len: *stderr_len,
            artifact_count: *artifact_count,
            description: description.clone(),
        }),
        TelemetryEvent::BackgroundJobUpdated {
            job_id,
            state,
            kind,
            detail,
            ..
        } => Some(Event::BackgroundJobUpdated {
            job_id: job_id.clone(),
            state: state.clone(),
            kind: kind.clone(),
            detail: detail.clone(),
        }),
        TelemetryEvent::NotificationCreated {
            notification_id,
            channel,
            kind,
            title,
            ..
        } if channel == "tauri" => Some(Event::NotificationCreated {
            notification_id: notification_id.clone(),
            kind: kind.clone(),
            title: title.clone(),
        }),
        TelemetryEvent::NotificationUpdated {
            notification_id,
            channel,
            state,
            ..
        } if channel == "tauri" => Some(Event::NotificationUpdated {
            notification_id: notification_id.clone(),
            state: state.clone(),
        }),
        TelemetryEvent::SubagentSpawned {
            child_chat_id,
            task_id,
            display_name,
            agent_name,
            background_job_id,
            ..
        } => Some(Event::SubagentSpawned {
            task_id: task_id.clone(),
            child_chat_id: child_chat_id.clone(),
            display_name: display_name.clone(),
            agent_name: agent_name.clone(),
            background_job_id: background_job_id.clone(),
        }),
        TelemetryEvent::SubagentFinished {
            child_chat_id,
            task_id,
            status,
            agent_name,
            ..
        } => Some(Event::SubagentFinished {
            task_id: task_id.clone(),
            child_chat_id: child_chat_id.clone(),
            status: status.clone(),
            agent_name: agent_name.clone(),
        }),
        _ => None,
    }
}

/// The originating `chat_id` of a telemetry event, for per-chat event routing.
/// Returns `None` for variants that aren't scoped to a chat.
pub fn telemetry_chat_id(telemetry: &isanagent::bus::TelemetryEvent) -> Option<&str> {
    use isanagent::bus::TelemetryEvent::*;
    match telemetry {
        ToolCall { chat_id, .. }
        | ToolResult { chat_id, .. }
        | AgentThought { chat_id, .. }
        | AgentUsage { chat_id, .. }
        | ToolProgress { chat_id, .. }
        | ExecutionRunFinished { chat_id, .. }
        | ExecutionJobFinished { chat_id, .. }
        | BackgroundJobUpdated { chat_id, .. }
        | NotificationCreated { chat_id, .. }
        | NotificationUpdated { chat_id, .. } => Some(chat_id.as_str()),
        // Subagent events are scoped to the *parent* chat — that's the session
        // the UI filters on, so route them by `parent_chat_id`.
        SubagentSpawned { parent_chat_id, .. } | SubagentFinished { parent_chat_id, .. } => {
            Some(parent_chat_id.as_str())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- map_telemetry_to_event exhaustive coverage ---

    fn event_type(e: &Event) -> &str {
        match e {
            Event::AgentMessage { .. } => "agent_message",
            Event::ToolCallStart { .. } => "tool_call_start",
            Event::ToolCallEnd { .. } => "tool_call_end",
            Event::EditDiff { .. } => "edit_diff",
            Event::ApprovalRequest { .. } => "approval_request",
            Event::Thinking { .. } => "thinking",
            Event::Clarification { .. } => "clarification",
            Event::Usage { .. } => "usage",
            Event::Done { .. } => "done",
            Event::Error { .. } => "error",
            Event::ExecutionRunFinished { .. } => "execution_run_finished",
            Event::ExecutionJobFinished { .. } => "execution_job_finished",
            Event::BackgroundJobUpdated { .. } => "background_job_updated",
            Event::NotificationCreated { .. } => "notification_created",
            Event::NotificationUpdated { .. } => "notification_updated",
            Event::SubagentSpawned { .. } => "subagent_spawned",
            Event::SubagentFinished { .. } => "subagent_finished",
            Event::NotebookOutput { .. } => "notebook_output",
            Event::ExperimentResult { .. } => "experiment_result",
        }
    }

    fn te_tool_call() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::ToolCall {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            tool_name: "read_file".into(),
            args: r#"{"path":"/x"}"#.into(),
            tool_call_id: Some("tc1".into()),
            background_job_id: None,
        }
    }

    fn te_tool_result() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::ToolResult {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            tool_name: "read_file".into(),
            result: "hello".into(),
            is_error: false,
            tool_call_id: Some("tc1".into()),
            background_job_id: None,
        }
    }

    fn te_agent_thought() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::AgentThought {
            chat_id: "c1".into(),
            thought: "hmm".into(),
            background_job_id: None,
        }
    }

    fn te_agent_usage() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::AgentUsage {
            chat_id: "c1".into(),
            model: "gpt-4".into(),
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            background_job_id: None,
        }
    }

    fn te_tool_progress() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::ToolProgress {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            tool_name: "execution_run".into(),
            tool_call_id: Some("tc2".into()),
            message: "installing deps".into(),
            background_job_id: None,
        }
    }

    fn te_execution_run_finished() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::ExecutionRunFinished {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            provider_id: "local".into(),
            session_id: "s1".into(),
            exit_code: Some(0),
            duration_ms: 1200,
            stdout_len: 42,
            stderr_len: 0,
            artifact_count: 3,
            git_head: Some("abc123".into()),
            description: Some("train".into()),
        }
    }

    fn te_execution_job_finished() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::ExecutionJobFinished {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            job_id: "j1".into(),
            session_id: "s1".into(),
            provider_id: "local".into(),
            status: "completed".into(),
            duration_ms: 5000,
            exit_code: Some(0),
            stdout_len: 100,
            stderr_len: 5,
            artifact_count: 1,
            description: Some("bg job".into()),
        }
    }

    fn te_background_job_updated() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::BackgroundJobUpdated {
            job_id: "j1".into(),
            chat_id: "c1".into(),
            channel: "tauri".into(),
            state: "running".into(),
            kind: "execution".into(),
            detail: Some("step 2/5".into()),
        }
    }

    fn te_subagent_spawned() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::SubagentSpawned {
            parent_chat_id: "c1".into(),
            child_chat_id: "c2".into(),
            task_id: "t1".into(),
            // Distinct values so the mapping test proves display_name and
            // agent_name aren't cross-wired.
            display_name: Some("Research run #2".into()),
            agent_name: Some("researcher".into()),
            background_job_id: None,
        }
    }

    fn te_subagent_finished() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::SubagentFinished {
            parent_chat_id: "c1".into(),
            child_chat_id: "c2".into(),
            task_id: "t1".into(),
            status: "completed".into(),
            agent_name: Some("researcher".into()),
        }
    }

    // Variants that should hit _ => None
    fn te_cron_trigger() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::CronTrigger {
            job_id: "cj1".into(),
            message: "tick".into(),
        }
    }

    fn te_notification_created() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::NotificationCreated {
            notification_id: "n1".into(),
            chat_id: "c1".into(),
            channel: "tauri".into(),
            kind: "info".into(),
            title: "Job done".into(),
        }
    }

    fn te_notification_updated() -> isanagent::bus::TelemetryEvent {
        isanagent::bus::TelemetryEvent::NotificationUpdated {
            notification_id: "n1".into(),
            chat_id: "c1".into(),
            channel: "tauri".into(),
            state: "seen".into(),
        }
    }

    #[test]
    fn tool_call_maps_to_tool_call_start() {
        let e = map_telemetry_to_event(&te_tool_call()).unwrap();
        assert_eq!(event_type(&e), "tool_call_start");
        if let Event::ToolCallStart { id, name, input } = e {
            assert_eq!(id, "tc1");
            assert_eq!(name, "read_file");
            assert_eq!(input, serde_json::json!({"path": "/x"}));
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn tool_result_maps_to_tool_call_end() {
        let e = map_telemetry_to_event(&te_tool_result()).unwrap();
        assert_eq!(event_type(&e), "tool_call_end");
        if let Event::ToolCallEnd {
            id,
            name,
            output,
            error,
        } = e
        {
            assert_eq!(id, "tc1");
            assert_eq!(name, "read_file");
            assert_eq!(output, serde_json::Value::String("hello".into()));
            // is_error: false → no error, output carried normally.
            assert!(error.is_none());
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn failed_tool_result_surfaces_error_text() {
        // is_error: true → the result text rides through as `error` so the
        // frontend renders the tool cell in its `output-error` state.
        let te = isanagent::bus::TelemetryEvent::ToolResult {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            tool_name: "edit_file".into(),
            result: "Error: old_text not found".into(),
            is_error: true,
            tool_call_id: Some("tc1".into()),
            background_job_id: None,
        };
        let e = map_telemetry_to_event(&te).unwrap();
        if let Event::ToolCallEnd { error, output, .. } = e {
            assert_eq!(error.as_deref(), Some("Error: old_text not found"));
            // output still carries the same text; the frontend prefers `error`.
            assert_eq!(
                output,
                serde_json::Value::String("Error: old_text not found".into())
            );
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn agent_thought_maps_to_thinking() {
        let e = map_telemetry_to_event(&te_agent_thought()).unwrap();
        assert_eq!(event_type(&e), "thinking");
        if let Event::Thinking { content } = e {
            assert_eq!(content, "hmm");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn agent_usage_maps_to_usage() {
        let e = map_telemetry_to_event(&te_agent_usage()).unwrap();
        assert_eq!(event_type(&e), "usage");
        if let Event::Usage {
            prompt_tokens,
            completion_tokens,
            total_tokens,
            ..
        } = e
        {
            assert_eq!(prompt_tokens, 100);
            assert_eq!(completion_tokens, 50);
            assert_eq!(total_tokens, 150);
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn tool_progress_maps_to_thinking_with_prefix() {
        let e = map_telemetry_to_event(&te_tool_progress()).unwrap();
        assert_eq!(event_type(&e), "thinking");
        if let Event::Thinking { content } = e {
            assert!(content.starts_with("[execution_run]"));
            assert!(content.contains("installing deps"));
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn execution_run_finished_round_trips_fields() {
        let e = map_telemetry_to_event(&te_execution_run_finished()).unwrap();
        assert_eq!(event_type(&e), "execution_run_finished");
        if let Event::ExecutionRunFinished {
            provider_id,
            session_id,
            exit_code,
            duration_ms,
            stdout_len,
            stderr_len,
            artifact_count,
            git_head,
            description,
        } = e
        {
            assert_eq!(provider_id, "local");
            assert_eq!(session_id, "s1");
            assert_eq!(exit_code, Some(0));
            assert_eq!(duration_ms, 1200);
            assert_eq!(stdout_len, 42);
            assert_eq!(stderr_len, 0);
            assert_eq!(artifact_count, 3);
            assert_eq!(git_head.unwrap(), "abc123");
            assert_eq!(description.unwrap(), "train");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn execution_job_finished_round_trips_fields() {
        let e = map_telemetry_to_event(&te_execution_job_finished()).unwrap();
        assert_eq!(event_type(&e), "execution_job_finished");
        if let Event::ExecutionJobFinished {
            job_id,
            session_id,
            provider_id,
            status,
            exit_code,
            duration_ms,
            stdout_len,
            stderr_len,
            artifact_count,
            description,
        } = e
        {
            assert_eq!(job_id, "j1");
            assert_eq!(session_id, "s1");
            assert_eq!(provider_id, "local");
            assert_eq!(status, "completed");
            assert_eq!(exit_code, Some(0));
            assert_eq!(duration_ms, 5000);
            assert_eq!(stdout_len, 100);
            assert_eq!(stderr_len, 5);
            assert_eq!(artifact_count, 1);
            assert_eq!(description.unwrap(), "bg job");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn background_job_updated_maps_correctly() {
        let e = map_telemetry_to_event(&te_background_job_updated()).unwrap();
        assert_eq!(event_type(&e), "background_job_updated");
        if let Event::BackgroundJobUpdated {
            job_id,
            state,
            kind,
            detail,
        } = e
        {
            assert_eq!(job_id, "j1");
            assert_eq!(state, "running");
            assert_eq!(kind, "execution");
            assert_eq!(detail.unwrap(), "step 2/5");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn subagent_spawned_maps_to_subagent_spawned() {
        let e = map_telemetry_to_event(&te_subagent_spawned()).unwrap();
        assert_eq!(event_type(&e), "subagent_spawned");
        if let Event::SubagentSpawned {
            task_id,
            child_chat_id,
            display_name,
            agent_name,
            background_job_id,
        } = e
        {
            assert_eq!(task_id, "t1");
            assert_eq!(child_chat_id, "c2");
            assert_eq!(display_name.as_deref(), Some("Research run #2"));
            assert_eq!(agent_name.as_deref(), Some("researcher"));
            assert_eq!(background_job_id, None);
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn subagent_events_route_by_parent_chat_id() {
        // The UI filters per session on the parent chat, so routing must
        // resolve to `parent_chat_id` ("c1"), not the child ("c2").
        assert_eq!(telemetry_chat_id(&te_subagent_spawned()), Some("c1"));
        assert_eq!(telemetry_chat_id(&te_subagent_finished()), Some("c1"));
    }

    #[test]
    fn subagent_finished_maps_to_subagent_finished() {
        let e = map_telemetry_to_event(&te_subagent_finished()).unwrap();
        assert_eq!(event_type(&e), "subagent_finished");
        if let Event::SubagentFinished {
            task_id,
            child_chat_id,
            status,
            agent_name,
        } = e
        {
            assert_eq!(task_id, "t1");
            assert_eq!(child_chat_id, "c2");
            assert_eq!(status, "completed");
            assert_eq!(agent_name.as_deref(), Some("researcher"));
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn cron_trigger_falls_through_to_none() {
        assert!(map_telemetry_to_event(&te_cron_trigger()).is_none());
    }

    #[test]
    fn notification_created_maps_for_tauri() {
        let event = map_telemetry_to_event(&te_notification_created()).unwrap();
        assert_eq!(event_type(&event), "notification_created");
        if let Event::NotificationCreated {
            notification_id,
            kind,
            title,
        } = event
        {
            assert_eq!(notification_id, "n1");
            assert_eq!(kind, "info");
            assert_eq!(title, "Job done");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn notification_updated_maps_for_tauri() {
        let event = map_telemetry_to_event(&te_notification_updated()).unwrap();
        assert_eq!(event_type(&event), "notification_updated");
        if let Event::NotificationUpdated {
            notification_id,
            state,
        } = event
        {
            assert_eq!(notification_id, "n1");
            assert_eq!(state, "seen");
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn notification_from_another_channel_is_not_forwarded() {
        let mut event = te_notification_created();
        if let isanagent::bus::TelemetryEvent::NotificationCreated { channel, .. } = &mut event {
            *channel = "slack".into();
        }
        assert!(map_telemetry_to_event(&event).is_none());
    }

    #[test]
    fn tool_call_without_id_generates_uuid() {
        let te = isanagent::bus::TelemetryEvent::ToolCall {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            tool_name: "read_file".into(),
            args: "{}".into(),
            tool_call_id: None,
            background_job_id: None,
        };
        let e = map_telemetry_to_event(&te).unwrap();
        if let Event::ToolCallStart { id, .. } = e {
            assert!(id.len() >= 32, "expected uuid-length id, got {:?}", id);
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn tool_result_without_id_falls_back_to_name() {
        let te = isanagent::bus::TelemetryEvent::ToolResult {
            chat_id: "c1".into(),
            channel: "tauri".into(),
            tool_name: "bash".into(),
            result: "ok".into(),
            is_error: false,
            tool_call_id: None,
            background_job_id: None,
        };
        let e = map_telemetry_to_event(&te).unwrap();
        if let Event::ToolCallEnd { id, .. } = e {
            assert_eq!(id, "bash");
        } else {
            panic!("wrong variant");
        }
    }

    /// Every mapped event type must serialise/deserialise with the
    /// `"type"` tag intact — the frontend discriminates on it.
    #[test]
    fn all_mapped_events_serialize_with_discriminant() {
        let events: Vec<Event> = vec![
            map_telemetry_to_event(&te_tool_call()).unwrap(),
            map_telemetry_to_event(&te_tool_result()).unwrap(),
            map_telemetry_to_event(&te_agent_thought()).unwrap(),
            map_telemetry_to_event(&te_agent_usage()).unwrap(),
            map_telemetry_to_event(&te_tool_progress()).unwrap(),
            map_telemetry_to_event(&te_execution_run_finished()).unwrap(),
            map_telemetry_to_event(&te_execution_job_finished()).unwrap(),
            map_telemetry_to_event(&te_background_job_updated()).unwrap(),
            map_telemetry_to_event(&te_subagent_spawned()).unwrap(),
            map_telemetry_to_event(&te_subagent_finished()).unwrap(),
        ];

        for e in &events {
            let json = serde_json::to_string(e).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            let tag = parsed["type"].as_str().unwrap();
            assert_eq!(tag, event_type(e));
            // Round-trip through the Value representation
            let e2: Event = serde_json::from_value(parsed).unwrap();
            let json2 = serde_json::to_string(&e2).unwrap();
            assert_eq!(json, json2);
        }
    }
}
