use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;
use std::fmt;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: i64 = 1;
const MAX_FETCH_LIMIT: usize = 1_000;

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS agent_event_journal_events (
    run_id          TEXT NOT NULL,
    seq             INTEGER NOT NULL CHECK (seq > 0),
    version         INTEGER NOT NULL CHECK (version > 0),
    chat_id         TEXT NOT NULL,
    recorded_at_ms  INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
    kind            TEXT NOT NULL,
    payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
    is_terminal     INTEGER NOT NULL CHECK (is_terminal IN (0, 1)),
    PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS agent_event_journal_events_chat_time
    ON agent_event_journal_events (chat_id, recorded_at_ms, run_id, seq);

CREATE TABLE IF NOT EXISTS agent_event_journal_runs (
    run_id                 TEXT PRIMARY KEY,
    chat_id                TEXT NOT NULL,
    last_seq               INTEGER NOT NULL CHECK (last_seq >= 0),
    terminal_seq           INTEGER,
    terminal_kind          TEXT,
    terminal_payload_json  TEXT CHECK (
        terminal_payload_json IS NULL OR json_valid(terminal_payload_json)
    ),
    CHECK (
        (terminal_seq IS NULL AND terminal_kind IS NULL AND terminal_payload_json IS NULL)
        OR
        (terminal_seq IS NOT NULL AND terminal_kind IS NOT NULL AND terminal_payload_json IS NOT NULL)
    )
);
"#;

#[derive(Debug, Clone, PartialEq)]
pub struct JournalEvent {
    pub version: u32,
    pub run_id: String,
    pub seq: u64,
    pub chat_id: String,
    pub recorded_at_ms: u64,
    pub kind: String,
    pub payload: Value,
}

impl JournalEvent {
    pub fn now(
        version: u32,
        run_id: impl Into<String>,
        seq: u64,
        chat_id: impl Into<String>,
        kind: impl Into<String>,
        payload: Value,
    ) -> Self {
        let recorded_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64;
        Self {
            version,
            run_id: run_id.into(),
            seq,
            chat_id: chat_id.into(),
            recorded_at_ms,
            kind: kind.into(),
            payload,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunJournalSummary {
    pub run_id: String,
    pub chat_id: String,
    pub last_seq: u64,
    pub terminal_seq: Option<u64>,
    pub terminal_kind: Option<String>,
    pub terminal_payload: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendStatus {
    Appended,
    Duplicate,
}

#[derive(Debug)]
pub enum JournalError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidField(&'static str),
    NumericOverflow(&'static str),
    UnsupportedSchema(i64),
    EventConflict {
        run_id: String,
        seq: u64,
    },
    RunChatMismatch {
        run_id: String,
    },
    OutOfOrder {
        run_id: String,
        expected: u64,
        actual: u64,
    },
    RunAlreadyTerminated {
        run_id: String,
    },
    TerminalAlreadyCommitted {
        run_id: String,
    },
    LockPoisoned,
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(f, "SQLite journal error: {error}"),
            Self::Io(error) => write!(f, "event journal I/O error: {error}"),
            Self::Json(error) => write!(f, "journal JSON error: {error}"),
            Self::InvalidField(field) => write!(f, "invalid journal field: {field}"),
            Self::NumericOverflow(field) => write!(f, "journal value exceeds SQLite: {field}"),
            Self::UnsupportedSchema(version) => {
                write!(f, "journal schema {version} is newer than supported")
            }
            Self::EventConflict { run_id, seq } => {
                write!(f, "conflicting event for run {run_id} sequence {seq}")
            }
            Self::RunChatMismatch { run_id } => {
                write!(f, "run {run_id} is already owned by a different chat")
            }
            Self::OutOfOrder {
                run_id,
                expected,
                actual,
            } => write!(
                f,
                "out-of-order event for run {run_id}: expected {expected}, got {actual}"
            ),
            Self::RunAlreadyTerminated { run_id } => {
                write!(f, "run {run_id} already has a terminal event")
            }
            Self::TerminalAlreadyCommitted { run_id } => {
                write!(f, "run {run_id} already committed a terminal outcome")
            }
            Self::LockPoisoned => write!(f, "event journal connection lock is poisoned"),
        }
    }
}

impl std::error::Error for JournalError {}

impl From<rusqlite::Error> for JournalError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}

impl From<std::io::Error> for JournalError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for JournalError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

pub type JournalResult<T> = Result<T, JournalError>;

/// Minimal durable store for sequenced run lifecycle events.
///
/// The journal deliberately exposes no update/delete API. A run advances by
/// appending exactly the next sequence, and its first terminal append wins a
/// transactional compare-and-set in `agent_event_journal_runs`.
pub struct EventJournal {
    connection: Mutex<Connection>,
}

impl EventJournal {
    pub fn open(path: impl AsRef<Path>) -> JournalResult<Self> {
        create_private_file(path.as_ref())?;
        let connection = Connection::open(path)?;
        Self::from_connection(connection)
    }

    #[cfg(test)]
    fn open_in_memory() -> JournalResult<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(mut connection: Connection) -> JournalResult<Self> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn append(&self, event: &JournalEvent) -> JournalResult<AppendStatus> {
        self.append_inner(event, false)
    }

    pub fn append_terminal(&self, event: &JournalEvent) -> JournalResult<AppendStatus> {
        self.append_inner(event, true)
    }

    fn append_inner(&self, event: &JournalEvent, terminal: bool) -> JournalResult<AppendStatus> {
        validate_event(event)?;
        let seq = sqlite_u64(event.seq, "seq")?;
        let version = i64::from(event.version);
        let recorded_at_ms = sqlite_u64(event.recorded_at_ms, "recorded_at_ms")?;
        let payload_json = serde_json::to_string(&event.payload)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| JournalError::LockPoisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(existing) = find_event(&transaction, &event.run_id, seq)? {
            if existing == StoredEvent::from_input(event, terminal, &payload_json) {
                transaction.rollback()?;
                return Ok(AppendStatus::Duplicate);
            }
            if terminal && run_has_terminal(&transaction, &event.run_id)? {
                return Err(JournalError::TerminalAlreadyCommitted {
                    run_id: event.run_id.clone(),
                });
            }
            return Err(JournalError::EventConflict {
                run_id: event.run_id.clone(),
                seq: event.seq,
            });
        }

        transaction.execute(
            "INSERT INTO agent_event_journal_runs (run_id, chat_id, last_seq)
             VALUES (?1, ?2, 0)
             ON CONFLICT(run_id) DO NOTHING",
            params![event.run_id, event.chat_id],
        )?;

        let (stored_chat_id, last_seq, terminal_seq): (String, i64, Option<i64>) = transaction
            .query_row(
                "SELECT chat_id, last_seq, terminal_seq
                 FROM agent_event_journal_runs WHERE run_id = ?1",
                params![event.run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        if stored_chat_id != event.chat_id {
            return Err(JournalError::RunChatMismatch {
                run_id: event.run_id.clone(),
            });
        }
        if terminal_seq.is_some() {
            return Err(if terminal {
                JournalError::TerminalAlreadyCommitted {
                    run_id: event.run_id.clone(),
                }
            } else {
                JournalError::RunAlreadyTerminated {
                    run_id: event.run_id.clone(),
                }
            });
        }
        let expected = last_seq
            .checked_add(1)
            .ok_or(JournalError::NumericOverflow("last_seq"))?;
        if seq != expected {
            return Err(JournalError::OutOfOrder {
                run_id: event.run_id.clone(),
                expected: expected as u64,
                actual: event.seq,
            });
        }

        if terminal {
            let changed = transaction.execute(
                "UPDATE agent_event_journal_runs
                 SET terminal_seq = ?2, terminal_kind = ?3, terminal_payload_json = ?4
                 WHERE run_id = ?1 AND terminal_seq IS NULL",
                params![event.run_id, seq, event.kind, payload_json],
            )?;
            if changed != 1 {
                return Err(JournalError::TerminalAlreadyCommitted {
                    run_id: event.run_id.clone(),
                });
            }
        }

        transaction.execute(
            "INSERT INTO agent_event_journal_events
             (run_id, seq, version, chat_id, recorded_at_ms, kind, payload_json, is_terminal)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                event.run_id,
                seq,
                version,
                event.chat_id,
                recorded_at_ms,
                event.kind,
                payload_json,
                terminal
            ],
        )?;
        transaction.execute(
            "UPDATE agent_event_journal_runs SET last_seq = ?2 WHERE run_id = ?1",
            params![event.run_id, seq],
        )?;
        transaction.commit()?;
        Ok(AppendStatus::Appended)
    }

    pub fn fetch_after(
        &self,
        run_id: &str,
        after_seq: u64,
        limit: usize,
    ) -> JournalResult<Vec<JournalEvent>> {
        if run_id.trim().is_empty() {
            return Err(JournalError::InvalidField("run_id"));
        }
        if limit == 0 || limit > MAX_FETCH_LIMIT {
            return Err(JournalError::InvalidField("limit"));
        }
        let after_seq = sqlite_u64(after_seq, "after_seq")?;
        let limit = i64::try_from(limit).map_err(|_| JournalError::NumericOverflow("limit"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| JournalError::LockPoisoned)?;
        let mut statement = connection.prepare(
            "SELECT version, run_id, seq, chat_id, recorded_at_ms, kind, payload_json
             FROM agent_event_journal_events
             WHERE run_id = ?1 AND seq > ?2
             ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![run_id, after_seq, limit], |row| {
            let version: i64 = row.get(0)?;
            let seq: i64 = row.get(2)?;
            let recorded_at_ms: i64 = row.get(4)?;
            let payload_json: String = row.get(6)?;
            Ok((
                version,
                row.get::<_, String>(1)?,
                seq,
                row.get::<_, String>(3)?,
                recorded_at_ms,
                row.get::<_, String>(5)?,
                payload_json,
            ))
        })?;
        rows.map(|row| {
            let (version, run_id, seq, chat_id, recorded_at_ms, kind, payload_json) = row?;
            Ok(JournalEvent {
                version: u32::try_from(version)
                    .map_err(|_| JournalError::NumericOverflow("version"))?,
                run_id,
                seq: u64::try_from(seq).map_err(|_| JournalError::NumericOverflow("seq"))?,
                chat_id,
                recorded_at_ms: u64::try_from(recorded_at_ms)
                    .map_err(|_| JournalError::NumericOverflow("recorded_at_ms"))?,
                kind,
                payload: serde_json::from_str(&payload_json)?,
            })
        })
        .collect()
    }

    pub fn run_summary(&self, run_id: &str) -> JournalResult<Option<RunJournalSummary>> {
        if run_id.trim().is_empty() {
            return Err(JournalError::InvalidField("run_id"));
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| JournalError::LockPoisoned)?;
        let stored = connection
            .query_row(
                "SELECT run_id, chat_id, last_seq, terminal_seq, terminal_kind,
                        terminal_payload_json
                 FROM agent_event_journal_runs WHERE run_id = ?1",
                params![run_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;
        stored
            .map(
                |(run_id, chat_id, last_seq, terminal_seq, terminal_kind, terminal_payload)| {
                    Ok(RunJournalSummary {
                        run_id,
                        chat_id,
                        last_seq: u64::try_from(last_seq)
                            .map_err(|_| JournalError::NumericOverflow("last_seq"))?,
                        terminal_seq: terminal_seq
                            .map(u64::try_from)
                            .transpose()
                            .map_err(|_| JournalError::NumericOverflow("terminal_seq"))?,
                        terminal_kind,
                        terminal_payload: terminal_payload
                            .map(|payload| serde_json::from_str(&payload))
                            .transpose()?,
                    })
                },
            )
            .transpose()
    }

    #[cfg(test)]
    fn schema_version(&self) -> JournalResult<i64> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| JournalError::LockPoisoned)?;
        current_schema_version(&connection)
    }
}

#[derive(Debug, PartialEq)]
struct StoredEvent {
    version: i64,
    chat_id: String,
    kind: String,
    payload_json: String,
    terminal: bool,
}

impl StoredEvent {
    fn from_input(event: &JournalEvent, terminal: bool, payload_json: &str) -> Self {
        Self {
            version: i64::from(event.version),
            chat_id: event.chat_id.clone(),
            kind: event.kind.clone(),
            payload_json: payload_json.to_string(),
            terminal,
        }
    }
}

fn find_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    seq: i64,
) -> JournalResult<Option<StoredEvent>> {
    transaction
        .query_row(
            "SELECT version, chat_id, kind, payload_json, is_terminal
             FROM agent_event_journal_events WHERE run_id = ?1 AND seq = ?2",
            params![run_id, seq],
            |row| {
                Ok(StoredEvent {
                    version: row.get(0)?,
                    chat_id: row.get(1)?,
                    kind: row.get(2)?,
                    payload_json: row.get(3)?,
                    terminal: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(JournalError::from)
}

fn run_has_terminal(transaction: &Transaction<'_>, run_id: &str) -> JournalResult<bool> {
    Ok(transaction
        .query_row(
            "SELECT terminal_seq IS NOT NULL FROM agent_event_journal_runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

fn validate_event(event: &JournalEvent) -> JournalResult<()> {
    if event.version == 0 {
        return Err(JournalError::InvalidField("version"));
    }
    if event.run_id.trim().is_empty() {
        return Err(JournalError::InvalidField("run_id"));
    }
    if event.seq == 0 {
        return Err(JournalError::InvalidField("seq"));
    }
    if event.chat_id.trim().is_empty() {
        return Err(JournalError::InvalidField("chat_id"));
    }
    if event.kind.trim().is_empty() {
        return Err(JournalError::InvalidField("kind"));
    }
    Ok(())
}

fn sqlite_u64(value: u64, field: &'static str) -> JournalResult<i64> {
    i64::try_from(value).map_err(|_| JournalError::NumericOverflow(field))
}

fn migrate(connection: &mut Connection) -> JournalResult<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_event_journal_migrations (
             version       INTEGER PRIMARY KEY,
             applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms >= 0)
         );",
    )?;
    let current = current_schema_version(&transaction)?;
    if current > SCHEMA_VERSION {
        return Err(JournalError::UnsupportedSchema(current));
    }
    if current < 1 {
        let applied_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        transaction.execute_batch(MIGRATION_V1)?;
        transaction.execute(
            "INSERT INTO agent_event_journal_migrations (version, applied_at_ms)
             VALUES (1, ?1)",
            params![applied_at_ms],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn current_schema_version(connection: &Connection) -> JournalResult<i64> {
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM agent_event_journal_migrations",
        [],
        |row| row.get(0),
    )?)
}

fn create_private_file(path: &Path) -> JournalResult<()> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn event(seq: u64, kind: &str, payload: Value) -> JournalEvent {
        JournalEvent {
            version: 1,
            run_id: "run-1".to_string(),
            seq,
            chat_id: "chat-1".to_string(),
            recorded_at_ms: 1_700_000_000_000 + seq,
            kind: kind.to_string(),
            payload,
        }
    }

    #[test]
    fn migration_is_idempotent_and_rejects_future_schema() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("events.sqlite3");
        let journal = EventJournal::open(&path).expect("open journal");
        assert_eq!(journal.schema_version().expect("schema version"), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)
                    .expect("journal metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        drop(journal);
        assert_eq!(
            EventJournal::open(&path)
                .expect("reopen migrated journal")
                .schema_version()
                .expect("schema version"),
            1
        );

        let future_path = temp.path().join("future.sqlite3");
        let connection = Connection::open(&future_path).expect("future db");
        connection
            .execute_batch(
                "CREATE TABLE agent_event_journal_migrations (
                    version INTEGER PRIMARY KEY,
                    applied_at_ms INTEGER NOT NULL
                 );
                 INSERT INTO agent_event_journal_migrations VALUES (99, 0);",
            )
            .expect("future schema marker");
        drop(connection);
        assert!(matches!(
            EventJournal::open(&future_path),
            Err(JournalError::UnsupportedSchema(99))
        ));
    }

    #[test]
    fn concurrent_first_open_applies_one_migration() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = Arc::new(temp.path().join("concurrent-migration.sqlite3"));
        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    EventJournal::open(path.as_ref())
                        .map(|journal| journal.schema_version().expect("schema version"))
                })
            })
            .collect();
        barrier.wait();

        for handle in handles {
            assert_eq!(handle.join().expect("migration thread").expect("open"), 1);
        }
        assert_eq!(
            EventJournal::open(path.as_ref())
                .expect("verify journal")
                .schema_version()
                .expect("schema version"),
            1
        );
    }

    #[test]
    fn append_fetch_after_and_summary_preserve_sequence_order() {
        let journal = EventJournal::open_in_memory().expect("journal");
        for seq in 1..=3 {
            assert_eq!(
                journal
                    .append(&event(seq, "thinking", serde_json::json!({ "seq": seq })))
                    .expect("append"),
                AppendStatus::Appended
            );
        }

        let fetched = journal.fetch_after("run-1", 1, 10).expect("fetch");
        assert_eq!(
            fetched.iter().map(|item| item.seq).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(fetched[0].payload, serde_json::json!({ "seq": 2 }));
        assert_eq!(
            journal.run_summary("run-1").expect("summary"),
            Some(RunJournalSummary {
                run_id: "run-1".to_string(),
                chat_id: "chat-1".to_string(),
                last_seq: 3,
                terminal_seq: None,
                terminal_kind: None,
                terminal_payload: None,
            })
        );
    }

    #[test]
    fn duplicate_is_idempotent_but_conflicting_or_gapped_events_fail() {
        let journal = EventJournal::open_in_memory().expect("journal");
        let first = event(1, "run_started", serde_json::json!({ "run_id": "run-1" }));
        assert_eq!(
            journal.append(&first).expect("first"),
            AppendStatus::Appended
        );
        let mut replayed = first.clone();
        replayed.recorded_at_ms += 1;
        assert_eq!(
            journal.append(&replayed).expect("duplicate"),
            AppendStatus::Duplicate
        );

        let conflict = event(1, "thinking", serde_json::json!({ "different": true }));
        assert!(matches!(
            journal.append(&conflict),
            Err(JournalError::EventConflict { seq: 1, .. })
        ));
        assert!(matches!(
            journal.append(&event(3, "thinking", Value::Null)),
            Err(JournalError::OutOfOrder {
                expected: 2,
                actual: 3,
                ..
            })
        ));
    }

    #[test]
    fn identical_duplicate_rolls_back_without_mutating_event_or_summary() {
        let journal = EventJournal::open_in_memory().expect("journal");
        let first = event(1, "run_started", serde_json::json!({ "run_id": "run-1" }));
        journal.append(&first).expect("first");
        let events_before = journal.fetch_after("run-1", 0, 10).expect("events before");
        let summary_before = journal
            .run_summary("run-1")
            .expect("summary before")
            .expect("run summary before");

        let mut duplicate = first;
        duplicate.recorded_at_ms += 1;
        assert_eq!(
            journal.append(&duplicate).expect("duplicate"),
            AppendStatus::Duplicate
        );

        assert_eq!(
            journal.fetch_after("run-1", 0, 10).expect("events after"),
            events_before
        );
        assert_eq!(
            journal
                .run_summary("run-1")
                .expect("summary after")
                .expect("run summary after"),
            summary_before
        );
    }

    #[test]
    fn terminal_commit_updates_summary_and_blocks_later_events() {
        let journal = EventJournal::open_in_memory().expect("journal");
        journal
            .append(&event(1, "run_started", serde_json::json!({})))
            .expect("start");
        let terminal = event(
            2,
            "run_terminated",
            serde_json::json!({ "outcome": { "kind": "completed" } }),
        );
        assert_eq!(
            journal.append_terminal(&terminal).expect("terminal"),
            AppendStatus::Appended
        );
        assert_eq!(
            journal
                .append_terminal(&terminal)
                .expect("terminal duplicate"),
            AppendStatus::Duplicate
        );
        let summary = journal
            .run_summary("run-1")
            .expect("summary")
            .expect("run summary");
        assert_eq!(summary.last_seq, 2);
        assert_eq!(summary.terminal_seq, Some(2));
        assert_eq!(summary.terminal_kind.as_deref(), Some("run_terminated"));
        assert_eq!(summary.terminal_payload, Some(terminal.payload.clone()));
        assert!(matches!(
            journal.append(&event(3, "thinking", Value::Null)),
            Err(JournalError::RunAlreadyTerminated { .. })
        ));
        assert!(matches!(
            journal.append_terminal(&event(3, "run_terminated", Value::Null)),
            Err(JournalError::TerminalAlreadyCommitted { .. })
        ));
    }

    #[test]
    fn concurrent_terminal_race_commits_exactly_one_outcome() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("race.sqlite3");
        EventJournal::open(&path)
            .expect("seed journal")
            .append(&event(1, "run_started", serde_json::json!({})))
            .expect("seed event");
        let journal_a = EventJournal::open(&path).expect("journal a");
        let journal_b = EventJournal::open(&path).expect("journal b");
        let barrier = Arc::new(Barrier::new(3));
        let barrier_a = barrier.clone();
        let barrier_b = barrier.clone();
        let handle_a = std::thread::spawn(move || {
            barrier_a.wait();
            journal_a.append_terminal(&event(
                2,
                "run_terminated",
                serde_json::json!({ "winner": "a" }),
            ))
        });
        let handle_b = std::thread::spawn(move || {
            barrier_b.wait();
            journal_b.append_terminal(&event(
                2,
                "run_terminated",
                serde_json::json!({ "winner": "b" }),
            ))
        });
        barrier.wait();
        let outcomes = [
            handle_a.join().expect("thread a"),
            handle_b.join().expect("thread b"),
        ];

        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, Ok(AppendStatus::Appended)))
                .count(),
            1
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(
                    outcome,
                    Err(JournalError::TerminalAlreadyCommitted { .. })
                ))
                .count(),
            1
        );
        let summary = EventJournal::open(&path)
            .expect("verify journal")
            .run_summary("run-1")
            .expect("summary")
            .expect("run summary");
        assert_eq!(summary.terminal_seq, Some(2));
    }
}
