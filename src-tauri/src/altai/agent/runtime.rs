use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::async_runtime;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use isanagent::agent::{AgentLogic, AgentLogicParams};
use isanagent::bus::BusMessage;
use isanagent::channels::Channel;
use isanagent::clarification::ClarificationHub;
use isanagent::config::ShellPolicyMode;
use isanagent::provider;
use isanagent::scheduler::{CronActor, CronCommand, CronSchedulingMode, CronStore, ScheduleKind};
use isanagent::session::SessionManager;
use isanagent::skills::SkillRegistry;
use isanagent::tools::builtin::{
    CronTool, EditFileTool, FetchMemoryByDateTool, GitWorktreeTool, GlobFilesTool, ListDirTool,
    ReadFileTool, SearchMemoryTool, SearchTextTool, ShellExecTool, WebFetchTool, WebSearchTool,
    WriteFileTool,
};
use isanagent::tools::ml_domain::{ArxivFetchTool, ArxivSearchTool, HfHubFileFetchTool};
use isanagent::tools::workflow::{AskUserTool, TodoWriteTool, ToolSearchTool};
use isanagent::tools::ToolRegistry;
use isanagent::workspace::{resolve_workspace_root, IsanagentWorkspace};
use isanagent::{NodeHandle, Supervisor, SupervisorPolicy};

use super::commands::DocumentArg;
use super::event_journal::{AppendStatus, EventJournal, JournalEvent};
use super::tauri_channel::{
    map_lifecycle_to_event, map_telemetry_to_event, telemetry_chat_id, TauriChannel,
};
use crate::modules::mcp;

/// Context-condensing (compaction) configuration received from the JS layer
/// (camelCase IPC) and threaded into the isanagent `AgentLogicParams`. The
/// `auto == false` case is encoded by forcing `threshold_tokens` to
/// `usize::MAX`, which keeps manual `/compact` working while disabling the
/// between-turns auto trigger.
///
/// Field names match the camelCase wire format (`#[serde(rename_all =
/// "camelCase")]` → `thresholdTokens`, `tailTurns`).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompactionArg {
    pub auto: bool,
    pub threshold_tokens: usize,
    pub tail_turns: usize,
}

impl CompactionArg {
    /// Resolve the user-facing compaction knobs into the three values
    /// `AgentLogicParams` actually consumes. `short_term_threshold_turns`
    /// is kept at the isanagent crate default (20) since the public API
    /// doesn't expose a per-call override for it.
    fn to_logic_params(&self) -> (usize, usize, usize) {
        // (max_recent_summaries, short_term_threshold_turns, short_term_threshold_tokens)
        let max_recent_summaries = self.tail_turns;
        let short_term_threshold_turns = 20;
        // Floor at 8k so a typo (e.g. 0) can't wedge the loop into compacting
        // every turn; when auto is off, MAX effectively disables the trigger.
        let short_term_threshold_tokens = if self.auto {
            self.threshold_tokens.max(8_000)
        } else {
            usize::MAX
        };
        (
            max_recent_summaries,
            short_term_threshold_turns,
            short_term_threshold_tokens,
        )
    }

    /// Compact tuple used in the runtime fingerprint so a compaction-pref
    /// change rebuilds the instance on next send.
    fn fingerprint_tuple(&self) -> (bool, usize, usize) {
        (self.auto, self.threshold_tokens, self.tail_turns)
    }
}
/// Structured file-edit diff attached to a clarification when the crate's edit
/// gate requests approval. Mirrors the `metadata.edit_diff` object the crate
/// attaches to the `ask_user` outbound (`builtin.rs` edit gate). The UI uses
/// this to render a diff-review card; the `before`/`after` are derived from
/// the crate's unified `diff` so the frontend doesn't need to re-read files.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditDiffPayload {
    /// Workspace-relative path of the file being mutated (e.g. `src/lib.rs`).
    pub file: String,
    /// Unified-diff preview of the proposed change.
    pub diff: String,
    /// Whether the diff was truncated to stay under the crate's display cap.
    pub truncated: bool,
}

/// Serializable agent event surface sent to the frontend.
/// Stabilize this enum — every change is a breaking downstream contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    RunStarted {
        run_id: String,
    },
    RunWarning {
        run_id: String,
        warning: serde_json::Value,
    },
    RunTerminated {
        run_id: String,
        outcome: serde_json::Value,
    },
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
        name: String,
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
    ///
    /// `edit_diff` is present when the clarification is actually a file-edit
    /// approval request (the crate's edit gate attaches a structured diff to
    /// the `ask_user` outbound metadata). The UI renders a richer diff-review
    /// card in that case instead of the plain choice chips; the reply path
    /// (`approve` / `deny` as a normal message) is identical.
    Clarification {
        content: String,
        choices: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        edit_diff: Option<EditDiffPayload>,
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
    /// A persisted notification was created for this Tauri conversation.
    NotificationCreated {
        notification_id: String,
        kind: String,
        title: String,
    },
    /// A persisted notification changed state.
    NotificationUpdated {
        notification_id: String,
        state: String,
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventEnvelope<'a> {
    version: u8,
    scope: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
    chat_id: &'a str,
    event: &'a Event,
}

#[derive(Debug)]
enum RunEventDeliveryError {
    Serialization,
    Transition(String),
    Persistence(String),
    Renderer(String),
}

impl std::fmt::Display for RunEventDeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Serialization => formatter.write_str("agent_event_serialization_failed"),
            Self::Transition(detail) => {
                write!(formatter, "agent_event_transition_rejected: {detail}")
            }
            Self::Persistence(detail) => {
                write!(formatter, "agent_event_persistence_failed: {detail}")
            }
            Self::Renderer(detail) => {
                write!(formatter, "agent_event_renderer_unavailable: {detail}")
            }
        }
    }
}

/// Owned replay form of the live `agent://event` envelope. Replayed records
/// intentionally preserve the same wire contract so the renderer can feed
/// them through the exact same reducer without starting any agent work.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentReplayEventEnvelope {
    pub version: u8,
    pub scope: String,
    pub run_id: String,
    pub seq: u64,
    pub chat_id: String,
    pub event: Event,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunReplayCursor {
    pub run_id: String,
    pub last_seq: u64,
    pub terminal_seq: Option<u64>,
}

pub(crate) type SharedRunCoordinator = Arc<StdMutex<RunCoordinator>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunPhase {
    Admitted,
    Running,
    WaitingUser,
    CancellingBeforeStart,
    CancellingRunning,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunAdmission {
    New,
    ExistingReply,
    Queued,
    Confirmed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RunTransitionError {
    ActiveLease,
    MissingLease,
    RunMismatch,
    OwnerMismatch,
    OwnerDraining,
    InvalidPhase,
}

#[derive(Clone, Default)]
pub(crate) struct RunCoordinator {
    active: HashMap<String, ActiveRun>,
    pending: HashMap<String, VecDeque<PendingRun>>,
    draining_owners: HashSet<String>,
}

#[derive(Clone)]
struct ActiveRun {
    run_id: String,
    owner_id: String,
    next_seq: u64,
    phase: RunPhase,
}

#[derive(Clone)]
struct PendingRun {
    run_id: String,
    owner_id: String,
}

impl RunCoordinator {
    fn admit(
        &mut self,
        chat_id: &str,
        run_id: &str,
        owner_id: &str,
    ) -> Result<(), RunTransitionError> {
        if self.draining_owners.contains(owner_id) {
            return Err(RunTransitionError::OwnerDraining);
        }
        if self.active.contains_key(chat_id) {
            return Err(RunTransitionError::ActiveLease);
        }
        self.active.insert(
            chat_id.to_string(),
            ActiveRun {
                run_id: run_id.to_string(),
                owner_id: owner_id.to_string(),
                next_seq: 1,
                phase: RunPhase::Admitted,
            },
        );
        Ok(())
    }

    fn admit_user_message(
        &mut self,
        chat_id: &str,
        run_id: &str,
        owner_id: &str,
    ) -> Result<RunAdmission, RunTransitionError> {
        if let Some(active) = self.active.get(chat_id) {
            if active.owner_id == owner_id && active.phase == RunPhase::WaitingUser {
                return Ok(RunAdmission::ExistingReply);
            }
            return Err(RunTransitionError::ActiveLease);
        }
        self.admit(chat_id, run_id, owner_id)?;
        Ok(RunAdmission::New)
    }

    fn admit_or_queue(
        &mut self,
        chat_id: &str,
        run_id: &str,
        owner_id: &str,
    ) -> Result<RunAdmission, RunTransitionError> {
        let Some(active) = self.active.get(chat_id) else {
            self.admit(chat_id, run_id, owner_id)?;
            return Ok(RunAdmission::New);
        };
        if active.owner_id != owner_id {
            return Err(RunTransitionError::OwnerMismatch);
        }
        if active.phase == RunPhase::WaitingUser {
            return Err(RunTransitionError::InvalidPhase);
        }
        if active.run_id == run_id
            && matches!(
                active.phase,
                RunPhase::Admitted | RunPhase::CancellingBeforeStart
            )
        {
            return Ok(RunAdmission::Confirmed);
        }
        let pending = self.pending.entry(chat_id.to_string()).or_default();
        if pending
            .iter()
            .any(|run| run.run_id == run_id && run.owner_id == owner_id)
        {
            return Ok(RunAdmission::Confirmed);
        }
        pending.push_back(PendingRun {
            run_id: run_id.to_string(),
            owner_id: owner_id.to_string(),
        });
        Ok(RunAdmission::Queued)
    }

    fn started(
        &mut self,
        chat_id: &str,
        run_id: &str,
        owner_id: &str,
    ) -> Result<(String, u64), RunTransitionError> {
        let active = self
            .active
            .get_mut(chat_id)
            .ok_or(RunTransitionError::MissingLease)?;
        if active.run_id != run_id {
            return Err(RunTransitionError::RunMismatch);
        }
        if active.owner_id != owner_id {
            return Err(RunTransitionError::OwnerMismatch);
        }
        active.phase = match active.phase {
            RunPhase::Admitted => RunPhase::Running,
            RunPhase::CancellingBeforeStart => RunPhase::CancellingRunning,
            RunPhase::Running | RunPhase::WaitingUser | RunPhase::CancellingRunning => {
                return Err(RunTransitionError::InvalidPhase);
            }
        };
        active.next_seq = 2;
        Ok((run_id.to_string(), 1))
    }

    fn next(&mut self, chat_id: &str, owner_id: &str) -> Result<(String, u64), RunTransitionError> {
        let active = self
            .active
            .get_mut(chat_id)
            .ok_or(RunTransitionError::MissingLease)?;
        if active.owner_id != owner_id {
            return Err(RunTransitionError::OwnerMismatch);
        }
        if !matches!(
            active.phase,
            RunPhase::Running | RunPhase::WaitingUser | RunPhase::CancellingRunning
        ) {
            return Err(RunTransitionError::InvalidPhase);
        }
        if active.phase == RunPhase::WaitingUser {
            active.phase = RunPhase::Running;
        }
        let seq = active.next_seq;
        active.next_seq = active.next_seq.saturating_add(1);
        Ok((active.run_id.clone(), seq))
    }

    fn next_for_run(
        &mut self,
        chat_id: &str,
        run_id: &str,
        owner_id: &str,
    ) -> Result<(String, u64), RunTransitionError> {
        let active = self
            .active
            .get(chat_id)
            .ok_or(RunTransitionError::MissingLease)?;
        if active.run_id != run_id {
            return Err(RunTransitionError::RunMismatch);
        }
        self.next(chat_id, owner_id)
    }

    fn cancel_requested(
        &mut self,
        chat_id: &str,
        expected_run_id: Option<&str>,
    ) -> Result<String, RunTransitionError> {
        let active = self
            .active
            .get_mut(chat_id)
            .ok_or(RunTransitionError::MissingLease)?;
        if expected_run_id.is_some_and(|run_id| run_id != active.run_id) {
            return Err(RunTransitionError::RunMismatch);
        }
        self.pending.remove(chat_id);
        active.phase = match active.phase {
            RunPhase::Admitted => RunPhase::CancellingBeforeStart,
            RunPhase::Running | RunPhase::WaitingUser => RunPhase::CancellingRunning,
            RunPhase::CancellingBeforeStart | RunPhase::CancellingRunning => {
                return Err(RunTransitionError::InvalidPhase);
            }
        };
        Ok(active.run_id.clone())
    }

    fn active_run(&self, chat_id: &str) -> Option<(&str, &str)> {
        self.active
            .get(chat_id)
            .map(|run| (run.run_id.as_str(), run.owner_id.as_str()))
    }

    fn accepts_steer(
        &self,
        chat_id: &str,
        run_id: &str,
        owner_id: &str,
    ) -> Result<(), RunTransitionError> {
        let active = self
            .active
            .get(chat_id)
            .ok_or(RunTransitionError::MissingLease)?;
        if active.run_id != run_id {
            return Err(RunTransitionError::RunMismatch);
        }
        if active.owner_id != owner_id {
            return Err(RunTransitionError::OwnerMismatch);
        }
        if active.phase != RunPhase::Running {
            return Err(RunTransitionError::InvalidPhase);
        }
        Ok(())
    }

    fn begin_draining(&mut self, owner_ids: &HashSet<String>) -> Result<(), RunTransitionError> {
        if self
            .active
            .values()
            .any(|run| owner_ids.contains(&run.owner_id))
        {
            return Err(RunTransitionError::ActiveLease);
        }
        self.draining_owners.extend(owner_ids.iter().cloned());
        Ok(())
    }

    fn end_draining(&mut self, owner_ids: &HashSet<String>) {
        self.draining_owners
            .retain(|owner_id| !owner_ids.contains(owner_id));
    }

    fn terminated(
        &mut self,
        chat_id: &str,
        run_id: &str,
        owner_id: &str,
    ) -> Result<(String, u64), RunTransitionError> {
        let active = self
            .active
            .get(chat_id)
            .ok_or(RunTransitionError::MissingLease)?;
        if active.run_id != run_id {
            return Err(RunTransitionError::RunMismatch);
        }
        if active.owner_id != owner_id {
            return Err(RunTransitionError::OwnerMismatch);
        }
        if !matches!(
            active.phase,
            RunPhase::Running | RunPhase::WaitingUser | RunPhase::CancellingRunning
        ) {
            return Err(RunTransitionError::InvalidPhase);
        }
        let seq = active.next_seq;
        self.active.remove(chat_id);
        self.promote_next(chat_id);
        Ok((run_id.to_string(), seq))
    }

    fn promote_next(&mut self, chat_id: &str) {
        let next = self.pending.get_mut(chat_id).and_then(VecDeque::pop_front);
        if self.pending.get(chat_id).is_some_and(VecDeque::is_empty) {
            self.pending.remove(chat_id);
        }
        if let Some(next) = next {
            self.active.insert(
                chat_id.to_string(),
                ActiveRun {
                    run_id: next.run_id,
                    owner_id: next.owner_id,
                    next_seq: 1,
                    phase: RunPhase::Admitted,
                },
            );
        }
    }

    fn mark_waiting_user(
        &mut self,
        chat_id: &str,
        owner_id: &str,
    ) -> Result<(), RunTransitionError> {
        let active = self
            .active
            .get_mut(chat_id)
            .ok_or(RunTransitionError::MissingLease)?;
        if active.owner_id != owner_id {
            return Err(RunTransitionError::OwnerMismatch);
        }
        if active.phase != RunPhase::Running {
            return Err(RunTransitionError::InvalidPhase);
        }
        active.phase = RunPhase::WaitingUser;
        Ok(())
    }

    fn rollback_admission(&mut self, chat_id: &str, run_id: &str, owner_id: &str) {
        let should_remove = self.active.get(chat_id).is_some_and(|active| {
            active.run_id == run_id
                && active.owner_id == owner_id
                && matches!(
                    active.phase,
                    RunPhase::Admitted | RunPhase::CancellingBeforeStart
                )
        });
        if should_remove {
            self.active.remove(chat_id);
            self.promote_next(chat_id);
            return;
        }
        if let Some(pending) = self.pending.get_mut(chat_id) {
            pending.retain(|run| run.run_id != run_id || run.owner_id != owner_id);
            if pending.is_empty() {
                self.pending.remove(chat_id);
            }
        }
    }
}

fn coordinator_guard(
    coordinator: &SharedRunCoordinator,
) -> std::sync::MutexGuard<'_, RunCoordinator> {
    coordinator
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn admit_run(
    coordinator: &SharedRunCoordinator,
    chat_id: &str,
    run_id: &str,
    owner_id: &str,
) -> Result<(), String> {
    coordinator_guard(coordinator)
        .admit(chat_id, run_id, owner_id)
        .map_err(|error| format!("Cannot start a second run for chat {chat_id}: {error:?}"))
}

pub(crate) fn admit_user_message(
    coordinator: &SharedRunCoordinator,
    chat_id: &str,
    run_id: &str,
    owner_id: &str,
) -> Result<String, String> {
    let mut coordinator = coordinator_guard(coordinator);
    let admission = coordinator
        .admit_user_message(chat_id, run_id, owner_id)
        .map_err(|error| format!("Cannot accept user input for chat {chat_id}: {error:?}"))?;
    match admission {
        RunAdmission::New => Ok(run_id.to_string()),
        RunAdmission::ExistingReply => coordinator
            .active_run(chat_id)
            .map(|(active_run_id, _)| active_run_id.to_string())
            .ok_or_else(|| format!("The active run for chat {chat_id} disappeared")),
        RunAdmission::Queued | RunAdmission::Confirmed => Err(format!(
            "Unexpected direct-message admission for chat {chat_id}: {admission:?}"
        )),
    }
}

fn queue_run(
    coordinator: &SharedRunCoordinator,
    chat_id: &str,
    run_id: &str,
    owner_id: &str,
) -> Result<RunAdmission, String> {
    coordinator_guard(coordinator)
        .admit_or_queue(chat_id, run_id, owner_id)
        .map_err(|error| format!("Cannot queue run for chat {chat_id}: {error:?}"))
}

pub(crate) fn admit_queued_user_message(
    coordinator: &SharedRunCoordinator,
    chat_id: &str,
    run_id: &str,
    owner_id: &str,
) -> Result<(String, bool), String> {
    match queue_run(coordinator, chat_id, run_id, owner_id)? {
        RunAdmission::New | RunAdmission::Confirmed => Ok((run_id.to_string(), false)),
        RunAdmission::Queued => Ok((run_id.to_string(), true)),
        RunAdmission::ExistingReply => Err(format!(
            "Unexpected queued-message admission for chat {chat_id}: ExistingReply"
        )),
    }
}

pub(crate) fn rollback_run_admission(
    coordinator: &SharedRunCoordinator,
    chat_id: &str,
    run_id: &str,
    owner_id: &str,
) {
    coordinator_guard(coordinator).rollback_admission(chat_id, run_id, owner_id);
}

fn emit_event(
    app: &AppHandle,
    chat_id: &str,
    event: &Event,
    run: Option<(String, u64)>,
) -> Result<(), RunEventDeliveryError> {
    let (run_id, seq) = match run.as_ref() {
        Some((run_id, seq)) => (Some(run_id.as_str()), Some(*seq)),
        None => (None, None),
    };
    app.emit(
        "agent://event",
        &AgentEventEnvelope {
            version: 1,
            scope: if run.is_some() { "run" } else { "system" },
            run_id,
            seq,
            chat_id,
            event,
        },
    )
    .map_err(|error| RunEventDeliveryError::Renderer(error.to_string()))
}

enum RunEventTransition<'a> {
    Started(&'a str),
    Next,
    NextForRun(&'a str),
    Terminated(&'a str),
}

fn persist_run_event(
    coordinator: &SharedRunCoordinator,
    journal: &EventJournal,
    chat_id: &str,
    owner_id: &str,
    event: &Event,
    transition: RunEventTransition<'_>,
) -> Result<(String, u64), RunEventDeliveryError> {
    let payload = serde_json::to_value(event).map_err(|_| RunEventDeliveryError::Serialization)?;
    let kind = payload
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or(RunEventDeliveryError::Serialization)?
        .to_string();

    // Sequence assignment and durable append are one coordinator transition.
    // SQLite I/O is intentionally performed while the coordinator is locked:
    // otherwise two producers could reserve the same next sequence or a later
    // event could overtake a failed append and leave a permanent journal gap.
    let mut coordinator = coordinator_guard(coordinator);
    let before = coordinator.clone();
    let run = match transition {
        RunEventTransition::Started(run_id) => coordinator.started(chat_id, run_id, owner_id),
        RunEventTransition::Next => coordinator.next(chat_id, owner_id),
        RunEventTransition::NextForRun(run_id) => {
            coordinator.next_for_run(chat_id, run_id, owner_id)
        }
        RunEventTransition::Terminated(run_id) => coordinator.terminated(chat_id, run_id, owner_id),
    }
    .map_err(|error| RunEventDeliveryError::Transition(format!("{error:?}")))?;

    let journal_event = JournalEvent::now(1, run.0.clone(), run.1, chat_id, kind, payload);
    let append = if matches!(transition, RunEventTransition::Terminated(_)) {
        journal.append_terminal(&journal_event)
    } else {
        journal.append(&journal_event)
    };
    match append {
        Ok(AppendStatus::Appended | AppendStatus::Duplicate) => Ok(run),
        Err(error) => {
            *coordinator = before;
            Err(RunEventDeliveryError::Persistence(error.to_string()))
        }
    }
}

pub(crate) fn deliver_next_run_event(
    app: &AppHandle,
    journal: &EventJournal,
    coordinator: &SharedRunCoordinator,
    chat_id: &str,
    owner_id: &str,
    event: &Event,
) -> Result<(), String> {
    let result = persist_and_deliver_run_event(
        coordinator,
        journal,
        chat_id,
        owner_id,
        event,
        RunEventTransition::Next,
        |run| emit_event(app, chat_id, event, Some(run.clone())),
    );
    match result {
        Ok(_) => Ok(()),
        // Persistence already advanced the durable sequence. A disconnected
        // renderer recovers it via replay, so surfacing delivery failure to
        // IsanAgent would only invite a duplicate semantic event.
        Err(error @ RunEventDeliveryError::Renderer(_)) => {
            log::warn!("Agent event for chat {chat_id} awaits replay: {error}");
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn persist_and_deliver_run_event<F>(
    coordinator: &SharedRunCoordinator,
    journal: &EventJournal,
    chat_id: &str,
    owner_id: &str,
    event: &Event,
    transition: RunEventTransition<'_>,
    deliver: F,
) -> Result<(String, u64), RunEventDeliveryError>
where
    F: FnOnce(&(String, u64)) -> Result<(), RunEventDeliveryError>,
{
    let run = persist_run_event(coordinator, journal, chat_id, owner_id, event, transition)?;
    deliver(&run)?;
    Ok(run)
}

fn is_system_event(event: &Event) -> bool {
    matches!(
        event,
        Event::BackgroundJobUpdated { .. }
            | Event::NotificationCreated { .. }
            | Event::NotificationUpdated { .. }
    )
}

/// Wall-clock epoch millis. Used to stamp MCP status transitions so the
/// Settings UI can hint at staleness (`updated 2m ago`). `SystemTime::now`
/// is good enough here — this is advisory metadata, not a monotonic clock.
fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse the crate's `metadata.edit_diff` object into the structured
/// [`EditDiffPayload`] the frontend renders. The crate attaches this to
/// `ask_user` outbounds from the edit gate (`builtin.rs`); the shape is
/// `{ file, diff, truncated }`. We validate defensively (model-produced
/// metadata is untrusted) and drop malformed values rather than failing the
/// whole clarification — the user can still approve/deny from the text prompt.
fn parse_edit_diff(value: &serde_json::Value) -> Option<EditDiffPayload> {
    let obj = value.as_object()?;
    let file = obj.get("file").and_then(|v| v.as_str())?.to_string();
    let diff = obj.get("diff").and_then(|v| v.as_str())?.to_string();
    let truncated = obj
        .get("truncated")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    Some(EditDiffPayload {
        file,
        diff,
        truncated,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct FallbackFingerprint {
    provider_name: String,
    model_name: String,
    base_url: String,
    secret_identity: String,
}

impl From<&isanagent::agent::FallbackProviderSpec> for FallbackFingerprint {
    fn from(spec: &isanagent::agent::FallbackProviderSpec) -> Self {
        Self {
            provider_name: spec.provider_name.clone(),
            model_name: spec.model_name.clone(),
            base_url: spec.base_url.trim_end_matches('/').to_string(),
            secret_identity: secret_identity(&spec.api_key),
        }
    }
}

fn secret_identity(secret: &str) -> String {
    if secret.is_empty() {
        return "none".to_string();
    }
    let digest = Sha256::digest(secret.as_bytes());
    format!("sha256:{}", &hex::encode(digest)[..16])
}

/// Identifies a particular `(provider, model, secret identity, base_url, persona, fallback)`
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
    /// Non-reversible stable identity; raw provider credentials never enter Hash/Debug state.
    secret_identity: String,
    base_url: String,
    fallback: Option<FallbackFingerprint>,
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
    /// Compaction config tuple `(auto, threshold_tokens, tail_turns)`. Baked
    /// into `AgentLogic` at construction (isanagent owns the live context),
    /// so a Settings change must rebuild the instance. `None` keeps the
    /// isanagent crate's built-in defaults (used by call sites that haven't
    /// been threaded yet).
    compaction: Option<(bool, usize, usize)>,
    /// The raw workspace MCP configuration. MCP tools are discovered while an
    /// instance is built, so this must participate in identity: saving a
    /// server in Settings makes the next chat turn build an instance with the
    /// new tools instead of silently reusing the old tool registry.
    mcp_config: String,
}

/// Map the ALTAI UI permission mode to an IsanAgent shell-policy mode for interactive sessions.
///
/// This maps only the **shell / code-execution** dimension. File edits are
/// gated separately via [`permission_mode_to_edit_mode`]; the two are
/// independent because "auto-edit" should auto-apply file changes while still
/// prompting for shell commands.
/// - `ask`, `auto-edit`, and `plan` → `Ask`: code-exec / destructive-shell still
///   require approval. `plan` keeps shell read-only-with-approval so the agent
///   can run `git status` / `ls` while planning but cannot silently mutate.
/// - `bypass` → `Allow`: no prompts (UI-gated behind an explicit Settings
///   toggle + warning).
/// - unknown / None → leaves the on-disk config default untouched (which defaults to `Ask`).
///
/// Fail-safe: any unrecognized value returns `None`, so it can never silently downgrade to
/// `Allow`.
fn permission_mode_to_shell_mode(mode: Option<&str>) -> Option<ShellPolicyMode> {
    match mode.map(str::trim) {
        Some("ask")
        | Some("ask_before_edit")
        | Some("ask-before-edit")
        | Some("auto-edit")
        | Some("auto_edit")
        | Some("auto")
        | Some("edit_automatically")
        | Some("plan") => Some(ShellPolicyMode::Ask),
        Some("bypass") | Some("bypass_permissions") => Some(ShellPolicyMode::Allow),
        _ => None,
    }
}

/// Map the UI permission mode to the **file-edit** policy mode.
///
/// This is independent from [`permission_mode_to_shell_mode`] because the two
/// surfaces have different risk profiles:
/// - `ask` → `Ask`: edits require an approval card with a diff preview.
/// - `auto-edit` → `Allow`: edits apply silently. Shell still requires approval
///   (see [`permission_mode_to_shell_mode`]) — "auto-edit" never auto-approves
///   shell. This is the Cursor-style default for users who trust file changes
///   but want to keep a human in the loop on commands.
/// - `plan` → `Deny`: no mutations at all. The crate's gate surfaces the
///   `plan mode active — finalize or apply the plan first` error to the model,
///   which keeps it read-only.
/// - `bypass` → `Allow`: no prompts (UI-gated behind an explicit Settings toggle).
/// - unknown / None → returns `None` so the on-disk config default is preserved
///   (which is `Ask`). Fail-safe: an unrecognized value can never silently
///   downgrade to `Allow`.
fn permission_mode_to_edit_mode(mode: Option<&str>) -> Option<ShellPolicyMode> {
    match mode.map(str::trim) {
        Some("ask") | Some("ask_before_edit") | Some("ask-before-edit") => {
            Some(ShellPolicyMode::Ask)
        }
        Some("auto-edit") | Some("auto_edit") | Some("auto") | Some("edit_automatically") => {
            Some(ShellPolicyMode::Allow)
        }
        Some("plan") => Some(ShellPolicyMode::Deny),
        Some("bypass") | Some("bypass_permissions") => Some(ShellPolicyMode::Allow),
        _ => None,
    }
}

/// One running IsanAgent instance — its own channel + agent node + bus routers.
struct Instance {
    channel: Arc<TauriChannel>,
    /// The instance-local bus. Workspace ingress routes only trusted synthetic
    /// inbound work through this sender after a chat has been explicitly bound
    /// by a successful user send.
    bus_tx: mpsc::Sender<BusMessage>,
    /// Fires the bus router's shutdown so its task exits and drops `agent_node`.
    /// Needed because `agent_node` holds `bus_tx` clones (execution-job manager,
    /// subagent harness), so `channel.stop()` alone can't make `bus_rx.recv()`
    /// return `None` — the task would otherwise leak on teardown.
    shutdown: tokio::sync::oneshot::Sender<()>,
    /// Retained so workspace teardown can wait for the task to release its
    /// agent node and `bus_tx` clones instead of merely fire-and-forget a
    /// shutdown signal.
    bus_router: async_runtime::JoinHandle<()>,
    /// The outbound router owns the event receiver. It must finish after the
    /// bus router drops the agent node and its outbound sender clones.
    outbound_router: async_runtime::JoinHandle<()>,
}

const INSTANCE_TASK_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

async fn stop_instance(instance: Instance) {
    let Instance {
        channel,
        shutdown,
        mut bus_router,
        mut outbound_router,
        ..
    } = instance;

    // Workspace switching marks this owner as draining and refuses teardown
    // while it owns a run, so no foreground task can be orphaned here.
    let _ = shutdown.send(());

    if tokio::time::timeout(INSTANCE_TASK_SHUTDOWN_TIMEOUT, &mut bus_router)
        .await
        .is_err()
    {
        bus_router.abort();
        let _ = bus_router.await;
    }
    if tokio::time::timeout(INSTANCE_TASK_SHUTDOWN_TIMEOUT, &mut outbound_router)
        .await
        .is_err()
    {
        outbound_router.abort();
        let _ = outbound_router.await;
    }
    let _ = channel.stop().await;
}

/// Services that must have exactly one owner for a workspace, independent of
/// how many provider/persona instances happen to serve that workspace.
///
/// Cron, reflection, a retained logger bridge, and the synthetic ingress
/// dispatcher join this record in the next A2 steps. Establishing the shared
/// memory actor and clarification hub first prevents model switches from
/// orphaning an in-flight `ask_user` wait.
struct WorkspaceServices {
    memory_node: NodeHandle<isanagent::memory::MemoryMessage>,
    event_journal: Arc<EventJournal>,
    clarification_hub: Arc<ClarificationHub>,
    logger: WorkspaceLogger,
    dispatcher: Arc<WorkspaceDispatcher>,
    cron: WorkspaceCron,
}

struct WorkspaceIngress {
    chat_id: String,
    inbound: isanagent::bus::InboundMessage,
    reply: tokio::sync::oneshot::Sender<Result<(), String>>,
}

/// A workspace-owned synthetic-inbound dispatcher. It never accepts a model
/// selected destination: a chat must first be bound by `route_send`, and each
/// route is replaced only after another successful send for that same chat.
struct WorkspaceDispatcher {
    #[allow(dead_code)] // consumed by cron/background adapters added after I4/I5
    tx: mpsc::Sender<WorkspaceIngress>,
    routes: Arc<tokio::sync::Mutex<HashMap<String, WorkspaceRoute>>>,
    #[allow(dead_code)]
    task: async_runtime::JoinHandle<()>,
}

#[derive(Clone)]
struct WorkspaceRoute {
    bus_tx: mpsc::Sender<BusMessage>,
    owner_id: String,
}

impl WorkspaceDispatcher {
    fn new(run_coordinator: SharedRunCoordinator) -> Self {
        let routes = Arc::new(tokio::sync::Mutex::new(
            HashMap::<String, WorkspaceRoute>::new(),
        ));
        let (tx, mut rx) = mpsc::channel::<WorkspaceIngress>(100);
        let routes_for_task = routes.clone();
        let coordinator_for_task = run_coordinator.clone();
        let task = async_runtime::spawn(async move {
            while let Some(ingress) = rx.recv().await {
                let route = routes_for_task.lock().await.get(&ingress.chat_id).cloned();
                let result = match route {
                    Some(route) => {
                        let run_id = inbound_run_id(&ingress.inbound).map(str::to_string);
                        match run_id {
                            Some(run_id) => match if is_queueable_synthetic(&ingress.inbound) {
                                queue_run(
                                    &coordinator_for_task,
                                    &ingress.chat_id,
                                    &run_id,
                                    &route.owner_id,
                                )
                                .map(|_| ())
                            } else if is_clarification_reply(&ingress.inbound) {
                                admit_user_message(
                                    &coordinator_for_task,
                                    &ingress.chat_id,
                                    &run_id,
                                    &route.owner_id,
                                )
                                .map(|_| ())
                            } else {
                                admit_run(
                                    &coordinator_for_task,
                                    &ingress.chat_id,
                                    &run_id,
                                    &route.owner_id,
                                )
                            } {
                                Ok(()) => {
                                    let result = route
                                        .bus_tx
                                        .send(BusMessage::Inbound(ingress.inbound))
                                        .await
                                        .map_err(|_| {
                                            "The owning agent runtime is no longer available"
                                                .to_string()
                                        });
                                    if result.is_err() {
                                        rollback_run_admission(
                                            &coordinator_for_task,
                                            &ingress.chat_id,
                                            &run_id,
                                            &route.owner_id,
                                        );
                                    }
                                    result
                                }
                                Err(error) => Err(error),
                            },
                            None => Err("Trusted inbound is missing its run ID".to_string()),
                        }
                    }
                    None => Err("No owning agent runtime is registered for this chat".to_string()),
                };
                let _ = ingress.reply.send(result);
            }
        });
        Self { tx, routes, task }
    }

    async fn bind(&self, chat_id: &str, bus_tx: mpsc::Sender<BusMessage>, owner_id: &str) {
        self.routes.lock().await.insert(
            chat_id.to_string(),
            WorkspaceRoute {
                bus_tx,
                owner_id: owner_id.to_string(),
            },
        );
    }

    #[allow(dead_code)] // exercised in tests; production callers arrive with cron/resume adapters
    async fn dispatch(
        &self,
        chat_id: String,
        inbound: isanagent::bus::InboundMessage,
    ) -> Result<(), String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(WorkspaceIngress {
                chat_id,
                inbound,
                reply: tx,
            })
            .await
            .map_err(|_| "The workspace ingress dispatcher is no longer available".to_string())?;
        rx.await
            .map_err(|_| "The workspace ingress dispatcher stopped before routing".to_string())?
    }
}

/// Retains both ends of IsanAgent's blocking logger channel. The prior
/// embedded runtime kept only the sender, so every log event was immediately
/// dropped because its receiver had been destroyed.
struct WorkspaceLogger {
    handle: isanagent::logging::LoggerHandle,
    #[allow(dead_code)]
    node: NodeHandle<BusMessage>,
    #[allow(dead_code)]
    forwarder: StdMutex<Option<std::thread::JoinHandle<()>>>,
}

/// One local IsanAgent cron actor per workspace. Its bus is deliberately not
/// connected to an arbitrary model instance: a tiny bridge validates the
/// persisted Tauri root identity then uses the workspace dispatcher.
struct WorkspaceCron {
    node: NodeHandle<String>,
    #[allow(dead_code)]
    forwarder: async_runtime::JoinHandle<()>,
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
    /// One service record per workspace root. Provider/persona instances share
    /// this record instead of reconstructing workspace-owned state.
    workspace_services_by_root: tokio::sync::Mutex<HashMap<String, Arc<WorkspaceServices>>>,
    /// Last successfully delivered model/persona runtime for each workspace
    /// chat. This is only an ownership record today; A2's dispatcher will use
    /// it to route synthetic work and ticket resumes to exactly one instance.
    chat_owner_by_workspace: tokio::sync::Mutex<HashMap<(String, String), RuntimeFingerprint>>,
    run_coordinator: SharedRunCoordinator,
}

pub fn init(app: AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(AgentRuntime {
        app: app.clone(),
        instances: tokio::sync::Mutex::new(HashMap::new()),
        workspace_services_by_root: tokio::sync::Mutex::new(HashMap::new()),
        chat_owner_by_workspace: tokio::sync::Mutex::new(HashMap::new()),
        run_coordinator: Arc::new(StdMutex::new(RunCoordinator::default())),
    });

    Ok(())
}

/// Build the config fingerprint + its resolved workspace root.
#[allow(clippy::too_many_arguments)]
fn make_fingerprint(
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_path: Option<&str>,
    permission_mode: Option<&str>,
    compaction: Option<&CompactionArg>,
    fallback: Option<&isanagent::agent::FallbackProviderSpec>,
) -> RuntimeFingerprint {
    let workspace_root = workspace_path
        .map(|p| format!("{}/.isanagent", p.trim_end_matches('/')))
        .unwrap_or_default();
    let mcp_config = {
        let root = if workspace_root.is_empty() {
            resolve_workspace_root(None)
        } else {
            std::path::PathBuf::from(&workspace_root)
        };
        std::fs::read_to_string(root.join("mcp.json")).unwrap_or_default()
    };
    RuntimeFingerprint {
        provider_name: provider_name.to_string(),
        model_name: model_name.to_string(),
        secret_identity: secret_identity(api_key),
        base_url: base_url_override.unwrap_or("").to_string(),
        fallback: fallback.map(FallbackFingerprint::from),
        persona: persona_instructions.unwrap_or("").to_string(),
        workspace_root,
        permission_mode: permission_mode.unwrap_or("").to_string(),
        compaction: compaction.map(|c| c.fingerprint_tuple()),
        mcp_config,
    }
}

/// Get-or-create workspace-owned services (`""` = the default IsanAgent
/// workspace). This is intentionally the only constructor for shared
/// workspace state.
async fn ensure_workspace_services(
    runtime: &AgentRuntime,
    workspace_root: &str,
) -> Result<Arc<WorkspaceServices>, String> {
    let mut guard = runtime.workspace_services_by_root.lock().await;
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
    let event_journal =
        EventJournal::open(dir.join(".system_generated").join("agent_event_journal.db"))
            .map_err(|error| format!("Failed to initialize agent event journal: {error}"))?;
    classify_runs_abandoned_by_restart(&event_journal)?;
    let event_journal = Arc::new(event_journal);
    let memory_actor = isanagent::memory::SqliteMemoryActor::new(db_path_str)
        .map_err(|e| format!("Failed to initialize SqliteMemoryActor: {}", e))?;
    let node = NodeHandle::<isanagent::memory::MemoryMessage>::new(
        memory_actor,
        100,
        1,
        Duration::from_millis(5),
    );
    let (logger_handle, logger_rx) =
        isanagent::logging::create_logger_channel(isanagent::logging::LOGGER_QUEUE_CAPACITY);
    let logger_factory = {
        let workspace_dir = dir.clone();
        move || isanagent::logging::create_logging_actor_or_fallback(workspace_dir.clone())
    };
    let logger_node = NodeHandle::<BusMessage>::new(
        Supervisor::new(SupervisorPolicy::Restart, logger_factory),
        1_000,
        1,
        Duration::from_millis(10),
    );
    let logger_forward = logger_node.clone();
    let runtime_handle = tokio::runtime::Handle::current();
    let forwarder = std::thread::Builder::new()
        .name("altai-isanagent-logger".to_string())
        .spawn(move || {
            while let Ok(message) = logger_rx.recv() {
                if runtime_handle
                    .block_on(logger_forward.send_packet(message))
                    .is_err()
                {
                    break;
                }
            }
        })
        .map_err(|error| format!("Failed to start workspace logger forwarder: {error}"))?;

    let dispatcher = Arc::new(WorkspaceDispatcher::new(runtime.run_coordinator.clone()));
    let (cron_bus_tx, mut cron_bus_rx) = mpsc::channel::<BusMessage>(100);
    let cron_logic = CronActor::new(
        "AltaiWorkspaceCron",
        db_path_str,
        logger_handle.clone(),
        CronSchedulingMode::Local,
        cron_bus_tx,
    )
    .map_err(|error| format!("Failed to initialize workspace cron actor: {error}"))?;
    let cron_node = NodeHandle::new(cron_logic, 100, 1, Duration::from_millis(50));
    let dispatcher_for_cron = dispatcher.clone();
    let cron_forwarder = async_runtime::spawn(async move {
        while let Some(message) = cron_bus_rx.recv().await {
            let BusMessage::Inbound(inbound) = message else {
                continue;
            };
            let chat_id = inbound.chat_id.clone();
            if inbound.channel != "tauri"
                || inbound.thread_id.is_some()
                || validate_tauri_chat_id(&chat_id).is_err()
            {
                log::warn!("Dropped cron delivery with an invalid ALTAI destination");
                continue;
            }
            // A missing owner is expected after app restart. CronActor has
            // already persisted its running job, and `route_send` performs a
            // one-shot recovery when the user next reopens that conversation.
            if let Err(error) = dispatcher_for_cron
                .dispatch(chat_id, trusted_tauri_inbound(inbound))
                .await
            {
                log::info!("Deferred cron delivery until its ALTAI chat is active: {error}");
            }
        }
    });

    let services = Arc::new(WorkspaceServices {
        memory_node: node,
        event_journal,
        clarification_hub: ClarificationHub::shared(),
        logger: WorkspaceLogger {
            handle: logger_handle,
            node: logger_node,
            forwarder: StdMutex::new(Some(forwarder)),
        },
        dispatcher,
        cron: WorkspaceCron {
            node: cron_node,
            forwarder: cron_forwarder,
        },
    });
    guard.insert(workspace_root.to_string(), services.clone());
    Ok(services)
}

/// Compatibility helper for history/inbox calls while they are migrated to
/// consume the full workspace service record.
async fn ensure_memory(
    runtime: &AgentRuntime,
    workspace_root: &str,
) -> Result<NodeHandle<isanagent::memory::MemoryMessage>, String> {
    Ok(ensure_workspace_services(runtime, workspace_root)
        .await?
        .memory_node
        .clone())
}

/// Read durable events strictly after the renderer's last acknowledged
/// sequence. This path only opens the workspace journal; it never constructs
/// an agent instance, dispatches inbound work, or touches provider/tool code.
pub async fn replay_run_events(
    runtime: &AgentRuntime,
    workspace_path: &str,
    chat_id: &str,
    run_id: &str,
    after_seq: u64,
    limit: usize,
) -> Result<Vec<AgentReplayEventEnvelope>, String> {
    let chat_id = validate_tauri_chat_id(chat_id)?;
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return Err("runId is required".to_string());
    }
    if run_id.len() > 256 {
        return Err("runId is too long".to_string());
    }
    if limit == 0 || limit > 1_000 {
        return Err("limit must be between 1 and 1000".to_string());
    }

    let workspace_root = format!("{}/.isanagent", workspace_path.trim_end_matches('/'));
    let services = ensure_workspace_services(runtime, &workspace_root).await?;
    replay_events_from_journal(&services.event_journal, chat_id, run_id, after_seq, limit)
}

/// Discover the newest durable run for a restored chat without replaying or
/// starting work. On a fresh host process, startup classification first makes
/// every run inherited from the previous process terminal; a run started by
/// the current process may still be live during a renderer-only reconnect.
pub async fn latest_run_replay_cursor(
    runtime: &AgentRuntime,
    workspace_path: &str,
    chat_id: &str,
) -> Result<Option<AgentRunReplayCursor>, String> {
    let chat_id = validate_tauri_chat_id(chat_id)?;
    let workspace_root = format!("{}/.isanagent", workspace_path.trim_end_matches('/'));
    let services = ensure_workspace_services(runtime, &workspace_root).await?;
    services
        .event_journal
        .latest_run_summary_for_chat(chat_id)
        .map(|summary| {
            summary.map(|summary| AgentRunReplayCursor {
                run_id: summary.run_id,
                last_seq: summary.last_seq,
                terminal_seq: summary.terminal_seq,
            })
        })
        .map_err(|error| format!("Failed to inspect agent event journal: {error}"))
}

fn classify_runs_abandoned_by_restart(journal: &EventJournal) -> Result<(), String> {
    for summary in journal
        .incomplete_run_summaries()
        .map_err(|error| format!("Failed to inspect incomplete agent runs: {error}"))?
    {
        let seq = summary
            .last_seq
            .checked_add(1)
            .ok_or_else(|| "Cannot classify an agent run with an exhausted sequence".to_string())?;
        let event = Event::RunTerminated {
            run_id: summary.run_id.clone(),
            outcome: serde_json::json!({
                "kind": "failed",
                "failure": "The previous app process ended before this run completed.",
                "retryable": false
            }),
        };
        let payload = serde_json::to_value(&event)
            .map_err(|_| "Failed to serialize restart recovery event".to_string())?;
        let terminal = JournalEvent::now(
            1,
            summary.run_id.clone(),
            seq,
            summary.chat_id,
            "run_terminated",
            payload,
        );
        if let Err(error) = journal.append_terminal(&terminal) {
            // Another host may have won the terminal CAS. Accept only a
            // verified terminal summary; all other failures abort startup.
            let committed = journal
                .run_summary(&summary.run_id)
                .map_err(|inspect| format!("Failed to verify recovered run: {inspect}"))?
                .is_some_and(|current| current.terminal_seq.is_some());
            if !committed {
                return Err(format!("Failed to classify abandoned agent run: {error}"));
            }
        }
    }
    Ok(())
}

fn replay_events_from_journal(
    journal: &EventJournal,
    chat_id: &str,
    run_id: &str,
    after_seq: u64,
    limit: usize,
) -> Result<Vec<AgentReplayEventEnvelope>, String> {
    let summary = journal
        .run_summary(run_id)
        .map_err(|error| format!("Failed to inspect agent event journal: {error}"))?
        .filter(|summary| summary.chat_id == chat_id)
        .ok_or_else(|| "Run was not found for this chat".to_string())?;
    if summary.run_id != run_id {
        return Err("Journal returned an invalid run identity".to_string());
    }

    journal
        .fetch_after(run_id, after_seq, limit)
        .map_err(|error| format!("Failed to replay agent events: {error}"))?
        .into_iter()
        .map(|record| {
            if record.version != 1
                || record.run_id != run_id
                || record.chat_id != chat_id
                || record.seq <= after_seq
            {
                return Err("Journal returned an invalid event envelope".to_string());
            }
            let payload_kind = record
                .payload
                .get("type")
                .and_then(serde_json::Value::as_str);
            if payload_kind != Some(record.kind.as_str()) {
                return Err("Journal event type does not match its payload".to_string());
            }
            let event = serde_json::from_value(record.payload)
                .map_err(|error| format!("Journal contains an invalid agent event: {error}"))?;
            Ok(AgentReplayEventEnvelope {
                version: 1,
                scope: "run".to_string(),
                run_id: record.run_id,
                seq: record.seq,
                chat_id: record.chat_id,
                event,
            })
        })
        .collect()
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
    compaction: Option<&CompactionArg>,
    fallback: Option<&isanagent::agent::FallbackProviderSpec>,
) -> Result<Arc<TauriChannel>, String> {
    let fp = make_fingerprint(
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
        permission_mode,
        compaction,
        fallback,
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

    // Atomically prevent new admission to instances that are about to be
    // removed. If one still owns a run, preserve it and reject the workspace
    // switch instead of orphaning its terminal event and coordinator lease.
    let stale_owner_ids: HashSet<String> = {
        let instances = runtime.instances.lock().await;
        instances
            .iter()
            .filter(|(key, _)| key.workspace_root != workspace_root)
            .map(|(_, instance)| instance.channel.owner_id().to_string())
            .collect()
    };
    coordinator_guard(&runtime.run_coordinator)
        .begin_draining(&stale_owner_ids)
        .map_err(|_| "Stop active agent runs before switching workspaces".to_string())?;

    // Tear down idle instances of other workspaces (the UI uses one at a time).
    // Remove them under the lock, but defer the async teardown until the lock
    // is released. Firing `shutdown` stops the bus-router task (so `agent_node`
    // drops and the `bus_tx` cycle unwinds); `stop()` then closes the channel.
    // We keep the fingerprint alongside each stale instance so the MCP status
    // registry (keyed by workspace) can be cleared for exactly those roots.
    let stale: Vec<(RuntimeFingerprint, Instance)> = {
        let mut instances = runtime.instances.lock().await;
        let keys: Vec<RuntimeFingerprint> = instances
            .keys()
            .filter(|k| k.workspace_root != workspace_root)
            .cloned()
            .collect();
        keys.into_iter()
            .filter_map(|k| instances.remove(&k).map(|inst| (k, inst)))
            .collect()
    };
    // Clear MCP runtime status for the workspaces we're tearing down so a
    // stale "connected" badge doesn't survive a workspace switch.
    let stale_workspace_roots: Vec<String> = stale
        .iter()
        .map(|(fp, _)| fp.workspace_root.clone())
        .collect();
    for (_, inst) in stale {
        stop_instance(inst).await;
    }
    coordinator_guard(&runtime.run_coordinator).end_draining(&stale_owner_ids);
    // Drop workspace services only after their agent instances have released
    // cloned memory/logger handles. This closes the logger receiver cleanly
    // and lets its forwarding thread observe shutdown instead of detaching it
    // while an old instance is still emitting.
    runtime
        .workspace_services_by_root
        .lock()
        .await
        .retain(|k, _| k == &workspace_root);
    runtime
        .chat_owner_by_workspace
        .lock()
        .await
        .retain(|(root, _), _| root == &workspace_root);
    if let Some(mcp_statuses) = runtime.app.try_state::<mcp::McpStatusRegistry>() {
        for root in &stale_workspace_roots {
            if !root.is_empty() {
                mcp_statuses
                    .clear_workspace(std::path::Path::new(root))
                    .await;
            }
        }
    }

    // Build the (heavy) instance WITHOUT holding the instances lock.
    let services = ensure_workspace_services(runtime, &workspace_root).await?;
    let workspace_root_opt = if workspace_root.is_empty() {
        None
    } else {
        Some(workspace_root.as_str())
    };
    let (channel, bus_tx, shutdown, bus_router, outbound_router) = build_instance(
        runtime.app.clone(),
        services.memory_node.clone(),
        services.clarification_hub.clone(),
        services.logger.handle.clone(),
        services.cron.node.clone(),
        services.event_journal.clone(),
        runtime.run_coordinator.clone(),
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_root_opt,
        permission_mode,
        compaction,
        fallback,
    )
    .await?;

    // Re-acquire to insert. If a concurrent call built the same config while we
    // were building, keep theirs and tear down our now-duplicate instance.
    let mut instances = runtime.instances.lock().await;
    if let Some(inst) = instances.get(&fp) {
        let winner = inst.channel.clone();
        drop(instances);
        stop_instance(Instance {
            channel,
            bus_tx,
            shutdown,
            bus_router,
            outbound_router,
        })
        .await;
        return Ok(winner);
    }
    instances.insert(
        fp,
        Instance {
            channel: channel.clone(),
            bus_tx,
            shutdown,
            bus_router,
            outbound_router,
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
    compaction: Option<&CompactionArg>,
    fallback: Option<isanagent::agent::FallbackProviderSpec>,
    message: String,
    images: Vec<String>,
    documents: Vec<DocumentArg>,
    chat_id: String,
    queue: bool,
) -> Result<SendAck, String> {
    let fingerprint = make_fingerprint(
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
        permission_mode,
        compaction,
        fallback.as_ref(),
    );
    let channel = ensure_instance(
        runtime,
        provider_name,
        api_key,
        model_name,
        persona_instructions,
        base_url_override,
        workspace_path,
        permission_mode,
        compaction,
        fallback.as_ref(),
    )
    .await?;

    let acknowledgement = channel
        .inject_user_message(message, images, documents, chat_id.clone(), queue)
        .await?;
    if !chat_id.trim().is_empty() {
        let bus_tx = runtime
            .instances
            .lock()
            .await
            .get(&fingerprint)
            .map(|instance| instance.bus_tx.clone())
            .ok_or_else(|| "The owning agent runtime is no longer available".to_string())?;
        let services = ensure_workspace_services(runtime, &fingerprint.workspace_root).await?;
        services
            .dispatcher
            .bind(&chat_id, bus_tx, channel.owner_id())
            .await;
        let previous_owner = runtime.chat_owner_by_workspace.lock().await.insert(
            (fingerprint.workspace_root.clone(), chat_id.clone()),
            fingerprint,
        );
        // A workspace service is recreated after an app/workspace restart, so
        // the first explicit user send is the first moment we have a trusted
        // provider configuration and a concrete runtime to own persisted cron
        // work. Recover once here; changing models later in the same process
        // must not duplicate an already-running background turn.
        if previous_owner.is_none() {
            if let Err(error) = recover_background_jobs_after_owner_bind(
                &services.memory_node,
                &services.dispatcher,
                &chat_id,
            )
            .await
            {
                // The foreground message is already accepted. Recovery is a
                // best-effort side effect and must not turn that accepted send
                // into an IPC rejection that invites a duplicate retry.
                log::warn!(
                    "Could not recover persisted background work for chat {chat_id}: {error}"
                );
            }
        }
    }
    Ok(acknowledgement)
}

async fn recover_background_jobs_after_owner_bind(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    dispatcher: &WorkspaceDispatcher,
    chat_id: &str,
) -> Result<(), String> {
    let records = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ListBackgroundJobs {
            chat_id: Some(chat_id.to_string()),
            channel: Some("tauri".to_string()),
            limit: 500,
            reply,
        }
    })
    .await?;
    for job in records.into_iter().filter(|job| {
        job.state == "running"
            && job.resume_after_restart
            && is_tauri_root_identity(
                &job.channel,
                job.thread_id.as_deref(),
                Some(chat_id),
                &job.chat_id,
            )
    }) {
        let content = serde_json::from_str::<serde_json::Value>(&job.payload_json)
            .ok()
            .and_then(|payload| {
                payload
                    .get("message")
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("Resume background job {}", job.job_id));
        let mut metadata = HashMap::new();
        metadata.insert(
            isanagent::bus::METADATA_SYNTHETIC_BACKGROUND_RESUME.to_string(),
            serde_json::Value::Bool(true),
        );
        metadata.insert(
            isanagent::bus::METADATA_BACKGROUND_JOB_ID.to_string(),
            serde_json::Value::String(job.job_id),
        );
        dispatcher
            .dispatch(
                chat_id.to_string(),
                trusted_tauri_inbound(isanagent::bus::InboundMessage {
                    channel: "tauri".to_string(),
                    sender_id: "altai_background_recovery".to_string(),
                    chat_id: chat_id.to_string(),
                    thread_id: None,
                    content,
                    attachments: Vec::new(),
                    metadata,
                }),
            )
            .await?;
    }
    Ok(())
}

/// Route a trusted synthetic inbound message to the runtime that most recently
/// served this ALTAI chat in the selected workspace. This is intentionally not
/// exposed as generic renderer IPC: cron and background-resume adapters call
/// it after deriving the destination from persisted host-owned state.
#[allow(dead_code)] // intentionally backend-only until cron/resume adapters are enabled
pub async fn dispatch_synthetic_inbound(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    inbound: isanagent::bus::InboundMessage,
) -> Result<(), String> {
    let chat_id = validate_tauri_chat_id(chat_id)?;
    if inbound.channel != "tauri" || inbound.chat_id != chat_id || inbound.thread_id.is_some() {
        return Err("Synthetic inbound identity does not match the Tauri root chat".to_string());
    }
    let workspace_root = workspace_path
        .map(|path| format!("{}/.isanagent", path.trim_end_matches('/')))
        .unwrap_or_default();
    ensure_workspace_services(runtime, &workspace_root)
        .await?
        .dispatcher
        .dispatch(chat_id.to_string(), trusted_tauri_inbound(inbound))
        .await
}

/// Trusted Rust-side producers, unlike renderer IPC, own run-id generation.
/// Every synthetic Tauri turn receives a fresh ID before IsanAgent admission.
fn trusted_tauri_inbound(
    mut inbound: isanagent::bus::InboundMessage,
) -> isanagent::bus::InboundMessage {
    debug_assert_eq!(inbound.channel, "tauri");
    inbound.metadata.insert(
        isanagent::bus::METADATA_RUN_ID.to_string(),
        serde_json::Value::String(uuid::Uuid::new_v4().to_string()),
    );
    inbound
}

fn inbound_run_id(inbound: &isanagent::bus::InboundMessage) -> Option<&str> {
    inbound
        .metadata
        .get(isanagent::bus::METADATA_RUN_ID)
        .and_then(serde_json::Value::as_str)
        .filter(|run_id| !run_id.trim().is_empty())
}

fn is_queueable_synthetic(inbound: &isanagent::bus::InboundMessage) -> bool {
    inbound
        .metadata
        .get(isanagent::bus::METADATA_SYNTHETIC_BACKGROUND_RESUME)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        && !inbound
            .metadata
            .contains_key(isanagent::bus::METADATA_CLARIFICATION_TICKET_ID)
}

fn is_clarification_reply(inbound: &isanagent::bus::InboundMessage) -> bool {
    inbound
        .metadata
        .contains_key(isanagent::bus::METADATA_CLARIFICATION_TICKET_ID)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendAck {
    pub chat_id: String,
    pub run_id: String,
    pub queued: bool,
}

/// Cancel the single runtime instance holding this chat's coordinator lease.
/// The owning bus router records the cancelling transition in the same FIFO
/// order in which IsanAgent observes inbound/cancel messages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAck {
    pub chat_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerAck {
    pub chat_id: String,
    pub run_id: String,
}

pub async fn route_cancel(
    runtime: &AgentRuntime,
    chat_id: String,
    run_id: String,
) -> Result<CancelAck, String> {
    let (active_run_id, owner_id) = coordinator_guard(&runtime.run_coordinator)
        .active_run(&chat_id)
        .map(|(active_run_id, owner_id)| (active_run_id.to_string(), owner_id.to_string()))
        .ok_or_else(|| "No active agent run exists for this chat".to_string())?;
    if active_run_id != run_id {
        return Err("The requested agent run is no longer active".to_string());
    }
    let channel = {
        let instances = runtime.instances.lock().await;
        instances
            .values()
            .find(|instance| instance.channel.owner_id() == owner_id)
            .map(|instance| instance.channel.clone())
    };
    let channel = channel.ok_or_else(|| "The owning agent runtime is unavailable".to_string())?;
    channel.cancel_run(chat_id.clone(), run_id.clone()).await?;
    Ok(CancelAck { chat_id, run_id })
}

/// Route new user direction to the runtime instance that owns one exact,
/// currently-running lease. Enqueueing on that instance's FIFO is the backend
/// acceptance boundary exposed to Tauri; IsanAgent applies it at its next safe
/// provider/tool boundary.
pub async fn route_steer(
    runtime: &AgentRuntime,
    chat_id: String,
    run_id: String,
    content: String,
) -> Result<SteerAck, String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("Steering instructions cannot be empty".to_string());
    }
    let owner_id = {
        let coordinator = coordinator_guard(&runtime.run_coordinator);
        let (_, owner_id) = coordinator
            .active_run(&chat_id)
            .ok_or_else(|| "No active agent run exists for this chat".to_string())?;
        coordinator
            .accepts_steer(&chat_id, &run_id, owner_id)
            .map_err(|error| match error {
                RunTransitionError::RunMismatch => {
                    "The requested agent run is no longer active".to_string()
                }
                RunTransitionError::InvalidPhase => {
                    "The active agent run cannot be steered in its current state".to_string()
                }
                _ => "The active agent run is unavailable".to_string(),
            })?;
        owner_id.to_string()
    };
    let channel = {
        let instances = runtime.instances.lock().await;
        instances
            .values()
            .find(|instance| instance.channel.owner_id() == owner_id)
            .map(|instance| instance.channel.clone())
    };
    let channel = channel.ok_or_else(|| "The owning agent runtime is unavailable".to_string())?;
    channel
        .steer_run(chat_id.clone(), run_id.clone(), content)
        .await?;
    Ok(SteerAck { chat_id, run_id })
}

/// One chat session as known to the backend memory DB (the source of truth for
/// what conversations have actually happened in this workspace). Returned to
/// the frontend so it can reconcile its own `altai-ai-sessions.json` list and
/// surface chats that were closed (dropped from the frontend store) but still
/// live in the agent memory.
///
/// Mirrors `RootThreadListItem` from the isanagent crate, flattened to JSON-
/// friendly camelCase via `#[serde(rename_all = "camelCase")]`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Bare chat id, e.g. `s-mrqa417u-hb75wq` (the `tauri:` channel prefix and
    /// trailing colon are stripped from the stored `messages.thread_id`).
    pub id: String,
    /// Latest activity timestamp, epoch milliseconds (UTC). `0` if unknown.
    pub updated_at: i64,
    /// First user message preview (runtime prefix stripped), used as the title.
    pub title: String,
}

/// Safe frontend projection of IsanAgent's persisted notification record.
///
/// The raw action payload and transport selectors stay backend-only. Keeping
/// the actor record behind an ALTAI-owned camelCase contract also prevents
/// future IsanAgent schema additions from becoming accidental IPC API changes.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNotificationInfo {
    pub id: String,
    pub chat_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub action_kind: Option<String>,
    pub seen_at_ms: Option<i64>,
    pub resolved_at_ms: Option<i64>,
    pub created_at_ms: i64,
}

impl From<isanagent::memory::NotificationRecord> for AgentNotificationInfo {
    fn from(record: isanagent::memory::NotificationRecord) -> Self {
        Self {
            id: record.notification_id,
            chat_id: record.chat_id,
            kind: record.kind,
            title: record.title,
            body: record.body,
            action_kind: record.action_kind,
            seen_at_ms: record.seen_at_ms,
            resolved_at_ms: record.resolved_at_ms,
            created_at_ms: record.created_at_ms,
        }
    }
}

/// Safe list projection of a durable IsanAgent background job.
///
/// `payload_json` is deliberately excluded: it can contain full prompts or
/// execution payloads and is not required to render status in ALTAI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBackgroundJobInfo {
    pub id: String,
    pub kind: String,
    pub chat_id: String,
    pub state: String,
    pub resume_after_restart: bool,
    pub detached: bool,
    pub last_error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl From<isanagent::memory::BackgroundJobRecord> for AgentBackgroundJobInfo {
    fn from(record: isanagent::memory::BackgroundJobRecord) -> Self {
        Self {
            id: record.job_id,
            kind: record.kind,
            chat_id: record.chat_id,
            state: record.state,
            resume_after_restart: record.resume_after_restart,
            detached: record.detached,
            last_error: record.last_error,
            created_at_ms: record.created_at_ms,
            updated_at_ms: record.updated_at_ms,
        }
    }
}

/// Safe frontend projection of a persisted background clarification ticket.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClarificationTicketInfo {
    pub id: String,
    pub job_id: String,
    pub chat_id: String,
    pub prompt: String,
    pub choices: Vec<String>,
    pub response: Option<String>,
    pub status: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Renderer-safe view of a workspace automation. The scheduler's webhook
/// token deliberately remains host-only.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAutomationInfo {
    pub id: String,
    pub schedule: AgentAutomationScheduleInfo,
    pub message: String,
    pub chat_id: String,
    pub last_run_at_ms: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentAutomationScheduleInfo {
    At { at_ms: i64 },
    Every { every_ms: i64 },
    Cron { cron_expr: String },
}

impl From<ScheduleKind> for AgentAutomationScheduleInfo {
    fn from(schedule: ScheduleKind) -> Self {
        match schedule {
            ScheduleKind::At { at_ms } => Self::At { at_ms },
            ScheduleKind::Every { every_ms } => Self::Every { every_ms },
            ScheduleKind::Cron { cron_expr } => Self::Cron { cron_expr },
        }
    }
}

impl From<isanagent::memory::ClarificationTicketRecord> for AgentClarificationTicketInfo {
    fn from(record: isanagent::memory::ClarificationTicketRecord) -> Self {
        let choices = record
            .choices_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
            .unwrap_or_default();
        Self {
            id: record.ticket_id,
            job_id: record.job_id,
            chat_id: record.chat_id,
            prompt: record.prompt,
            choices,
            response: record.response,
            status: record.status,
            created_at_ms: record.created_at_ms,
            updated_at_ms: record.updated_at_ms,
        }
    }
}

/// List all chat sessions persisted in this workspace's backend memory DB.
///
/// Queries the shared per-workspace memory actor via the isanagent crate's
/// `ListRootThreadsForChannelWithPreviews` message — the same store the agent
/// itself uses for history — so the frontend's chat history list reflects what
/// the backend actually knows, not just what survived in the ephemeral
/// `altai-ai-sessions.json`. This is the reconciliation path that makes closed
/// chats reappear in history (Claude Code / Cursor behavior): the backend DB is
/// the durable source of truth.
pub async fn list_sessions(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
) -> Result<Vec<SessionInfo>, String> {
    let workspace_root = workspace_path
        .map(|p| format!("{}/.isanagent", p.trim_end_matches('/')))
        .unwrap_or_default();
    let memory_node = ensure_memory(runtime, &workspace_root).await?;

    // Ask the memory actor for all root threads on this channel (`tauri:*`).
    let (tx, rx) = tokio::sync::oneshot::channel();
    let reply = isanagent::memory::SharedReply::new(tx);
    memory_node
        .send_packet(
            isanagent::memory::MemoryMessage::ListRootThreadsForChannelWithPreviews {
                channel: "tauri".to_string(),
                limit: 200,
                reply,
            },
        )
        .await
        .map_err(|e| format!("Failed to query memory actor: {}", e))?;

    let rows = rx
        .await
        .map_err(|_| "Memory actor closed before replying".to_string())?
        .map_err(|e| format!("Memory actor error: {}", e))?;

    // Strip the `tauri:<chat_id>:` envelope → bare chat id.
    let sessions = rows
        .into_iter()
        .map(|r| {
            let bare_id = r
                .thread_id
                .trim_end_matches(':')
                .split(':')
                .nth(1)
                .unwrap_or(&r.thread_id)
                .to_string();
            SessionInfo {
                id: bare_id,
                updated_at: r.last_activity_ms,
                title: r.preview,
            }
        })
        .collect();
    Ok(sessions)
}

/// Load the full message history for one chat session from the backend memory DB.
///
/// Returns the raw stored messages (OpenAI-style role/content/tool_calls) so the
/// frontend can hydrate a reopened chat with its actual conversation — including
/// chats that were closed and only survived in the durable backend store. This is
/// the counterpart to [`list_sessions`]: `list_sessions` recovers the *list*,
/// this recovers the *contents*.
pub async fn get_session_messages(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
) -> Result<Vec<isanagent::utils::ChatMessage>, String> {
    let workspace_root = workspace_path
        .map(|p| format!("{}/.isanagent", p.trim_end_matches('/')))
        .unwrap_or_default();
    let memory_node = ensure_memory(runtime, &workspace_root).await?;

    // Reconstruct the backend thread_id envelope: `tauri:<chat_id>:`.
    let thread_id = format!("tauri:{}:", chat_id);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let reply = isanagent::memory::SharedReply::new(tx);
    memory_node
        .send_packet(isanagent::memory::MemoryMessage::GetContext { thread_id, reply })
        .await
        .map_err(|e| format!("Failed to query memory actor: {}", e))?;

    rx.await
        .map_err(|_| "Memory actor closed before replying".to_string())?
}

/// Rewind a chat's backend history to the N-th user message.
///
/// Sends `TruncateAfterUserMessage` to the per-workspace memory actor: keep
/// everything up to and including the `keep_user_messages`-th user-role row
/// (1-based, insert order), delete the rest. Returns the number of deleted
/// rows. `keep_user_messages == 0` wipes the whole thread.
///
/// This is the primitive powering frontend conversation edit / retry /
/// checkpoint-rollback — the backend owns the durable history, so the rewind
/// has to happen here. Tool-result cache rows for dropped tool_call_ids and
/// the thread's reflection/summary are cleared in the same transaction.
pub async fn truncate_after_user_message(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    keep_user_messages: usize,
) -> Result<usize, String> {
    let workspace_root = workspace_path
        .map(|p| format!("{}/.isanagent", p.trim_end_matches('/')))
        .unwrap_or_default();
    let memory_node = ensure_memory(runtime, &workspace_root).await?;

    let thread_id = format!("tauri:{}:", chat_id);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let reply = isanagent::memory::SharedReply::new(tx);
    memory_node
        .send_packet(isanagent::memory::MemoryMessage::TruncateAfterUserMessage {
            thread_id,
            keep_user_messages,
            reply,
        })
        .await
        .map_err(|e| format!("Failed to rewind memory actor: {}", e))?;

    rx.await
        .map_err(|_| "Memory actor closed before replying".to_string())?
}

async fn memory_for_workspace_path(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
) -> Result<NodeHandle<isanagent::memory::MemoryMessage>, String> {
    let workspace_root = workspace_path
        .map(|path| format!("{}/.isanagent", path.trim_end_matches('/')))
        .unwrap_or_default();
    ensure_memory(runtime, &workspace_root).await
}

async fn request_memory<T>(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    build: impl FnOnce(
        isanagent::memory::SharedReply<Result<T, String>>,
    ) -> isanagent::memory::MemoryMessage,
) -> Result<T, String>
where
    T: Send + 'static,
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::time::timeout(Duration::from_secs(5), async {
        memory_node
            .send_packet(build(isanagent::memory::SharedReply::new(tx)))
            .await
            .map_err(|error| format!("Failed to query memory actor: {error}"))?;
        rx.await
            .map_err(|_| "Memory actor closed before replying".to_string())?
            .map_err(|error| format!("Memory actor error: {error}"))
    })
    .await
    .map_err(|_| "Memory actor request timed out".to_string())?
}

pub fn validate_tauri_chat_id(chat_id: &str) -> Result<&str, String> {
    let chat_id = chat_id.trim();
    if chat_id.is_empty() {
        return Err("chatId is required".to_string());
    }
    if chat_id.len() > 256 {
        return Err("chatId is too long".to_string());
    }
    if chat_id.contains(':') {
        return Err("chatId contains an invalid delimiter".to_string());
    }
    Ok(chat_id)
}

fn automation_workspace_root(workspace_path: Option<&str>) -> String {
    workspace_path
        .map(|path| format!("{}/.isanagent", path.trim_end_matches('/')))
        .unwrap_or_default()
}

fn automation_store(workspace_root: &str) -> Result<CronStore, String> {
    let workspace_dir = if workspace_root.is_empty() {
        resolve_workspace_root(None)
    } else {
        resolve_workspace_root(Some(workspace_root))
    };
    let db_path = workspace_dir
        .join(".system_generated")
        .join("agent_memory.db");
    CronStore::new(
        db_path
            .to_str()
            .ok_or("workspace automation DB path is not valid UTF-8")?,
    )
}

/// List only ALTAI-owned root-chat automations in one authorized workspace.
/// The scheduler's cross-channel records and webhook secret never leave the
/// host process.
pub async fn list_automations(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
) -> Result<Vec<AgentAutomationInfo>, String> {
    let workspace_root = automation_workspace_root(workspace_path);
    let _services = ensure_workspace_services(runtime, &workspace_root).await?;
    let mut jobs: Vec<_> = automation_store(&workspace_root)?
        .load_jobs()?
        .into_iter()
        .filter(|job| job.channel == "tauri" && validate_tauri_chat_id(&job.chat_id).is_ok())
        .map(|job| AgentAutomationInfo {
            id: job.id,
            schedule: job.schedule.into(),
            message: job.message,
            chat_id: job.chat_id,
            last_run_at_ms: job.last_run_at_ms,
        })
        .collect();
    jobs.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(jobs)
}

/// Add a direct-host automation. The destination is fixed to the current
/// ALTAI Tauri root chat; callers cannot select another transport/channel.
pub async fn create_automation(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    schedule: ScheduleKind,
    message: &str,
) -> Result<AgentAutomationInfo, String> {
    let chat_id = validate_tauri_chat_id(chat_id)?.to_string();
    let message = message.trim();
    if message.is_empty() {
        return Err("Automation message is required".to_string());
    }
    if message.len() > 10_000 {
        return Err("Automation message is too long".to_string());
    }
    let now_ms: i64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock is before the Unix epoch".to_string())?
        .as_millis()
        .try_into()
        .map_err(|_| "System clock is out of range".to_string())?;
    match &schedule {
        ScheduleKind::At { at_ms } if *at_ms <= now_ms => {
            return Err("One-time automation must be scheduled in the future".to_string())
        }
        ScheduleKind::Every { every_ms } if *every_ms < 60_000 => {
            return Err("Repeating automation interval must be at least one minute".to_string())
        }
        ScheduleKind::Every { every_ms } if *every_ms > 366 * 24 * 60 * 60 * 1_000 => {
            return Err("Repeating automation interval is too long".to_string())
        }
        ScheduleKind::Cron { .. } => {
            return Err(
                "Direct automations support one-time or repeating schedules only".to_string(),
            )
        }
        _ => {}
    }
    let workspace_root = automation_workspace_root(workspace_path);
    let services = ensure_workspace_services(runtime, &workspace_root).await?;
    let id = format!("altai:{}", uuid::Uuid::new_v4());
    let command = CronCommand::Add {
        id: id.clone(),
        schedule: schedule.clone(),
        message: message.to_string(),
        chat_id: chat_id.clone(),
        channel: "tauri".to_string(),
    };
    services
        .cron
        .node
        .send_packet(
            serde_json::to_string(&command)
                .map_err(|error| format!("Failed to serialize automation: {error}"))?,
        )
        .await
        .map_err(|error| format!("Failed to add automation: {error}"))?;
    Ok(AgentAutomationInfo {
        id,
        schedule: schedule.into(),
        message: message.to_string(),
        chat_id,
        last_run_at_ms: None,
    })
}

/// Remove an automation only after checking its persisted owner. A renderer
/// cannot use a schedule id from a different ALTAI conversation to remove it.
pub async fn remove_automation(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    automation_id: &str,
) -> Result<(), String> {
    let chat_id = validate_tauri_chat_id(chat_id)?;
    let automation_id = automation_id.trim();
    if automation_id.is_empty() || automation_id.len() > 512 {
        return Err("automationId is invalid".to_string());
    }
    let workspace_root = automation_workspace_root(workspace_path);
    let services = ensure_workspace_services(runtime, &workspace_root).await?;
    let job = automation_store(&workspace_root)?
        .find_job(automation_id)?
        .ok_or_else(|| "Automation was not found".to_string())?;
    if job.channel != "tauri" || job.chat_id != chat_id {
        return Err("Automation does not belong to this Tauri chat".to_string());
    }
    let command = CronCommand::Remove {
        id: automation_id.to_string(),
    };
    services
        .cron
        .node
        .send_packet(
            serde_json::to_string(&command)
                .map_err(|error| format!("Failed to serialize automation removal: {error}"))?,
        )
        .await
        .map_err(|error| format!("Failed to remove automation: {error}"))
}

fn is_tauri_root_identity(
    channel: &str,
    thread_id: Option<&str>,
    expected_chat_id: Option<&str>,
    actual_chat_id: &str,
) -> bool {
    channel == "tauri"
        && thread_id.is_none_or(str::is_empty)
        && expected_chat_id.is_none_or(|expected| expected == actual_chat_id)
}

pub async fn list_notifications(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: Option<&str>,
    unseen_only: bool,
    limit: usize,
) -> Result<Vec<AgentNotificationInfo>, String> {
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    list_notifications_with_memory(&memory_node, chat_id, unseen_only, limit).await
}

async fn list_notifications_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: Option<&str>,
    unseen_only: bool,
    limit: usize,
) -> Result<Vec<AgentNotificationInfo>, String> {
    let limit = limit.clamp(1, 500);
    let records = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ListNotifications {
            chat_id: chat_id.map(str::to_string),
            // The upstream query applies this trusted host boundary before its
            // SQL limit, so records from another channel cannot starve ALTAI's
            // workspace inbox.
            channel: Some("tauri".to_string()),
            limit,
            unseen_only,
            reply,
        }
    })
    .await?;
    Ok(records
        .into_iter()
        .filter(|record| {
            is_tauri_root_identity(
                &record.channel,
                record.thread_id.as_deref(),
                chat_id,
                &record.chat_id,
            )
        })
        .take(limit)
        .map(AgentNotificationInfo::from)
        .collect())
}

pub async fn mark_notification_seen(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    notification_id: &str,
) -> Result<(), String> {
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    mark_notification_seen_with_memory(&memory_node, chat_id, notification_id).await
}

async fn mark_notification_seen_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: &str,
    notification_id: &str,
) -> Result<(), String> {
    let records = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ListNotifications {
            chat_id: Some(chat_id.to_string()),
            channel: Some("tauri".to_string()),
            limit: 500,
            unseen_only: false,
            reply,
        }
    })
    .await?;
    if !records.iter().any(|record| {
        record.notification_id == notification_id
            && is_tauri_root_identity(
                &record.channel,
                record.thread_id.as_deref(),
                Some(chat_id),
                &record.chat_id,
            )
    }) {
        return Err("Notification does not belong to this Tauri chat".to_string());
    }
    request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::MarkNotificationSeen {
            notification_id: notification_id.to_string(),
            reply,
        }
    })
    .await
}

pub async fn resolve_notification(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    notification_id: &str,
) -> Result<(), String> {
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    resolve_notification_with_memory(&memory_node, chat_id, notification_id).await
}

async fn resolve_notification_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: &str,
    notification_id: &str,
) -> Result<(), String> {
    let records = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ListNotifications {
            chat_id: Some(chat_id.to_string()),
            channel: Some("tauri".to_string()),
            limit: 500,
            unseen_only: false,
            reply,
        }
    })
    .await?;
    let Some(record) = records.iter().find(|record| {
        record.notification_id == notification_id
            && is_tauri_root_identity(
                &record.channel,
                record.thread_id.as_deref(),
                Some(chat_id),
                &record.chat_id,
            )
    }) else {
        return Err("Notification does not belong to this Tauri chat".to_string());
    };
    if record.kind == "clarification_ticket" {
        return Err(
            "Clarification notifications must be dismissed through their ticket".to_string(),
        );
    }
    request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ResolveNotification {
            notification_id: notification_id.to_string(),
            reply,
        }
    })
    .await
}

pub async fn list_background_jobs(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: Option<&str>,
    limit: usize,
) -> Result<Vec<AgentBackgroundJobInfo>, String> {
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    list_background_jobs_with_memory(&memory_node, chat_id, limit).await
}

async fn list_background_jobs_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: Option<&str>,
    limit: usize,
) -> Result<Vec<AgentBackgroundJobInfo>, String> {
    let limit = limit.clamp(1, 500);
    let records = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ListBackgroundJobs {
            chat_id: chat_id.map(str::to_string),
            channel: Some("tauri".to_string()),
            limit,
            reply,
        }
    })
    .await?;
    Ok(records
        .into_iter()
        .filter(|record| {
            is_tauri_root_identity(
                &record.channel,
                record.thread_id.as_deref(),
                chat_id,
                &record.chat_id,
            )
        })
        .take(limit)
        .map(AgentBackgroundJobInfo::from)
        .collect())
}

pub async fn dismiss_background_job(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    job_id: &str,
) -> Result<(), String> {
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    dismiss_background_job_with_memory(&memory_node, chat_id, job_id).await
}

async fn dismiss_background_job_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: &str,
    job_id: &str,
) -> Result<(), String> {
    let records = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ListBackgroundJobs {
            chat_id: Some(chat_id.to_string()),
            channel: Some("tauri".to_string()),
            limit: 500,
            reply,
        }
    })
    .await?;
    if !records.iter().any(|record| {
        record.job_id == job_id
            && is_tauri_root_identity(
                &record.channel,
                record.thread_id.as_deref(),
                Some(chat_id),
                &record.chat_id,
            )
    }) {
        return Err("Background job does not belong to this Tauri chat".to_string());
    }
    request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::DismissBackgroundJob {
            job_id: Some(job_id.to_string()),
            ticket_id: None,
            reply,
        }
    })
    .await
}

pub async fn list_clarification_tickets(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: Option<&str>,
    status: Option<&str>,
    limit: usize,
) -> Result<Vec<AgentClarificationTicketInfo>, String> {
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    list_clarification_tickets_with_memory(&memory_node, chat_id, status, limit).await
}

async fn list_clarification_tickets_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: Option<&str>,
    status: Option<&str>,
    limit: usize,
) -> Result<Vec<AgentClarificationTicketInfo>, String> {
    let limit = limit.clamp(1, 500);
    let records = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::ListClarificationTickets {
            job_id: None,
            chat_id: chat_id.map(str::to_string),
            channel: Some("tauri".to_string()),
            status: status.map(str::to_string),
            limit,
            reply,
        }
    })
    .await?;
    Ok(records
        .into_iter()
        .filter(|record| {
            is_tauri_root_identity(
                &record.channel,
                record.thread_id.as_deref(),
                chat_id,
                &record.chat_id,
            )
        })
        .take(limit)
        .map(AgentClarificationTicketInfo::from)
        .collect())
}

pub async fn dismiss_clarification_ticket(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    ticket_id: &str,
) -> Result<(), String> {
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    dismiss_clarification_ticket_with_memory(&memory_node, chat_id, ticket_id).await
}

async fn dismiss_clarification_ticket_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: &str,
    ticket_id: &str,
) -> Result<(), String> {
    let record = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::GetClarificationTicket {
            ticket_id: ticket_id.to_string(),
            reply,
        }
    })
    .await?
    .ok_or_else(|| "Clarification ticket was not found".to_string())?;
    if !is_tauri_root_identity(
        &record.channel,
        record.thread_id.as_deref(),
        Some(chat_id),
        &record.chat_id,
    ) {
        return Err("Clarification ticket does not belong to this Tauri chat".to_string());
    }
    if record.status != "waiting" {
        return Err("Clarification ticket is no longer waiting".to_string());
    }
    request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::DismissBackgroundJob {
            job_id: None,
            ticket_id: Some(ticket_id.to_string()),
            reply,
        }
    })
    .await
}

/// Build the only synthetic inbound shape ALTAI accepts for a persisted
/// clarification reply. The ticket lookup is an authorization check, not the
/// state transition: IsanAgent #66 atomically claims the waiting ticket when
/// the owning runtime processes this message.
async fn clarification_ticket_reply_inbound_with_memory(
    memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
    chat_id: &str,
    ticket_id: &str,
    response: &str,
) -> Result<isanagent::bus::InboundMessage, String> {
    let response = response.trim();
    if response.is_empty() {
        return Err("response is required".to_string());
    }
    if response.len() > 10_000 {
        return Err("response is too long".to_string());
    }

    let ticket = request_memory(memory_node, |reply| {
        isanagent::memory::MemoryMessage::GetClarificationTicket {
            ticket_id: ticket_id.to_string(),
            reply,
        }
    })
    .await?
    .ok_or_else(|| "Clarification ticket was not found".to_string())?;
    if !is_tauri_root_identity(
        &ticket.channel,
        ticket.thread_id.as_deref(),
        Some(chat_id),
        &ticket.chat_id,
    ) {
        return Err("Clarification ticket does not belong to this Tauri chat".to_string());
    }
    if ticket.status != "waiting" {
        return Err("Clarification ticket is no longer waiting".to_string());
    }

    let mut metadata = HashMap::new();
    metadata.insert(
        isanagent::bus::METADATA_CLARIFICATION_TICKET_ID.to_string(),
        serde_json::Value::String(ticket.ticket_id),
    );
    metadata.insert(
        isanagent::bus::METADATA_BACKGROUND_JOB_ID.to_string(),
        serde_json::Value::String(ticket.job_id),
    );
    metadata.insert(
        isanagent::bus::METADATA_SYNTHETIC_BACKGROUND_RESUME.to_string(),
        serde_json::Value::Bool(true),
    );
    Ok(isanagent::bus::InboundMessage {
        channel: "tauri".to_string(),
        sender_id: "altai_clarification_reply".to_string(),
        chat_id: chat_id.to_string(),
        thread_id: None,
        content: response.to_string(),
        attachments: Vec::new(),
        metadata,
    })
}

/// Submit a human response to a persisted background clarification. The
/// workspace dispatcher delivers it only to the runtime that most recently
/// served this chat; IsanAgent then atomically claims/resumes the ticket.
pub async fn reply_to_clarification_ticket(
    runtime: &AgentRuntime,
    workspace_path: Option<&str>,
    chat_id: &str,
    ticket_id: &str,
    response: &str,
) -> Result<(), String> {
    let chat_id = validate_tauri_chat_id(chat_id)?;
    let ticket_id = ticket_id.trim();
    if ticket_id.is_empty() {
        return Err("ticketId is required".to_string());
    }
    let memory_node = memory_for_workspace_path(runtime, workspace_path).await?;
    let inbound =
        clarification_ticket_reply_inbound_with_memory(&memory_node, chat_id, ticket_id, response)
            .await?;
    dispatch_synthetic_inbound(runtime, workspace_path, chat_id, inbound).await
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
    compaction: Option<&CompactionArg>,
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
        compaction,
        None,
    )
    .await
    .map(|_| ())
}

/// Register the interaction and memory tools that already exist in IsanAgent
/// but were previously absent from ALTAI's embedded runtime.
///
/// Keep this helper dependency-only: lifecycle-owning capabilities such as the
/// cron actor and reflection engine are assembled at workspace scope instead
/// of being duplicated for every model/persona instance.
fn register_existing_claw_tools(
    tools: &mut ToolRegistry,
    memory_node: NodeHandle<isanagent::memory::MemoryMessage>,
    clarification_hub: Arc<ClarificationHub>,
    outbound_tx: mpsc::Sender<BusMessage>,
) {
    tools.register(Box::new(AskUserTool {
        clarification_hub,
        outbound_tx,
        memory_node: Some(memory_node.clone()),
    }));
    tools.register(Box::new(SearchMemoryTool {
        memory_node: memory_node.clone(),
    }));
    tools.register(Box::new(FetchMemoryByDateTool { memory_node }));
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
    clarification_hub: Arc<ClarificationHub>,
    logger_handle: isanagent::logging::LoggerHandle,
    cron_node: NodeHandle<String>,
    event_journal: Arc<EventJournal>,
    run_coordinator: SharedRunCoordinator,
    provider_name: &str,
    api_key: &str,
    model_name: &str,
    persona_instructions: Option<&str>,
    base_url_override: Option<&str>,
    workspace_root: Option<&str>,
    permission_mode: Option<&str>,
    compaction: Option<&CompactionArg>,
    fallback: Option<&isanagent::agent::FallbackProviderSpec>,
) -> Result<
    (
        Arc<TauriChannel>,
        mpsc::Sender<BusMessage>,
        tokio::sync::oneshot::Sender<()>,
        async_runtime::JoinHandle<()>,
        async_runtime::JoinHandle<()>,
    ),
    String,
> {
    // Each instance gets its own channel with a unique bootstrap chat_id;
    // actual routing is by per-message chat_id.
    let owner_id = uuid::Uuid::new_v4().to_string();
    let channel = Arc::new(TauriChannel::new(
        app.clone(),
        uuid::Uuid::new_v4().to_string(),
        owner_id.clone(),
        run_coordinator.clone(),
        event_journal.clone(),
    ));

    // Resolve workspace — `<selected-folder>/.isanagent`, or `~/.isanagent`.
    let workspace_dir = resolve_workspace_root(workspace_root);
    if !workspace_dir.exists() {
        // Auto-create minimal workspace
        let _ = std::fs::create_dir_all(workspace_dir.join(".system_generated"));
    }

    let workspace = IsanagentWorkspace::new(workspace_root, None)
        .map_err(|e| format!("Failed to load IsanAgent workspace: {}", e))?;

    // Memory (SQLite) is the shared per-workspace actor passed in by
    // `ensure_instance` — one actor per project, reused across this
    // workspace's model-instances so history transfers and DB access is
    // serialized through a single actor (no contention).
    let session_manager = SessionManager::new(memory_node.clone());
    let skills = SkillRegistry::new(workspace.skills_path());
    // Outbound channel for agent → UI (typed as BusMessage per IsanAgent API)
    let (global_outbound_tx, mut global_outbound_rx) = mpsc::channel::<BusMessage>(100);
    // Inbound bus
    let (bus_tx, mut bus_rx) = mpsc::channel::<BusMessage>(100);

    // Tools
    let mut tools = ToolRegistry::new();
    let restrict = workspace.config.restrict_to_workspace.unwrap_or(true);
    // Sandbox root is the selected project folder (the parent of `.isanagent`),
    // matching the industry-standard pattern used by Claude Code, Codex CLI, and
    // Cline: the agent operates on the project root, NOT a nested
    // `.isanagent/workspace` subfolder. `workspace.sandbox_dir` resolves to that
    // nested folder (isanagent crate default), so we override it here. We fall
    // back to the crate default only when the parent can't be resolved (e.g. the
    // `~/.isanagent` default with no project selected).
    let sandbox_dir = workspace_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| workspace.sandbox_dir.clone());

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
    if workspace.config.git_worktree_tool_enabled() {
        tools.register(Box::new(GitWorktreeTool {
            workspace_dir: sandbox_dir.clone(),
            restrict_to_workspace: restrict,
            allow_path_outside_sandbox: workspace.config.git_worktree_allow_path_outside_sandbox(),
        }));
    }

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
                Err(e) => {
                    log::warn!("checkpoint: app data dir unavailable ({e}); edit undo disabled")
                }
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
    register_existing_claw_tools(
        &mut tools,
        memory_node.clone(),
        clarification_hub.clone(),
        global_outbound_tx.clone(),
    );
    let cron_db_path = workspace_dir
        .join(".system_generated")
        .join("agent_memory.db")
        .to_string_lossy()
        .to_string();
    // CronTool binds its destination to IsanAgent's trusted ToolExecCtx
    // (#67), while the actor itself is shared at workspace scope above.
    tools.register(Box::new(CronTool {
        cron_node,
        multi_tenant_edge_cron_enabled: false,
        mte_cron_scheduler: None,
        db_path: cron_db_path,
    }));
    tools.register(Box::new(TodoWriteTool {
        memory_node: memory_node.clone(),
    }));

    // User-configured MCP servers. Each successful server advertises its
    // tools through `tools/list`; those tools are registered like ALTAI's
    // built-ins and therefore participate in the model's native tool-calling
    // loop. One unavailable optional server must never prevent the agent from
    // starting, so failures are logged AND surfaced to the Settings UI via
    // the process-global MCP status registry.
    //
    // Servers connect CONCURRENTLY so a single slow server (e.g. an `npx`
    // spawn that takes 10s to initialize) doesn't gate every other server
    // behind it — total MCP startup latency is max(connect) rather than sum.
    // Each task owns its full Starting → Connected/Error status transition;
    // the registry mutex is fine for concurrent callers (brief critical
    // sections, no awaits held under the lock).
    let mcp_statuses = app.state::<mcp::McpStatusRegistry>();
    if let Ok(servers) = mcp::load_servers(&sandbox_dir) {
        let enabled: Vec<mcp::McpServerConfig> =
            servers.into_iter().filter(|s| s.enabled).collect();
        if !enabled.is_empty() {
            let mut connect_set = tokio::task::JoinSet::new();
            for server in enabled {
                let sandbox = sandbox_dir.clone();
                let statuses = mcp_statuses.inner().clone();
                connect_set.spawn(async move {
                    let now_ms_start = now_epoch_ms();
                    statuses
                        .set(
                            &sandbox,
                            mcp::McpServerStatus {
                                server_id: server.id.clone(),
                                state: mcp::McpState::Starting,
                                tool_count: None,
                                last_error: None,
                                updated_at_ms: now_ms_start,
                            },
                            now_ms_start,
                        )
                        .await;
                    let outcome = mcp::connect_server(&server, &sandbox).await;
                    (server, outcome)
                });
            }
            // Await every connect; registration happens on the main task so
            // `ToolRegistry` insertion order is deterministic (the registry is
            // name-keyed and safe under concurrent insert, but keeping it on
            // one task keeps the log lines ordered).
            while let Some(joined) = connect_set.join_next().await {
                let Ok((server, outcome)) = joined else {
                    continue;
                };
                match outcome {
                    Ok(mcp_tools) => {
                        let count = mcp_tools.len();
                        log::info!("MCP '{}' connected with {} tools", server.name, count);
                        let now_ms = now_epoch_ms();
                        mcp_statuses
                            .set(
                                &sandbox_dir,
                                mcp::McpServerStatus {
                                    server_id: server.id.clone(),
                                    state: mcp::McpState::Connected,
                                    tool_count: Some(count),
                                    last_error: None,
                                    updated_at_ms: now_ms,
                                },
                                now_ms,
                            )
                            .await;
                        for tool in mcp_tools {
                            tools.register(Box::new(tool));
                        }
                    }
                    Err(error) => {
                        let msg = error.to_string();
                        log::warn!("MCP '{}' unavailable: {msg}", server.name);
                        let now_ms = now_epoch_ms();
                        mcp_statuses
                            .set(
                                &sandbox_dir,
                                mcp::McpServerStatus {
                                    server_id: server.id.clone(),
                                    state: mcp::McpState::Error,
                                    tool_count: None,
                                    last_error: Some(msg),
                                    updated_at_ms: now_ms,
                                },
                                now_ms,
                            )
                            .await;
                    }
                }
            }
        }
    } else {
        // load_servers itself failed — log and continue. Doesn't block the
        // agent (built-in tools already registered above).
        log::warn!("MCP configuration skipped");
    }

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

        tools.register(Box::new(
            isanagent::tools::execution::ExecutionSessionCreateTool {
                harness: harness.clone(),
            },
        ));
        tools.register(Box::new(isanagent::tools::execution::ExecutionRunTool {
            harness: harness.clone(),
            outbound_tx: global_outbound_tx.clone(),
            jobs: Some(execution_jobs.clone()),
            inflight: Some(inflight_sync.clone()),
        }));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionRunBackgroundTool {
                harness: harness.clone(),
                jobs: execution_jobs.clone(),
            },
        ));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionJobStatusTool {
                jobs: execution_jobs.clone(),
            },
        ));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionJobResultTool {
                jobs: execution_jobs.clone(),
                max_tool_output_chars: workspace
                    .config
                    .resolved_max_tool_output_chars()
                    .unwrap_or(3000),
            },
        ));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionJobListTool {
                jobs: execution_jobs.clone(),
            },
        ));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionJobCancelTool {
                jobs: execution_jobs.clone(),
            },
        ));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionArtifactListTool {
                harness: harness.clone(),
            },
        ));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionEnvInfoTool {
                harness: harness.clone(),
            },
        ));
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionSessionCloseTool {
                harness: harness.clone(),
            },
        ));
        tools.register(Box::new(isanagent::tools::execution::ExecutionCancelTool {
            harness: harness.clone(),
        }));

        // Read background-job stdout/stderr line-by-line — lets the agent
        // inspect a long-running job's logs without fetching the full result.
        tools.register(Box::new(
            isanagent::tools::execution::ExecutionReadLogTool {
                jobs: execution_jobs.clone(),
                harness: harness.clone(),
            },
        ));

        // (The colab_mcp extra-tool-call proxy was removed upstream in
        // isanagent #47 "Colab CLI" — ColabMcpToolCallTool /
        // compile_colab_mcp_tool_allowlist and the related config accessors no
        // longer exist, so there's nothing to register here.)
    }

    if workspace.config.kernel_porting_harness_enabled() {
        isanagent::tools::kernel_porting::register_kernel_porting_tools(
            &mut tools,
            sandbox_dir.clone(),
            Arc::new(workspace.config.clone()),
        );
    }

    // Register discovery last so its shared catalog contains every concrete
    // tool available to this instance. This mirrors IsanAgent's reference
    // binary and lets the model find opt-in MCP, execution, worktree, and
    // Claw-parity tools without duplicating a static catalogue in ALTAI.
    let tool_catalog = tools.catalog_handle();
    tools.register(Box::new(ToolSearchTool {
        catalog: tool_catalog,
    }));

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
        let default =
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions".to_string();
        if let Some(ref cfg) = workspace.config.provider {
            cfg.resolved_base_url().unwrap_or(default)
        } else {
            default
        }
    };
    let llm_provider =
        provider::create_provider(provider_name, &resolved_base_url, api_key, model_name);
    let provider_credentials = isanagent::provider::ProviderCredentials {
        provider_name: provider_name.to_string(),
        base_url: resolved_base_url.clone(),
        api_key: api_key.to_string(),
        model_name: model_name.to_string(),
    };
    let fallback_providers = fallback.cloned().into_iter().collect();

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
            allowed_tools: workspace.config.subagent_allowed_tools_set().map(Arc::new),
            max_tasks: workspace.config.subagent_max_tasks(),
            max_wait_secs: workspace.config.subagent_max_wait_secs(),
            agent_registry: Some(agent_registry),
            wake_on_completion: workspace.config.subagent_wake_on_completion(),
            task_history_retention: workspace.config.subagent_task_history_retention(),
            bus_tx: Some(bus_tx.clone()),
            workspace_dir: sandbox_dir.clone(),
        })
    } else {
        None
    };

    let max_iterations = workspace.config.resolved_max_iterations().unwrap_or(50);
    let max_tool_output_chars = workspace
        .config
        .resolved_max_tool_output_chars()
        .unwrap_or(3000);
    // Resolve compaction knobs. The user-facing prefs (auto/thresholdTokens/
    // tailTurns) flow in from JS; when absent we keep the isanagent crate's
    // built-in defaults so direct CLI/canonical callers aren't affected.
    let (max_recent_summaries, short_term_threshold_turns, short_term_threshold_tokens) =
        match compaction {
            Some(c) => c.to_logic_params(),
            None => (5, 20, 100_000),
        };
    // Start from the on-disk shell policy, then let the active UI permission
    // mode override BOTH the interactive shell gate and the file-edit gate.
    //
    // The two surfaces are mapped independently (see `permission_mode_to_*_mode`)
    // because their risk profiles differ: "auto-edit" auto-applies file changes
    // but still prompts for shell commands, while "plan" blocks edits entirely
    // but lets read-only shell runs through with approval. Without overriding
    // `interactive_edit_mode` here, edits would always fall back to the on-disk
    // default (`Ask`) and the toolbar toggle would silently do nothing for the
    // edit surface — which was the core ITEM 1 wiring gap.
    let mut shell_policy = workspace.config.resolved_shell_policy();
    if let Some(mode) = permission_mode_to_shell_mode(permission_mode) {
        shell_policy.interactive_mode = mode;
    }
    if let Some(mode) = permission_mode_to_edit_mode(permission_mode) {
        shell_policy.interactive_edit_mode = mode;
        // `unattended_*_mode` only matters for autonomous/background sessions,
        // but keep it in lockstep with the interactive setting so a background
        // turn doesn't silently use the on-disk default (which is `Deny`) while
        // the user picked `auto-edit` in the toolbar.
        shell_policy.unattended_edit_mode = mode;
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

    let agent_logic = AgentLogic::new_with_fallback_providers(
        AgentLogicParams {
            name: "altai-agent".to_string(),
            provider: llm_provider,
            provider_credentials,
            session_manager,
            tools,
            skills,
            system_prompt,
            max_iterations,
            max_tool_output_chars,
            max_recent_summaries,
            short_term_threshold_turns,
            short_term_threshold_tokens,
            outbound_tx: global_outbound_tx.clone(),
            logger_tx: logger_handle,
            clarification_hub,
            subagent,
            doom_loop_enabled: workspace.config.doom_loop_enabled(),
            harness_runtime_summary,
            subagent_system_prompt,
            forbid_final_without_tools,
            shell_policy,
            hook_tool_ctx,
        },
        fallback_providers,
    );

    let agent_node = NodeHandle::<BusMessage>::new(agent_logic, 100, 3, Duration::from_millis(50));

    // Start the TauriChannel
    channel
        .start(bus_tx.clone())
        .await
        .map_err(|e| format!("TauriChannel start failed: {}", e))?;

    // Bus router: forward inbound → agent, outbound → channel. (Telemetry is
    // emitted by the outbound router below, not here — see note in the loop.)
    let channel_for_outbound = channel.clone();
    // Shutdown trigger: `agent_node` (moved into this task) holds `bus_tx`
    // clones, so `channel.stop()` can't drop the last sender. On teardown we
    // fire `shutdown_tx`; the task breaks, drops `agent_node`, and the cycle
    // unwinds (its `global_outbound_tx` clones drop, ending the outbound task).
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let coordinator_for_bus = run_coordinator.clone();
    let owner_for_bus = owner_id.clone();
    let bus_router = async_runtime::spawn(async move {
        loop {
            let msg = tokio::select! {
                m = bus_rx.recv() => m,
                _ = &mut shutdown_rx => break,
            };
            let Some(msg) = msg else { break };
            match msg {
                BusMessage::Inbound(mut inbound) => {
                    let generated_run_id =
                        if inbound.channel == "tauri" && inbound_run_id(&inbound).is_none() {
                            inbound = trusted_tauri_inbound(inbound);
                            inbound_run_id(&inbound).map(str::to_string)
                        } else {
                            None
                        };
                    let run_id_for_rollback = inbound_run_id(&inbound).map(str::to_string);
                    if let Some(run_id) = generated_run_id.as_deref() {
                        if let Err(error) = queue_run(
                            &coordinator_for_bus,
                            &inbound.chat_id,
                            run_id,
                            &owner_for_bus,
                        ) {
                            log::warn!(
                                "Dropped internal synthetic inbound for chat {}: {}",
                                inbound.chat_id,
                                error
                            );
                            continue;
                        }
                    }
                    let chat_id = inbound.chat_id.clone();
                    let result = agent_node.send_packet(BusMessage::Inbound(inbound)).await;
                    if result.is_err() {
                        if let Some(run_id) = run_id_for_rollback.as_deref() {
                            rollback_run_admission(
                                &coordinator_for_bus,
                                &chat_id,
                                run_id,
                                &owner_for_bus,
                            );
                        }
                    }
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
                    let _ =
                        coordinator_guard(&coordinator_for_bus).cancel_requested(&chat_id, None);
                    let _ = agent_node.send_packet(BusMessage::Cancel(chat_id)).await;
                }
                BusMessage::CancelRun { chat_id, run_id }
                    if coordinator_guard(&coordinator_for_bus)
                        .cancel_requested(&chat_id, Some(&run_id))
                        .is_ok() =>
                {
                    let _ = agent_node
                        .send_packet(BusMessage::CancelRun { chat_id, run_id })
                        .await;
                }
                BusMessage::Steer {
                    chat_id,
                    run_id,
                    content,
                } if coordinator_guard(&coordinator_for_bus)
                    .accepts_steer(&chat_id, &run_id, &owner_for_bus)
                    .is_ok() =>
                {
                    let _ = agent_node
                        .send_packet(BusMessage::Steer {
                            chat_id,
                            run_id,
                            content,
                        })
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
    let coordinator_for_outbound = run_coordinator.clone();
    let journal_for_outbound = event_journal.clone();
    let owner_for_outbound = owner_id.clone();
    let outbound_router = async_runtime::spawn(async move {
        while let Some(out_msg) = global_outbound_rx.recv().await {
            match out_msg {
                BusMessage::Outbound(outbound) => {
                    // Clarifications (`ask_user`) ride on outbound metadata —
                    // surface them as a distinct event so the UI can render the
                    // preset choices as buttons. A normal reply resolves them.
                    //
                    // The crate's edit gate additionally attaches a structured
                    // `edit_diff` to the same outbound when the clarification is
                    // really a file-mutation approval. We extract it here so the
                    // frontend can render a diff-review card instead of the plain
                    // "approve / deny" chips — the reply path is identical.
                    let chat_id = outbound.chat_id.clone();
                    let is_clarification = outbound
                        .metadata
                        .contains_key(isanagent::clarification::METADATA_CLARIFICATION);
                    let edit_diff = outbound.metadata.get("edit_diff").and_then(parse_edit_diff);
                    let event = if is_clarification {
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
                            edit_diff,
                        }
                    } else {
                        Event::AgentMessage {
                            content: outbound.content,
                            role: "assistant".to_string(),
                        }
                    };
                    let transition = persist_run_event(
                        &coordinator_for_outbound,
                        &journal_for_outbound,
                        &chat_id,
                        &owner_for_outbound,
                        &event,
                        RunEventTransition::Next,
                    );
                    match transition {
                        Ok(run) => {
                            // Waiting-user is runtime state, not renderer
                            // state. Commit it after durability even when the
                            // live window is gone and must replay the prompt.
                            if is_clarification {
                                if let Err(error) = coordinator_guard(&coordinator_for_outbound)
                                    .mark_waiting_user(&chat_id, &owner_for_outbound)
                                {
                                    log::warn!(
                                        "Could not mark clarification wait for chat {chat_id}: {error:?}"
                                    );
                                }
                            }
                            if let Err(error) =
                                emit_event(&app_for_outbound, &chat_id, &event, Some(run))
                            {
                                log::warn!("Agent event for chat {chat_id} awaits replay: {error}");
                            }
                        }
                        Err(error) => {
                            log::warn!("Dropped outbound event for chat {chat_id}: {error}")
                        }
                    }
                }
                BusMessage::Telemetry(ref telemetry) => {
                    if let Some(event) = map_telemetry_to_event(telemetry) {
                        let chat_id = telemetry_chat_id(telemetry).unwrap_or("");
                        if is_system_event(&event) {
                            if let Err(error) = emit_event(&app_for_outbound, chat_id, &event, None)
                            {
                                log::warn!("Could not deliver system event: {error}");
                            }
                        } else {
                            if let Err(error) = deliver_next_run_event(
                                &app_for_outbound,
                                &journal_for_outbound,
                                &coordinator_for_outbound,
                                chat_id,
                                &owner_for_outbound,
                                &event,
                            ) {
                                log::warn!("Dropped telemetry event for chat {chat_id}: {error}");
                            }
                        }
                    }
                }
                BusMessage::RunLifecycle(lifecycle) => {
                    use isanagent::bus::RunLifecycleEvent;

                    let event = map_lifecycle_to_event(&lifecycle);
                    match lifecycle {
                        RunLifecycleEvent::Started { run_id, chat_id } => {
                            let transition = persist_run_event(
                                &coordinator_for_outbound,
                                &journal_for_outbound,
                                &chat_id,
                                &owner_for_outbound,
                                &event,
                                RunEventTransition::Started(&run_id),
                            );
                            match transition {
                                Ok(run) => {
                                    if let Err(error) = emit_event(&app_for_outbound, &chat_id, &event, Some(run)) {
                                        log::warn!("Could not deliver persisted run_started for chat {chat_id}: {error}");
                                    }
                                }
                                Err(error) => log::warn!(
                                    "Dropped invalid run_started transition for chat {chat_id}: {error:?}"
                                ),
                            }
                        }
                        RunLifecycleEvent::Warning {
                            run_id, chat_id, ..
                        } => {
                            let transition = persist_run_event(
                                &coordinator_for_outbound,
                                &journal_for_outbound,
                                &chat_id,
                                &owner_for_outbound,
                                &event,
                                RunEventTransition::NextForRun(&run_id),
                            );
                            match transition {
                                Ok(run) => {
                                    if let Err(error) = emit_event(&app_for_outbound, &chat_id, &event, Some(run)) {
                                        log::warn!("Could not deliver persisted run_warning for chat {chat_id}: {error}");
                                    }
                                }
                                Err(error) => log::warn!(
                                    "Dropped invalid run_warning transition for chat {chat_id}: {error:?}"
                                ),
                            }
                        }
                        RunLifecycleEvent::Terminated {
                            run_id, chat_id, ..
                        } => {
                            let transition = persist_run_event(
                                &coordinator_for_outbound,
                                &journal_for_outbound,
                                &chat_id,
                                &owner_for_outbound,
                                &event,
                                RunEventTransition::Terminated(&run_id),
                            );
                            match transition {
                                Ok(run) => {
                                    if let Err(error) = emit_event(&app_for_outbound, &chat_id, &event, Some(run)) {
                                        log::warn!("Could not deliver persisted run_terminated for chat {chat_id}: {error}");
                                    }
                                }
                                Err(error) => log::warn!(
                                    "Dropped invalid run_terminated transition for chat {chat_id}: {error:?}"
                                ),
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    });

    // Emit ready event under the runtime's bootstrap chat_id. It does not match
    // any ALTAI chat tab, so the frontend filters it out — it exists only as a
    // lifecycle signal, not a message to render in a user's chat.
    if let Err(error) = emit_event(
        &app,
        channel.chat_id(),
        &Event::AgentMessage {
            content: "IsanAgent runtime initialized.".to_string(),
            role: "system".to_string(),
        },
        None,
    ) {
        log::warn!("Could not deliver runtime bootstrap event: {error}");
    }

    Ok((channel, bus_tx, shutdown_tx, bus_router, outbound_router))
}

#[cfg(test)]
mod run_event_tests {
    use super::*;

    fn journal() -> (tempfile::TempDir, EventJournal) {
        let directory = tempfile::tempdir().expect("journal directory");
        let journal = EventJournal::open(directory.path().join("events.db")).expect("open journal");
        (directory, journal)
    }

    fn admitted_coordinator() -> SharedRunCoordinator {
        let coordinator = Arc::new(StdMutex::new(RunCoordinator::default()));
        coordinator_guard(&coordinator)
            .admit("chat-a", "run-1", "owner-1")
            .expect("admit run");
        coordinator
    }

    #[test]
    fn journal_append_precedes_delivery() {
        let (_directory, journal) = journal();
        let coordinator = admitted_coordinator();
        let event = Event::RunStarted {
            run_id: "run-1".to_string(),
        };

        persist_and_deliver_run_event(
            &coordinator,
            &journal,
            "chat-a",
            "owner-1",
            &event,
            RunEventTransition::Started("run-1"),
            |run| {
                let persisted = journal.fetch_after("run-1", 0, 10).expect("replay");
                assert_eq!(
                    (persisted[0].run_id.as_str(), persisted[0].seq),
                    (run.0.as_str(), run.1)
                );
                Ok(())
            },
        )
        .expect("persist and deliver");
    }

    #[test]
    fn delivery_failure_leaves_event_replayable() {
        let (_directory, journal) = journal();
        let coordinator = admitted_coordinator();
        let started = Event::RunStarted {
            run_id: "run-1".to_string(),
        };
        persist_run_event(
            &coordinator,
            &journal,
            "chat-a",
            "owner-1",
            &started,
            RunEventTransition::Started("run-1"),
        )
        .expect("start run");
        let message = Event::AgentMessage {
            content: "durable".to_string(),
            role: "assistant".to_string(),
        };

        let error = persist_and_deliver_run_event(
            &coordinator,
            &journal,
            "chat-a",
            "owner-1",
            &message,
            RunEventTransition::Next,
            |_| Err(RunEventDeliveryError::Renderer("unavailable".to_string())),
        )
        .expect_err("delivery must fail");

        assert!(matches!(error, RunEventDeliveryError::Renderer(_)));
        let replay = journal.fetch_after("run-1", 1, 10).expect("replay");
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].seq, 2);
        assert_eq!(replay[0].payload["content"], "durable");
    }

    #[test]
    fn journal_failure_blocks_delivery_and_rolls_back_sequence() {
        let (_directory, journal) = journal();
        journal
            .append(&JournalEvent::now(
                1,
                "run-1",
                1,
                "other-chat",
                "run_started",
                serde_json::json!({"type":"run_started","run_id":"run-1"}),
            ))
            .expect("seed conflicting ownership");
        let coordinator = admitted_coordinator();
        let event = Event::RunStarted {
            run_id: "run-1".to_string(),
        };
        let delivered = std::cell::Cell::new(false);

        assert!(persist_and_deliver_run_event(
            &coordinator,
            &journal,
            "chat-a",
            "owner-1",
            &event,
            RunEventTransition::Started("run-1"),
            |_| {
                delivered.set(true);
                Ok(())
            },
        )
        .is_err());
        assert!(!delivered.get());
        assert_eq!(
            coordinator_guard(&coordinator).started("chat-a", "run-1", "owner-1"),
            Ok(("run-1".to_string(), 1))
        );
    }

    #[test]
    fn terminal_transition_commits_event_and_summary_together() {
        let (_directory, journal) = journal();
        let coordinator = admitted_coordinator();
        persist_run_event(
            &coordinator,
            &journal,
            "chat-a",
            "owner-1",
            &Event::RunStarted {
                run_id: "run-1".to_string(),
            },
            RunEventTransition::Started("run-1"),
        )
        .expect("start run");
        persist_run_event(
            &coordinator,
            &journal,
            "chat-a",
            "owner-1",
            &Event::RunTerminated {
                run_id: "run-1".to_string(),
                outcome: serde_json::json!({"status":"completed"}),
            },
            RunEventTransition::Terminated("run-1"),
        )
        .expect("terminate run");

        let summary = journal
            .run_summary("run-1")
            .expect("summary")
            .expect("run summary");
        assert_eq!(summary.last_seq, 2);
        assert_eq!(summary.terminal_seq, Some(2));
        assert_eq!(summary.terminal_kind.as_deref(), Some("run_terminated"));
        assert_eq!(
            coordinator_guard(&coordinator).next("chat-a", "owner-1"),
            Err(RunTransitionError::MissingLease)
        );
    }

    #[test]
    fn replay_is_exclusive_ordered_and_chat_scoped() {
        let (_directory, journal) = journal();
        let coordinator = admitted_coordinator();
        for (event, transition) in [
            (
                Event::RunStarted {
                    run_id: "run-1".to_string(),
                },
                RunEventTransition::Started("run-1"),
            ),
            (
                Event::Thinking {
                    content: "step".to_string(),
                },
                RunEventTransition::Next,
            ),
            (
                Event::RunTerminated {
                    run_id: "run-1".to_string(),
                    outcome: serde_json::json!({"status":"completed"}),
                },
                RunEventTransition::Terminated("run-1"),
            ),
        ] {
            persist_run_event(
                &coordinator,
                &journal,
                "chat-a",
                "owner-1",
                &event,
                transition,
            )
            .expect("persist event");
        }

        let replay = replay_events_from_journal(&journal, "chat-a", "run-1", 1, 10)
            .expect("replay after acknowledged sequence");
        assert_eq!(
            replay.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [2, 3]
        );
        assert!(replay_events_from_journal(&journal, "chat-b", "run-1", 0, 10).is_err());
        assert!(replay_events_from_journal(&journal, "chat-a", "unknown", 0, 10).is_err());
    }

    #[test]
    fn concurrent_replay_reads_are_identical_and_read_only() {
        let (_directory, journal) = journal();
        let journal = Arc::new(journal);
        journal
            .append(&JournalEvent::now(
                1,
                "run-1",
                1,
                "chat-a",
                "run_started",
                serde_json::json!({"type":"run_started","run_id":"run-1"}),
            ))
            .expect("seed event");

        let reads = std::thread::scope(|scope| {
            let left_journal = journal.clone();
            let right_journal = journal.clone();
            let left = scope.spawn(move || {
                replay_events_from_journal(&left_journal, "chat-a", "run-1", 0, 10)
                    .map(|events| serde_json::to_value(events).expect("serialize replay"))
            });
            let right = scope.spawn(move || {
                replay_events_from_journal(&right_journal, "chat-a", "run-1", 0, 10)
                    .map(|events| serde_json::to_value(events).expect("serialize replay"))
            });
            (
                left.join().expect("left replay").expect("left result"),
                right.join().expect("right replay").expect("right result"),
            )
        });

        assert_eq!(reads.0, reads.1);
        assert_eq!(
            journal
                .run_summary("run-1")
                .expect("summary")
                .expect("run")
                .last_seq,
            1
        );
    }

    #[test]
    fn restart_classifies_incomplete_runs_once_without_resuming_work() {
        let (_directory, journal) = journal();
        for event in [
            JournalEvent::now(
                1,
                "run-before-tool-end",
                1,
                "chat-a",
                "run_started",
                serde_json::json!({"type":"run_started","run_id":"run-before-tool-end"}),
            ),
            JournalEvent::now(
                1,
                "run-before-tool-end",
                2,
                "chat-a",
                "tool_call_start",
                serde_json::json!({"type":"tool_call_start","id":"tool-1","name":"edit_file","input":{}}),
            ),
            JournalEvent::now(
                1,
                "run-after-tool-end",
                1,
                "chat-b",
                "run_started",
                serde_json::json!({"type":"run_started","run_id":"run-after-tool-end"}),
            ),
            JournalEvent::now(
                1,
                "run-after-tool-end",
                2,
                "chat-b",
                "tool_call_end",
                serde_json::json!({"type":"tool_call_end","id":"tool-2","name":"read_file","output":"ok"}),
            ),
        ] {
            journal.append(&event).expect("seed incomplete run");
        }

        classify_runs_abandoned_by_restart(&journal).expect("classify abandoned runs");
        classify_runs_abandoned_by_restart(&journal).expect("repeat is a no-op");

        for (run_id, terminal_seq) in [("run-before-tool-end", 3), ("run-after-tool-end", 3)] {
            let summary = journal.run_summary(run_id).expect("summary").expect("run");
            assert_eq!(summary.last_seq, terminal_seq);
            assert_eq!(summary.terminal_seq, Some(terminal_seq));
            assert_eq!(
                summary.terminal_payload.as_ref().unwrap()["outcome"]["retryable"],
                false
            );
            assert_eq!(
                journal.fetch_after(run_id, 0, 10).expect("replay").len(),
                terminal_seq as usize
            );
        }
        assert!(journal.incomplete_run_summaries().unwrap().is_empty());
    }

    #[test]
    fn latest_chat_cursor_uses_durable_event_order_and_preserves_terminal() {
        let (_directory, journal) = journal();
        let mut old = JournalEvent::now(
            1,
            "run-old",
            1,
            "chat-a",
            "run_started",
            serde_json::json!({"type":"run_started","run_id":"run-old"}),
        );
        old.recorded_at_ms = 1;
        journal.append(&old).unwrap();
        let mut new = JournalEvent::now(
            1,
            "run-new",
            1,
            "chat-a",
            "run_terminated",
            serde_json::json!({
                "type":"run_terminated",
                "run_id":"run-new",
                "outcome":{"kind":"completed"}
            }),
        );
        new.recorded_at_ms = 2;
        journal.append_terminal(&new).unwrap();

        let latest = journal
            .latest_run_summary_for_chat("chat-a")
            .unwrap()
            .unwrap();
        assert_eq!(latest.run_id, "run-new");
        assert_eq!(latest.terminal_seq, Some(1));
        assert!(journal
            .latest_run_summary_for_chat("chat-b")
            .unwrap()
            .is_none());
    }

    #[test]
    fn sequence_is_monotonic_and_terminal_closes_only_the_matching_run() {
        let mut coordinator = RunCoordinator::default();
        coordinator
            .admit("chat-a", "run-1", "owner-1")
            .expect("admit first run");
        assert_eq!(
            coordinator.started("chat-a", "run-1", "owner-1"),
            Ok(("run-1".to_string(), 1))
        );
        assert_eq!(
            coordinator.next("chat-a", "owner-1"),
            Ok(("run-1".to_string(), 2))
        );
        assert_eq!(
            coordinator.terminated("chat-a", "other-run", "owner-1"),
            Err(RunTransitionError::RunMismatch)
        );
        assert_eq!(
            coordinator.terminated("chat-a", "run-1", "owner-1"),
            Ok(("run-1".to_string(), 3))
        );
        assert_eq!(
            coordinator.next("chat-a", "owner-1"),
            Err(RunTransitionError::MissingLease)
        );
    }

    #[test]
    fn stale_run_warning_cannot_consume_the_active_sequence() {
        let mut coordinator = RunCoordinator::default();
        coordinator
            .admit("chat-a", "run-1", "owner-1")
            .expect("admit run");
        coordinator
            .started("chat-a", "run-1", "owner-1")
            .expect("start run");

        assert_eq!(
            coordinator.next_for_run("chat-a", "stale-run", "owner-1"),
            Err(RunTransitionError::RunMismatch)
        );
        assert_eq!(
            coordinator.next_for_run("chat-a", "run-1", "owner-1"),
            Ok(("run-1".to_string(), 2))
        );
    }

    #[test]
    fn cancellation_keeps_lease_until_matching_terminal() {
        let mut coordinator = RunCoordinator::default();
        coordinator
            .admit("chat-a", "run-1", "owner-1")
            .expect("admit first run");
        coordinator
            .started("chat-a", "run-1", "owner-1")
            .expect("start first run");

        assert_eq!(
            coordinator.cancel_requested("chat-a", Some("run-1")),
            Ok("run-1".to_string())
        );
        assert_eq!(
            coordinator.admit("chat-a", "run-2", "owner-2"),
            Err(RunTransitionError::ActiveLease)
        );
        assert_eq!(
            coordinator.terminated("chat-a", "run-2", "owner-2"),
            Err(RunTransitionError::RunMismatch)
        );
        assert_eq!(
            coordinator.terminated("chat-a", "run-1", "owner-1"),
            Ok(("run-1".to_string(), 2))
        );
    }

    #[test]
    fn steering_accepts_only_the_exact_running_lease() {
        let mut coordinator = RunCoordinator::default();
        coordinator
            .admit("chat-a", "run-1", "owner-1")
            .expect("admit run");
        assert_eq!(
            coordinator.accepts_steer("chat-a", "run-1", "owner-1"),
            Err(RunTransitionError::InvalidPhase)
        );
        coordinator
            .started("chat-a", "run-1", "owner-1")
            .expect("start run");
        assert_eq!(
            coordinator.accepts_steer("chat-a", "stale", "owner-1"),
            Err(RunTransitionError::RunMismatch)
        );
        assert_eq!(
            coordinator.accepts_steer("chat-a", "run-1", "owner-2"),
            Err(RunTransitionError::OwnerMismatch)
        );
        assert_eq!(
            coordinator.accepts_steer("chat-a", "run-1", "owner-1"),
            Ok(())
        );
        coordinator
            .cancel_requested("chat-a", Some("run-1"))
            .expect("cancel run");
        assert_eq!(
            coordinator.accepts_steer("chat-a", "run-1", "owner-1"),
            Err(RunTransitionError::InvalidPhase)
        );
    }

    #[test]
    fn clarification_reply_preserves_the_active_run_identity() {
        let coordinator = Arc::new(StdMutex::new(RunCoordinator::default()));
        {
            let mut guard = coordinator_guard(&coordinator);
            guard
                .admit("chat-a", "run-1", "owner-1")
                .expect("admit run");
            guard
                .started("chat-a", "run-1", "owner-1")
                .expect("start run");
            guard
                .mark_waiting_user("chat-a", "owner-1")
                .expect("wait for user");
        }
        assert_eq!(
            admit_user_message(&coordinator, "chat-a", "reply-id", "owner-1"),
            Ok("run-1".to_string())
        );
        assert_eq!(
            coordinator_guard(&coordinator).next("chat-a", "owner-1"),
            Ok(("run-1".to_string(), 2))
        );
    }

    #[test]
    fn queued_run_is_promoted_only_after_terminal() {
        let mut coordinator = RunCoordinator::default();
        coordinator
            .admit("chat-a", "run-1", "owner-1")
            .expect("admit current run");
        coordinator
            .started("chat-a", "run-1", "owner-1")
            .expect("start current run");
        assert_eq!(
            coordinator.admit_or_queue("chat-a", "run-2", "owner-1"),
            Ok(RunAdmission::Queued)
        );
        assert_eq!(
            coordinator.started("chat-a", "run-2", "owner-1"),
            Err(RunTransitionError::RunMismatch)
        );
        coordinator
            .terminated("chat-a", "run-1", "owner-1")
            .expect("terminate current run");
        assert_eq!(
            coordinator.started("chat-a", "run-2", "owner-1"),
            Ok(("run-2".to_string(), 1))
        );
    }

    #[test]
    fn concurrent_admission_grants_exactly_one_chat_lease() {
        let coordinator = Arc::new(StdMutex::new(RunCoordinator::default()));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut handles = Vec::new();
        for index in 1..=2 {
            let coordinator = coordinator.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                coordinator_guard(&coordinator).admit(
                    "chat-a",
                    &format!("run-{index}"),
                    &format!("owner-{index}"),
                )
            }));
        }
        barrier.wait();
        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("admission thread"))
            .collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| **outcome == Err(RunTransitionError::ActiveLease))
                .count(),
            1
        );
    }

    #[test]
    fn envelope_is_versioned_and_carries_run_identity() {
        let event = Event::RunStarted {
            run_id: "run-1".to_string(),
        };
        let envelope = AgentEventEnvelope {
            version: 1,
            scope: "run",
            run_id: Some("run-1"),
            seq: Some(1),
            chat_id: "chat-a",
            event: &event,
        };
        let value = serde_json::to_value(envelope).expect("serialize envelope");
        assert_eq!(value["version"], 1);
        assert_eq!(value["scope"], "run");
        assert_eq!(value["runId"], "run-1");
        assert_eq!(value["seq"], 1);
        assert_eq!(value["chatId"], "chat-a");
        assert_eq!(value["event"]["type"], "run_started");
    }
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

#[cfg(test)]
mod compaction_tests {
    use super::*;

    #[test]
    fn auto_on_passes_threshold_and_tail() {
        let c = CompactionArg {
            auto: true,
            threshold_tokens: 50_000,
            tail_turns: 7,
        };
        let (tail, turns, tokens) = c.to_logic_params();
        assert_eq!(tail, 7);
        assert_eq!(turns, 20); // crate default, not user-configurable
        assert_eq!(tokens, 50_000);
    }

    #[test]
    fn auto_on_floors_threshold_at_8k() {
        // A typo of 0 (or below 8k) must not wedge the loop into compacting
        // every turn.
        let c = CompactionArg {
            auto: true,
            threshold_tokens: 0,
            tail_turns: 5,
        };
        let (_, _, tokens) = c.to_logic_params();
        assert_eq!(tokens, 8_000);
    }

    #[test]
    fn auto_off_disables_via_max_threshold() {
        // auto=false → MAX threshold so the between-turns trigger never fires.
        // Manual /compact still works (it's a direct tool invocation).
        let c = CompactionArg {
            auto: false,
            threshold_tokens: 50_000,
            tail_turns: 5,
        };
        let (_, _, tokens) = c.to_logic_params();
        assert_eq!(tokens, usize::MAX);
    }

    #[test]
    fn fingerprint_tuple_round_trips_fields() {
        let c = CompactionArg {
            auto: false,
            threshold_tokens: 12_345,
            tail_turns: 9,
        };
        assert_eq!(c.fingerprint_tuple(), (false, 12_345, 9));
    }
}

#[cfg(test)]
mod provider_fingerprint_tests {
    use super::*;

    fn fallback(
        provider: &str,
        model: &str,
        api_key: &str,
    ) -> isanagent::agent::FallbackProviderSpec {
        isanagent::agent::FallbackProviderSpec {
            provider_name: provider.to_string(),
            base_url: format!("https://{provider}.test/v1"),
            api_key: api_key.to_string(),
            model_name: model.to_string(),
        }
    }

    fn fingerprint(
        primary_key: &str,
        fallback: Option<&isanagent::agent::FallbackProviderSpec>,
    ) -> RuntimeFingerprint {
        make_fingerprint(
            "primary",
            primary_key,
            "primary-model",
            None,
            Some("https://primary.test/v1"),
            Some("/tmp/altai-provider-fingerprint-test"),
            Some("ask"),
            None,
            fallback,
        )
    }

    #[test]
    fn fingerprint_debug_uses_secret_identity_instead_of_raw_keys() {
        let fallback = fallback("backup", "backup-model", "fallback-secret-value");
        let runtime_fingerprint = fingerprint("primary-secret-value", Some(&fallback));
        let debug = format!("{runtime_fingerprint:?}");

        assert!(!debug.contains("primary-secret-value"), "{debug}");
        assert!(!debug.contains("fallback-secret-value"), "{debug}");
        assert!(debug.contains("sha256:"), "{debug}");
        assert_ne!(
            fingerprint("primary-secret-value", Some(&fallback)),
            fingerprint("different-primary-secret", Some(&fallback))
        );
    }

    #[test]
    fn two_concurrent_chat_configurations_keep_distinct_fallback_identity() {
        let fallback_a = fallback("backup-a", "model-a", "fallback-key-a");
        let fallback_b = fallback("backup-b", "model-b", "fallback-key-b");
        let (config_a, config_b) = std::thread::scope(|scope| {
            let config_a = scope.spawn(|| fingerprint("shared-primary-key", Some(&fallback_a)));
            let config_b = scope.spawn(|| fingerprint("shared-primary-key", Some(&fallback_b)));
            (
                config_a.join().expect("chat-a fingerprint"),
                config_b.join().expect("chat-b fingerprint"),
            )
        });

        let mut owners = HashMap::new();
        owners.insert(config_a.clone(), "chat-a");
        owners.insert(config_b.clone(), "chat-b");

        assert_ne!(config_a, config_b);
        assert_eq!(owners.len(), 2);
        assert_eq!(owners.get(&config_a), Some(&"chat-a"));
        assert_eq!(owners.get(&config_b), Some(&"chat-b"));
    }
}

#[cfg(test)]
mod claw_parity_tests {
    use super::*;

    fn record<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> T {
        serde_json::from_value(value).expect("valid IsanAgent record")
    }

    fn notification(
        id: &str,
        chat_id: &str,
        channel: &str,
        thread_id: Option<&str>,
        kind: &str,
    ) -> isanagent::memory::NotificationRecord {
        record(serde_json::json!({
            "notification_id": id,
            "chat_id": chat_id,
            "channel": channel,
            "thread_id": thread_id,
            "kind": kind,
            "title": format!("title-{id}"),
            "body": format!("body-{id}"),
            "action_kind": null,
            "action_payload": null,
            "seen_at_ms": null,
            "resolved_at_ms": null,
            "created_at_ms": 1,
        }))
    }

    fn background_job(
        id: &str,
        chat_id: &str,
        channel: &str,
        thread_id: Option<&str>,
        payload_json: &str,
    ) -> isanagent::memory::BackgroundJobRecord {
        record(serde_json::json!({
            "job_id": id,
            "kind": "cron",
            "chat_id": chat_id,
            "channel": channel,
            "thread_id": thread_id,
            "state": "waiting",
            "payload_json": payload_json,
            "resume_after_restart": true,
            "detached": true,
            "last_error": null,
            "created_at_ms": 1,
            "updated_at_ms": 1,
        }))
    }

    fn ticket(
        id: &str,
        job_id: &str,
        chat_id: &str,
        channel: &str,
        thread_id: Option<&str>,
        status: &str,
        choices_json: Option<&str>,
    ) -> isanagent::memory::ClarificationTicketRecord {
        record(serde_json::json!({
            "ticket_id": id,
            "job_id": job_id,
            "chat_id": chat_id,
            "channel": channel,
            "thread_id": thread_id,
            "tool_call_id": format!("tool-{id}"),
            "prompt": format!("prompt-{id}"),
            "choices_json": choices_json,
            "response": null,
            "status": status,
            "created_at_ms": 1,
            "updated_at_ms": 1,
        }))
    }

    fn memory_node(db_path: &std::path::Path) -> NodeHandle<isanagent::memory::MemoryMessage> {
        let memory_actor = isanagent::memory::SqliteMemoryActor::new(
            db_path.to_str().expect("utf-8 database path"),
        )
        .expect("memory actor");
        NodeHandle::<isanagent::memory::MemoryMessage>::new(
            memory_actor,
            100,
            1,
            Duration::from_millis(5),
        )
    }

    async fn seed_notification(
        memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
        record: isanagent::memory::NotificationRecord,
    ) {
        request_memory(memory_node, |reply| {
            isanagent::memory::MemoryMessage::InsertNotification { record, reply }
        })
        .await
        .expect("insert notification");
    }

    async fn seed_background_job(
        memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
        record: isanagent::memory::BackgroundJobRecord,
    ) {
        request_memory(memory_node, |reply| {
            isanagent::memory::MemoryMessage::UpsertBackgroundJob { record, reply }
        })
        .await
        .expect("insert background job");
    }

    async fn seed_ticket(
        memory_node: &NodeHandle<isanagent::memory::MemoryMessage>,
        record: isanagent::memory::ClarificationTicketRecord,
    ) {
        request_memory(memory_node, |reply| {
            isanagent::memory::MemoryMessage::UpsertClarificationTicket { record, reply }
        })
        .await
        .expect("insert clarification ticket");
    }

    #[tokio::test]
    async fn registers_existing_interaction_and_memory_tools() {
        let dir = tempfile::tempdir().expect("temp dir");
        let db_path = dir.path().join("memory.db");
        let memory_node = memory_node(&db_path);
        let (outbound_tx, _outbound_rx) = mpsc::channel(8);
        let mut tools = ToolRegistry::new();

        register_existing_claw_tools(
            &mut tools,
            memory_node,
            ClarificationHub::shared(),
            outbound_tx,
        );

        let names = tools.get_tool_names();
        for expected in ["ask_user", "search_memory", "fetch_memory_by_date"] {
            assert!(
                names.iter().any(|name| name == expected),
                "missing IsanAgent parity tool {expected}; registered: {names:?}"
            );
        }
        assert!(
            !names.iter().any(|name| name == "message"),
            "raw message must remain disabled until completion and destination contracts are safe"
        );
    }

    #[test]
    fn validates_opaque_tauri_chat_ids_and_root_identity() {
        assert_eq!(validate_tauri_chat_id("  s-chat-1  ").unwrap(), "s-chat-1");
        assert!(validate_tauri_chat_id("").is_err());
        assert!(validate_tauri_chat_id("tauri:chat:").is_err());
        assert!(validate_tauri_chat_id(&"x".repeat(257)).is_err());

        assert!(is_tauri_root_identity(
            "tauri",
            None,
            Some("chat-a"),
            "chat-a"
        ));
        assert!(is_tauri_root_identity(
            "tauri",
            Some(""),
            Some("chat-a"),
            "chat-a"
        ));
        assert!(!is_tauri_root_identity(
            "slack",
            None,
            Some("chat-a"),
            "chat-a"
        ));
        assert!(!is_tauri_root_identity(
            "tauri",
            Some("thread"),
            Some("chat-a"),
            "chat-a"
        ));
        assert!(!is_tauri_root_identity(
            "tauri",
            None,
            Some("chat-b"),
            "chat-a"
        ));
    }

    #[tokio::test]
    async fn persisted_facade_enforces_identity_and_mutation_guards() {
        let dir = tempfile::tempdir().expect("temp dir");
        let memory_node = memory_node(&dir.path().join("memory.db"));

        for record in [
            notification("notification-a", "chat-a", "tauri", None, "cron_triggered"),
            notification("notification-b", "chat-b", "tauri", None, "cron_triggered"),
            notification(
                "notification-slack",
                "chat-a",
                "slack",
                None,
                "cron_triggered",
            ),
            notification(
                "notification-thread",
                "chat-a",
                "tauri",
                Some("subthread"),
                "cron_triggered",
            ),
            notification(
                "notification-ticket",
                "chat-a",
                "tauri",
                None,
                "clarification_ticket",
            ),
        ] {
            seed_notification(&memory_node, record).await;
        }

        for record in [
            background_job(
                "job-a",
                "chat-a",
                "tauri",
                None,
                r#"{"secret":"keep-me-private"}"#,
            ),
            background_job("job-b", "chat-b", "tauri", None, "{}"),
            background_job("job-slack", "chat-a", "slack", None, "{}"),
            background_job("job-thread", "chat-a", "tauri", Some("subthread"), "{}"),
        ] {
            seed_background_job(&memory_node, record).await;
        }

        for record in [
            ticket(
                "ticket-a",
                "job-a",
                "chat-a",
                "tauri",
                None,
                "waiting",
                Some(r#"["one","two"]"#),
            ),
            ticket(
                "ticket-b", "job-b", "chat-b", "tauri", None, "waiting", None,
            ),
            ticket(
                "ticket-slack",
                "job-slack",
                "chat-a",
                "slack",
                None,
                "waiting",
                None,
            ),
            ticket(
                "ticket-thread",
                "job-thread",
                "chat-a",
                "tauri",
                Some("subthread"),
                "waiting",
                None,
            ),
            ticket(
                "ticket-answered",
                "job-a",
                "chat-a",
                "tauri",
                None,
                "answered",
                None,
            ),
        ] {
            seed_ticket(&memory_node, record).await;
        }

        let notifications =
            list_notifications_with_memory(&memory_node, Some("chat-a"), false, 500)
                .await
                .expect("list notifications");
        let mut notification_ids: Vec<_> =
            notifications.into_iter().map(|record| record.id).collect();
        notification_ids.sort();
        assert_eq!(
            notification_ids,
            [
                "notification-a".to_string(),
                "notification-ticket".to_string()
            ]
        );

        let jobs = list_background_jobs_with_memory(&memory_node, Some("chat-a"), 500)
            .await
            .expect("list background jobs");
        assert_eq!(
            jobs.iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            ["job-a"]
        );

        let tickets =
            list_clarification_tickets_with_memory(&memory_node, Some("chat-a"), None, 500)
                .await
                .expect("list clarification tickets");
        let mut ticket_ids: Vec<_> = tickets.into_iter().map(|record| record.id).collect();
        ticket_ids.sort();
        assert_eq!(
            ticket_ids,
            ["ticket-a".to_string(), "ticket-answered".to_string()]
        );

        assert!(
            mark_notification_seen_with_memory(&memory_node, "chat-a", "missing-notification",)
                .await
                .expect_err("unknown notification must be denied")
                .contains("does not belong")
        );
        assert!(
            mark_notification_seen_with_memory(&memory_node, "chat-a", "notification-b")
                .await
                .expect_err("wrong-chat notification must be denied")
                .contains("does not belong")
        );
        assert!(
            resolve_notification_with_memory(&memory_node, "chat-a", "notification-ticket")
                .await
                .expect_err("clarification notification must use ticket dismissal")
                .contains("through their ticket")
        );

        assert!(
            dismiss_background_job_with_memory(&memory_node, "chat-a", "missing-job")
                .await
                .expect_err("unknown job must be denied")
                .contains("does not belong")
        );
        assert!(
            dismiss_background_job_with_memory(&memory_node, "chat-a", "job-b")
                .await
                .expect_err("wrong-chat job must be denied")
                .contains("does not belong")
        );

        assert!(
            dismiss_clarification_ticket_with_memory(&memory_node, "chat-a", "missing-ticket",)
                .await
                .expect_err("unknown ticket must be denied")
                .contains("not found")
        );
        assert!(
            dismiss_clarification_ticket_with_memory(&memory_node, "chat-a", "ticket-b")
                .await
                .expect_err("wrong-chat ticket must be denied")
                .contains("does not belong")
        );
        assert!(
            dismiss_clarification_ticket_with_memory(&memory_node, "chat-a", "ticket-slack")
                .await
                .expect_err("wrong-channel ticket must be denied")
                .contains("does not belong")
        );
        assert!(
            dismiss_clarification_ticket_with_memory(&memory_node, "chat-a", "ticket-thread")
                .await
                .expect_err("subthread ticket must be denied")
                .contains("does not belong")
        );
        assert!(dismiss_clarification_ticket_with_memory(
            &memory_node,
            "chat-a",
            "ticket-answered",
        )
        .await
        .expect_err("answered ticket must be denied")
        .contains("no longer waiting"));

        let inbound = clarification_ticket_reply_inbound_with_memory(
            &memory_node,
            "chat-a",
            "ticket-a",
            "  one  ",
        )
        .await
        .expect("trusted ticket reply inbound");
        assert_eq!(inbound.channel, "tauri");
        assert_eq!(inbound.chat_id, "chat-a");
        assert_eq!(inbound.thread_id, None);
        assert_eq!(inbound.content, "one");
        assert_eq!(
            inbound
                .metadata
                .get(isanagent::bus::METADATA_CLARIFICATION_TICKET_ID)
                .and_then(|value| value.as_str()),
            Some("ticket-a")
        );
        assert_eq!(
            inbound
                .metadata
                .get(isanagent::bus::METADATA_BACKGROUND_JOB_ID)
                .and_then(|value| value.as_str()),
            Some("job-a")
        );
        assert!(clarification_ticket_reply_inbound_with_memory(
            &memory_node,
            "chat-a",
            "ticket-b",
            "one",
        )
        .await
        .expect_err("cross-chat ticket reply must be denied")
        .contains("does not belong"));
        assert!(clarification_ticket_reply_inbound_with_memory(
            &memory_node,
            "chat-a",
            "ticket-answered",
            "one",
        )
        .await
        .expect_err("answered ticket reply must be denied")
        .contains("no longer waiting"));
    }

    #[tokio::test]
    async fn channel_scoped_inbox_query_applies_before_the_limit() {
        let dir = tempfile::tempdir().expect("temp dir");
        let memory_node = memory_node(&dir.path().join("memory.db"));

        let mut tauri_record = notification(
            "tauri-notification",
            "chat-a",
            "tauri",
            None,
            "cron_triggered",
        );
        tauri_record.created_at_ms = 1;
        seed_notification(&memory_node, tauri_record).await;

        // These are all newer than the Tauri record. The former API adapter
        // fetched the newest 500 global records, filtered afterward, and
        // would return an empty ALTAI inbox here. The upstream channel filter
        // must execute in SQLite before `limit` is applied.
        for index in 0..501 {
            let mut record = notification(
                &format!("slack-notification-{index}"),
                "chat-a",
                "slack",
                None,
                "cron_triggered",
            );
            record.created_at_ms = i64::from(index) + 2;
            seed_notification(&memory_node, record).await;
        }

        let records = list_notifications_with_memory(&memory_node, None, false, 1)
            .await
            .expect("list notifications");
        assert_eq!(
            records
                .iter()
                .map(|record| record.id.as_str())
                .collect::<Vec<_>>(),
            ["tauri-notification"]
        );
    }

    #[test]
    fn clarification_dto_treats_malformed_choices_as_empty() {
        let dto = AgentClarificationTicketInfo::from(ticket(
            "ticket-malformed",
            "job-a",
            "chat-a",
            "tauri",
            None,
            "waiting",
            Some("{not-json"),
        ));
        assert!(dto.choices.is_empty());
    }

    #[test]
    fn background_job_dto_never_serializes_payload_json() {
        let dto = AgentBackgroundJobInfo::from(background_job(
            "job-secret",
            "chat-a",
            "tauri",
            None,
            r#"{"prompt":"TOP SECRET"}"#,
        ));
        let json = serde_json::to_value(dto).expect("serialize background job DTO");
        let encoded = serde_json::to_string(&json).expect("encode background job DTO");

        assert!(json.get("payloadJson").is_none());
        assert!(json.get("payload_json").is_none());
        assert!(!encoded.contains("TOP SECRET"));
    }

    #[tokio::test]
    async fn workspace_dispatcher_routes_only_an_explicitly_bound_chat() {
        let coordinator = Arc::new(StdMutex::new(RunCoordinator::default()));
        let dispatcher = WorkspaceDispatcher::new(coordinator);
        let (bus_tx, mut bus_rx) = mpsc::channel(1);
        dispatcher.bind("chat-a", bus_tx, "owner-a").await;

        let inbound = trusted_tauri_inbound(isanagent::bus::InboundMessage {
            channel: "tauri".to_string(),
            sender_id: "system".to_string(),
            chat_id: "chat-a".to_string(),
            thread_id: None,
            content: "Synthetic work".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        });
        dispatcher
            .dispatch("chat-a".to_string(), inbound)
            .await
            .expect("bound chat routes");

        let routed = bus_rx.recv().await.expect("inbound routed to owner");
        assert!(matches!(routed, BusMessage::Inbound(message) if message.chat_id == "chat-a"));

        let unbound = isanagent::bus::InboundMessage {
            channel: "tauri".to_string(),
            sender_id: "system".to_string(),
            chat_id: "chat-b".to_string(),
            thread_id: None,
            content: "Synthetic work".to_string(),
            attachments: Vec::new(),
            metadata: HashMap::new(),
        };
        assert!(dispatcher
            .dispatch("chat-b".to_string(), unbound)
            .await
            .expect_err("unbound chat must fail closed")
            .contains("No owning"));
    }

    #[tokio::test]
    async fn owner_bind_recovers_only_persisted_tauri_background_work() {
        let dir = tempfile::tempdir().expect("temp dir");
        let memory_node = memory_node(&dir.path().join("memory.db"));

        let mut recoverable = background_job(
            "cron:daily",
            "chat-a",
            "tauri",
            None,
            r#"{"message":"Run the daily briefing"}"#,
        );
        recoverable.state = "running".to_string();
        recoverable.resume_after_restart = true;
        let mut no_resume = background_job("job-no-resume", "chat-a", "tauri", None, "{}");
        no_resume.state = "running".to_string();
        no_resume.resume_after_restart = false;
        let mut foreign = background_job("job-foreign", "chat-b", "tauri", None, "{}");
        foreign.state = "running".to_string();
        foreign.resume_after_restart = true;
        for job in [recoverable, no_resume, foreign] {
            seed_background_job(&memory_node, job).await;
        }

        let coordinator = Arc::new(StdMutex::new(RunCoordinator::default()));
        let dispatcher = WorkspaceDispatcher::new(coordinator);
        let (bus_tx, mut bus_rx) = mpsc::channel(2);
        dispatcher.bind("chat-a", bus_tx, "owner-a").await;
        recover_background_jobs_after_owner_bind(&memory_node, &dispatcher, "chat-a")
            .await
            .expect("recover background work");

        let routed = bus_rx.recv().await.expect("one recovery inbound");
        let BusMessage::Inbound(inbound) = routed else {
            panic!("expected recovery inbound");
        };
        assert_eq!(inbound.chat_id, "chat-a");
        assert_eq!(inbound.content, "Run the daily briefing");
        assert_eq!(
            inbound
                .metadata
                .get(isanagent::bus::METADATA_BACKGROUND_JOB_ID)
                .and_then(|value| value.as_str()),
            Some("cron:daily")
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), bus_rx.recv())
                .await
                .is_err()
        );
    }
}
