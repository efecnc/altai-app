# ALTAI Claw Implementation Plan

> Status: active
>
> Started: 2026-07-20
>
> IsanAgent baseline:
> `c8fed807343f56605a238893610027ac39571919`

## Delivery rule

Implementation follows one strict dependency rule:

1. If the capability and a safe embedding contract already exist in
   IsanAgent, integrate them directly into ALTAI.
2. If the capability is missing, or its existing contract cannot preserve
   ALTAI's identity, permission, lifecycle, and completion invariants, prepare
   a focused PR against `altaidevorg/isanagent`.
3. Do not implement a temporary competing runtime in ALTAI.
4. Merge the IsanAgent PR, pin ALTAI to the merged immutable revision, then
   implement the ALTAI adapter and UI.

The temporary `efecnc/isanagent` dependency is only the currently pinned
baseline. New upstream work targets `altaidevorg/isanagent`.

## Definition of parity

A capability is not complete merely because its tool name appears in the
model's catalogue. It is complete only when:

- exactly one correct owner controls its lifecycle;
- its data is stored at the intended workspace/session scope;
- every event is routed to the correct ALTAI conversation;
- cancellation and app/workspace shutdown are handled;
- the UI can observe and operate the capability;
- permission and destination authority cannot come from untrusted model text;
- focused and unfocused conversations behave correctly;
- restart/recovery behavior is tested where the IsanAgent contract supports it.

## Workstream A — Existing IsanAgent capability parity

### A0. Dependency-only tools

These capabilities already have public IsanAgent contracts and do not own
long-running actors.

| Capability | Integration | State |
| --- | --- | --- |
| `search_memory` | Register with the shared workspace memory node | Implemented |
| `fetch_memory_by_date` | Register with the shared workspace memory node | Implemented |
| `search_tools` | Register last from `ToolRegistry::catalog_handle()` | Implemented |
| `ask_user` | Register with the same `ClarificationHub` used by `AgentLogic` | Implemented |
| `git_worktree` | Register only when IsanAgent config enables it | Implemented |
| Kernel-porting tools | Register only when IsanAgent config enables them | Implemented |

Additional ALTAI work included in this step:

- pending clarifications are keyed by ALTAI session/chat ID;
- an `ask_user` event from an unfocused conversation is retained instead of
  being dropped by the active-chat filter;
- switching to that conversation restores its choices and edit-diff card;
- replying clears only that conversation's pending clarification.

Validation:

- registry test for the Claw parity tools;
- session-isolation tests for pending clarifications;
- Rust compile/test and frontend type/test checks.

### A1. Persistent notification, ticket, and job access

IsanAgent already persists notifications, background-job records, and
clarification tickets through `MemoryMessage`.

State: implemented against the pinned IsanAgent baseline.

Delivered:

1. Added typed Rust DTOs rather than exposing raw memory actor messages.
2. Omitted job payloads, raw action payloads, channel/thread selectors, and
   internal tool-call IDs from the frontend contract.
3. Added bounded memory-actor requests and Tauri channel/root-thread filtering.
4. Required and verified the owning chat before every ID-based mutation;
   unknown, cross-chat, and cross-channel IDs fail closed.
5. Added Tauri commands for:
   - notification list;
   - mark seen;
   - resolve/dismiss;
   - background-job list and status;
   - clarification-ticket list and dismissal.
6. Registered the commands in `src-tauri/src/lib.rs`.
7. Added typed wrappers in `src/modules/ai/lib/native.ts`.
8. Added a workspace inbox store, attention badge, panel, loading/error states,
   and safe notification/job/ticket cards.
9. Kept background ticket responses passive: dismissal is available only for a
   waiting job, while direct replies wait for an exactly-once runtime-resume
   contract in A2/I4.
10. Required an explicit, authorized workspace path before the renderer can
    query persisted inbox data.

Remaining follow-up:

1. Reconcile all live notification/job telemetry with persisted state once the
   upstream event contract is complete.
2. Add a safe direct ticket reply after the runtime dispatcher and upstream
   recovery contract are available. **Implemented:** ALTAI validates the
   workspace/Tauri-root ticket identity, then sends a trusted synthetic reply
   only through the workspace dispatcher. IsanAgent atomically claims the
   waiting ticket before resuming its job.

Direct persisted-ticket replies are deliberately deferred to A2. IsanAgent's
memory-only resolve calls do not resume reasoning; a safe reply must be
delivered exactly once to the single owning runtime. Broadcasting to all
model/persona instances can duplicate the resumed turn.

Former pinned-contract limitation (resolved upstream):

- IsanAgent list queries do not filter by channel and are capped at 500 rows.
  ALTAI fetches that maximum, filters to Tauri root records, and applies the
  requested limit. The merged IsanAgent contract now applies ALTAI's trusted
  `tauri` channel filter before the SQL limit. Cursor pagination remains a
  later upstream requirement.

Completion gate:

- a question raised by an unfocused/background run remains visible and
  actionable after switching chats;
- persisted tickets survive app restart;
- resolving one ticket cannot resolve a different session's ticket;
- notification and job queries cannot cross the active workspace.

### A2. Workspace service ownership

Cron and reflection must not be constructed inside the current
per-model/persona `build_instance` function.

Introduce a workspace-owned service record containing:

```text
WorkspaceServices
├── memory_node
├── logger_tx + retained logger receiver/forwarder
├── stable ingress dispatcher
├── chat_id -> RuntimeFingerprint ownership map
├── cron_node
├── reflection shutdown/task
└── channel supervisor
```

Deliverables:

1. Replace `memory_by_workspace` with a workspace service registry. **Implemented.**
2. Retain the IsanAgent logger receiver instead of dropping it. **Implemented.**
3. Forward safe logger telemetry to a workspace event stream.
4. Record chat ownership on every successful send. **Implemented.**
5. Route synthetic cron/background inbound messages through a stable
   workspace dispatcher to the owning runtime instance. **Implemented as a
   fail-closed ingress foundation; the ticket-resume adapter is now
   implemented.** Cron remains the next adapter.
6. Define teardown for workspace switches and application shutdown.
   **Workspace-switch teardown implemented:** old instance router and outbound
   tasks are joined with a bounded timeout and aborted only as a last resort;
   shared services drop after those tasks release their logger/memory handles.
7. Prevent duplicate service creation under concurrent instance startup.

Upstream dependencies now integrated:

- [isanagent#66](https://github.com/altaidevorg/isanagent/pull/66) makes a
  waiting clarification ticket a transactionally claimed, one-shot resume
  trigger.
- [isanagent#67](https://github.com/altaidevorg/isanagent/pull/67) binds cron
  add/list/remove operations to the trusted tool runtime session.

Completion gate:

- concurrent starts create one service record per workspace;
- service creation is race-tested;
- switching model/persona does not duplicate cron or reflection;
- teardown stops all tasks without leaking bus senders;
- one workspace cannot route a synthetic event into another workspace.

### A3. Cron and automations

State: backend foundation implemented; direct automation-management UI remains
next.

Reuse:

- `CronActor`;
- `CronTool`;
- `CronStore`;
- local scheduling and persisted missed-run behavior;
- synthetic background metadata.

ALTAI integration:

1. Start exactly one local `CronActor` per workspace. **Implemented.**
2. Give it the stable workspace ingress dispatcher. **Implemented.** Invalid,
   cross-channel, or subthread destinations fail closed.
3. Wrap `CronTool` so add/remove/list operations are scoped to the current
   workspace and origin conversation. **Implemented via IsanAgent #67.**
4. Do not accept arbitrary model-selected channel/chat destinations.
5. Add schedule list/add/remove Tauri commands for direct UI use.
6. Add an Automations store and panel.
7. Surface next run, last run, state, owner conversation, and failure.
8. Route a triggered job to its persisted owner runtime. **Implemented for a
   live owner; after restart, the persisted running job is recovered once when
   its chat next binds an explicit runtime configuration.**
9. Terminate the actor explicitly on workspace service teardown.

Completion gate:

- a persisted one-shot schedule fires once;
- a repeating schedule does not double-fire with multiple model instances;
- restart catch-up behavior matches IsanAgent;
- removing a schedule prevents future delivery;
- the model cannot list/remove another workspace's schedules;
- every trigger has a deterministic owning conversation.

### A4. Reflection and memory

Reuse:

- `ReflectionEngine`;
- short-term summary generation;
- long-term `MEMORY.md` consolidation;
- existing memory configuration.

ALTAI integration:

1. Start one reflection engine per workspace only when enabled.
2. Create a dedicated reflection provider instance.
3. Pass `workspace.sandbox_dir`, matching IsanAgent's prompt compiler and
   `MEMORY.md` location.
4. Retain a watch shutdown sender and join handle.
5. Bridge reflection telemetry from the retained logger channel.
6. Add reflection status and memory-summary views.
7. Show that memory search currently covers SQLite summaries, not arbitrary
   full transcript text or `MEMORY.md`.

Completion gate:

- two ALTAI model instances cannot reflect the same workspace concurrently;
- short-term summaries appear once;
- long-term reflection writes the file read by `compile_system_prompt`;
- engine shutdown is clean;
- disabled reflection makes no provider calls.

### A5. Existing telemetry parity

Map IsanAgent telemetry without treating global events as active-chat events:

- notification created/updated;
- reflection started/completed;
- compaction triggered/completed/failed;
- background job lifecycle;
- shell policy decisions;
- research-depth nudges;
- tool-result refetch;
- cron trigger only after deterministic routing is available.

Rules:

- chat-scoped events use the ALTAI session ID;
- stored IsanAgent thread keys such as `tauri:<id>:` are normalized;
- workspace-global reflection events use a workspace event surface;
- a missing chat ID must never fall through into whichever chat is focused.

### A6. Existing channel adapters

IsanAgent already implements Slack, email, and loopback API channel
primitives. They are not immediately safe to expose as a Claw gateway.

After the upstream gates below merge:

1. Add a workspace channel supervisor.
2. Store channel credentials in the OS keychain.
3. Start Slack Socket Mode first.
4. Route every inbound through binding, sender authorization, rate limiting,
   mention policy, and capability selection.
5. Route outbound only through origin-bound delivery handles.
6. Add health, disconnect, revoke, and audit UI.
7. Add email and API only after their sender/authentication policies meet the
   same contract.

## Workstream B — Required IsanAgent PRs

These changes must merge upstream before the dependent ALTAI feature is
enabled.

### PR I1 — Explicit run completion and outbound kind

Problem:

- `MessageTool` progress output and a final assistant answer are both plain
  `OutboundMessage`;
- ALTAI currently treats an assistant message as run completion.

Required contract:

- run ID;
- explicit terminal `Done`/`Error` event;
- outbound kind such as `intermediate`, `clarification`, `notification`, or
  `final`;
- serialization and compatibility tests.

Unlocks:

- proactive `message`;
- correct background-run status;
- reliable external-channel progress.

### PR I2 — Origin-bound destination authority

Problem:

- `MessageTool` and `CronTool` accept model-selected channel/chat IDs;
- cron list/remove operations are workspace-global.

Required contract:

- trusted invocation origin supplied by the host;
- opaque/bound delivery destination;
- owner scope for cron CRUD;
- model schema without arbitrary destination identifiers;
- cross-session and cross-workspace denial tests.

Unlocks:

- safe proactive delivery;
- safe cron tool registration;
- external-channel delivery.

### PR I3 — Embedding/runtime assembly API

Problem:

- IsanAgent's binary manually assembles standard tools, logger, scheduler,
  reflection, execution, and channels;
- embedders must reproduce `main.rs`, causing drift.

Required contract:

- reusable runtime/service builder;
- capability manifest;
- lifecycle handles;
- channel registration;
- host-provided adapters for policy, storage, and event delivery;
- reference binary migrated to the same builder.

Unlocks:

- removal of duplicated assembly from ALTAI;
- parity tests against one canonical manifest.

### PR I4 — Background-job service and recovery facade

Problem:

- important background orchestration and recovery behavior is private to the
  standalone binary;
- ALTAI assignments are ordinary chat turns, not IsanAgent background jobs.

Required contract:

- public create/list/cancel/resume/recover service;
- durable state transition rules;
- clarification-ticket resume API;
- idempotency and restart tests.

Unlocks:

- reconciliation of ALTAI assignments with IsanAgent jobs;
- restart-safe autonomous work.

### PR I5 — Cron telemetry and lifecycle contract

Problem:

- `CronTrigger` lacks channel/chat/thread/background-job identity;
- actor shutdown has no high-level public handle.

Required contract:

- fully routable trigger event;
- explicit scheduler lifecycle handle;
- trigger/finalization correlation;
- delivery and restart tests.

Unlocks:

- deterministic automation UI and audit.

### PR I6 — Reflection completeness

Required changes:

- enforce `long_term_interval_mins`;
- add reflection failure telemetry;
- expose a manual trigger/status API;
- define live `MEMORY.md` refresh for existing agent instances;
- prevent duplicate reflection claims.

Unlocks:

- complete Memory UI and live long-term memory behavior.

### PR I7 — External-channel authorization

Required changes:

- pairing/allowlists;
- normalized account/peer/thread identity;
- default-deny group/DM policy;
- request deduplication and limits;
- origin-bound capability context;
- secret-safe telemetry.

Unlocks:

- Slack beta, then email/API.

### PR I8 — Multi-tenant memory scope

Required changes:

- workspace + principal/binding provenance on summaries and long-term recall;
- filtered search/date recall;
- migration and cross-identity isolation tests.

Unlocks:

- external multi-user access.

### PR I9 — Execution and tool-policy hardening

Required changes:

- route `python_run` through the same execution/approval policy as shell;
- stop inheriting the complete host environment by default;
- replace key-name-only environment masking with allowlisted exposure;
- fix empty sub-agent allowlist semantics so an explicit empty list means no
  tools;
- keep hook-based authorization fail-closed where hooks are enforcement.

Unlocks:

- safe parity for `python_run`, `get_env`, and unattended external execution.

### PR I10 — Opaque root chat IDs and scoped inbox queries

Problem:

- IsanAgent's root-thread parser currently requires a UUID, while ALTAI uses
  opaque IDs such as `s-...`;
- persisted notification, job, and ticket list messages cannot filter by
  channel and expose only a capped result window;
- ID-based mutations do not report a missing target.

Required contract:

- treat host chat IDs as bounded opaque strings when composing/parsing root
  thread keys;
- add channel/thread-scoped, cursor-paginated inbox queries;
- add get-by-ID methods where absent;
- return a not-found/ownership-safe result for mutation targets;
- compatibility, pagination, and cross-channel tests.

Unlocks:

- reliable backend session reconciliation for ALTAI IDs;
- complete workspace inboxes without exposing another channel;
- simpler fail-closed mutation adapters.

Merged upstream:

- [PR #64](https://github.com/altaidevorg/isanagent/pull/64) implements the
  opaque, bounded root chat-ID parser and regression tests.
- [PR #65](https://github.com/altaidevorg/isanagent/pull/65) adds an optional
  channel filter to notification/job/ticket list queries, applied before their
  SQL limit. ALTAI is pinned to merge commit
  `c8fed807343f56605a238893610027ac39571919`, which contains both PRs.
  Cursor pagination and mutation outcomes remain follow-up work.

## PR and merge workflow

For each upstream requirement:

1. create one focused branch in the IsanAgent repository;
2. add the contract and regression tests first;
3. run the full IsanAgent suite;
4. open a PR against `altaidevorg/isanagent`;
5. record the PR URL and dependent ALTAI task in this document;
6. do not point ALTAI at an unreviewed moving branch;
7. after merge, pin the immutable merge revision in
   `src-tauri/Cargo.toml`;
8. update `Cargo.lock`;
9. implement the ALTAI adapter;
10. run Rust, frontend, isolation, and recovery tests.

## Implementation sequence

| Step | Work | Repository | Dependency | State |
| --- | --- | --- | --- | --- |
| 1 | Memory/date/tool-search parity | ALTAI | Existing API | Implemented |
| 2 | Session-scoped foreground clarification | ALTAI | Existing API | Implemented |
| 3 | Notification/job/ticket commands and inbox | ALTAI | Existing API | Implemented |
| 4 | Workspace service registry and logger bridge | ALTAI | Existing API | In progress |
| 5 | Cron singleton, dispatcher, commands, UI | ALTAI | Existing API + I2/I5 for model tool | Planned |
| 6 | Reflection singleton, status, Memory UI | ALTAI | Existing API; I6 for full parity | Planned |
| 7 | Explicit completion/outbound kinds | IsanAgent | I1 | Upstream PR |
| 8 | Enable proactive `message` | ALTAI | I1 + I2 merged | Blocked |
| 9 | Durable job/assignment reconciliation | ALTAI | I4 merged | Blocked |
| 10 | Slack developer beta | ALTAI | I1, I2, I7 merged | Blocked |
| 11 | Email/API channels | ALTAI | I7 merged | Blocked |
| 12 | Multi-user memory | ALTAI | I8 merged | Blocked |

## Current implementation changes

The first implementation slice modifies:

- `src-tauri/src/altai/agent/runtime.rs`
  - registers memory search and date recall;
  - registers general `ask_user`;
  - registers tool discovery last;
  - mirrors config-gated worktree and kernel tools;
  - exposes filtered, ownership-checked notification/job/ticket facades;
  - adds a focused registry test.
- `src-tauri/src/altai/agent/commands.rs` and `src-tauri/src/lib.rs`
  - expose and register the safe persisted-inbox command surface.
- `src/modules/ai/lib/native.ts`
  - defines redacted inbox DTOs and typed command wrappers.
- `src/modules/ai/store/chatStore.ts`
  - stores pending clarifications by session;
  - restores the active projection on session switch;
  - isolates reply/reset behavior.
- `src/modules/ai/lib/agentEventBridge.ts`
  - captures clarification events before the active-chat filter;
  - persists questions for unfocused conversations.
- `src/modules/ai/store/notificationStore.ts` and
  `src/modules/ai/components/NotificationInboxPanel.tsx`
  - hydrate and render redacted persisted inbox records;
  - invalidate on safe notification events;
  - prevent ambiguous direct ticket replies and running-job dismissal.
- `src/modules/ai/store/chatStore.test.ts`
  - covers unfocused retention, switch restoration, and isolated clearing.

`MessageTool`, cron, reflection, and external channels are intentionally not
enabled by this slice because their lifecycle or protocol gates are not yet
satisfied.

## Validation commands

```bash
pnpm test -- --run
pnpm exec tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib altai::agent::
```

Before a release candidate:

```bash
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

## Immediate next task

Finish the A1 inbox/store and its isolation tests, then begin the A2
workspace-service registry and retained logger bridge.
