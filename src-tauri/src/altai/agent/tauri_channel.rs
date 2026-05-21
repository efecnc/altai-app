use async_trait::async_trait;
use isanagent::bus::{BusMessage, OutboundMessage};
use isanagent::channels::Channel;
use log::info;
use std::any::Any;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::Sender;
use tokio::sync::Mutex;

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
    pub async fn inject_user_message(&self, content: String) -> Result<(), String> {
        let guard = self.bus_tx.lock().await;
        let tx = guard.as_ref().ok_or("TauriChannel not started")?;
        let msg = isanagent::bus::InboundMessage {
            channel: self.name().to_string(),
            sender_id: "tauri_user".to_string(),
            chat_id: self.chat_id.clone(),
            thread_id: None,
            content,
            attachments: vec![],
            metadata: std::collections::HashMap::new(),
        };
        tx.send(BusMessage::Inbound(msg))
            .await
            .map_err(|e| format!("Failed to send to bus: {}", e))
    }

    /// Signal cancellation for the current chat.
    pub async fn cancel(&self) -> Result<(), String> {
        let guard = self.bus_tx.lock().await;
        let tx = guard.as_ref().ok_or("TauriChannel not started")?;
        tx.send(BusMessage::Cancel(self.chat_id.clone()))
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
pub fn map_telemetry_to_event(
    telemetry: &isanagent::bus::TelemetryEvent,
) -> Option<Event> {
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
            ..
        } => Some(Event::ToolCallEnd {
            id: tool_call_id
                .clone()
                .unwrap_or_else(|| tool_name.clone()),
            output: serde_json::Value::String(result.clone()),
            error: None,
        }),
        TelemetryEvent::AgentThought { thought, .. } => Some(Event::Thinking {
            content: thought.clone(),
        }),
        TelemetryEvent::ToolProgress {
            tool_name, message, ..
        } => Some(Event::Thinking {
            content: format!("[{}] {}", tool_name, message),
        }),
        _ => None,
    }
}
