# Plan: Context Condensing + `.isanagentignore` for ALTAI

Scope locked with the user: **only** these two features. Codebase Indexing is **out**.

Mirrors the Kilo docs:
- https://kilo.ai/docs/customize/context/context-condensing
- https://kilo.ai/docs/customize/context/kilocodeignore

---

## 0. Architecture findings (read before implementing)

ALTAI is Tauri 2 (Rust + React 19). The agent loop runs inside the **embedded `isanagent` crate** (git-pinned at `f8533f3…` in `src-tauri/Cargo.toml`). TS sends one user message per turn via `agent_send`; the crate owns the model context + history (SQLite memory DB at `<workspace>/.isanagent`).

### What already exists (do NOT rebuild)
- **Native compaction engine in isanagent**, already wired:
  - `CompactContextTool` + `RecallToolResultTool` registered at `src-tauri/src/altai/agent/runtime.rs:791-797`.
  - `AgentLogicParams` takes compaction knobs at `runtime.rs:1001-1003`, **currently hardcoded**:
    `max_recent_summaries: 5`, `short_term_threshold_turns: 20`, `short_term_threshold_tokens: 100_000`.
- **Frontend already renders** `compact_context` / `recall_tool_result` tool entries (`src/components/ai-elements/tool.tsx:88-94, 187-189`).
- **Token usage meter**: `agentMeta.tokens` / `lastInputTokens` fed by the `usage` event (`agentEventBridge.ts:207-223`).
- **Context limits**: `MODEL_CONTEXT_LIMITS` in `src/modules/ai/config.ts:712`.
- **Token counter dep**: `tokenlens` already in `package.json`.
- **fs uses the `ignore` crate**: every walker in `src-tauri/src/modules/fs/{search,grep}.rs` builds `ignore::WalkBuilder` with `.git_ignore(true).ignore(true).parents(true)`. `WalkBuilder::add_custom_ignore_filename()` is the clean hook for `.isanagentignore`.

### Critical boundary facts
- The **agent's own file tools** (`ReadFileTool`, `ListDirTool`, `GlobFilesTool`, `SearchTextTool`) live **inside isanagent** (`runtime.rs:693-719`) and operate directly on `sandbox_dir` — they do **not** call altai's `fs_*` Tauri commands. So altai's `fs_*` commands are used by the **editor / explorer / command-palette search / TS-side features**, not by the agent.
- `AgentLogicParams` is a **public struct** altai already constructs in `build_instance` → compaction knobs can be threaded from prefs **without a crate change**.
- Compaction config is read at instance construction (`build_instance`). Changing it must rebuild the instance — we reuse the existing TS-side `lastStartFingerprint` mechanism (`chatStore.ts:870-899`) by adding compaction to the fingerprint.

### Dependency-pin reality (read before the isanagent workstream)
- **Canonical upstream is `altaidevorg/isanagent`** (per README). altai-app currently pins a *temporary* fork — `Cargo.toml` points at `efecnc/isanagent @ f8533f3…`, carrying `altaidevorg/isanagent#58` ("forbid-final nudge"). The Cargo.toml comment says: *"Revert to altaidevorg/main once that PR merges."*
- **All isanagent-side work in this plan targets `altaidevorg/isanagent`** (opened as PRs there), **never** the `efecnc` fork.
- Consumption order in altai-app:
  1. `altaidevorg/isanagent#58` merges to `main` → revert `Cargo.toml` to `altaidevorg/isanagent`.
  2. The new PRs from this plan (see Feature 2 Tier 2) merge to `main` → bump `Cargo.toml` `rev` to that commit.
  - If the new PRs land **before** #58, they must (temporarily) also be carried in the `efecnc` fork alongside #58 until #58 merges upstream — then altai-app moves to altaidevorg. This is the same pattern the codebase already uses.

---

## Feature 1 — Context Condensing

Goal: make the existing isanagent compaction engine **configurable**, add a **manual `/compact`** trigger, run a **TS-side prune** on the displayed/persisted transcript, surface a **context-usage indicator**, honor **env overrides**, and add a **Settings UI**.

### 1.1 Preferences (TS)
File: `src/modules/settings/store.ts`.

Add a `CompactionPrefs` block to the `Preferences` type and `DEFAULT_PREFERENCES`:

| Field | Key | Type | Default | Maps to (isanagent) |
|---|---|---|---|---|
| `compactionAuto` | `compactionAuto` | bool | `true` | enables engine (see 1.2) |
| `compactionThresholdPercent` | `compactionThresholdPercent` | number? | `undefined` | → `short_term_threshold_tokens` = `percent/100 * modelContextLimit` |
| `compactionThresholdTokens` | `compactionThresholdTokens` | number | `100_000` | → `short_term_threshold_tokens` (used when percent unset) |
| `compactionTailTurns` | `compactionTailTurns` | number | `5` | → `max_recent_summaries` |
| `compactionPrune` | `compactionPrune` | bool | `true` | gates TS prune pass (1.4) |
| `compactionPruneRecencyTokens` | `compactionPruneRecencyTokens` | number | `40_000` | TS prune recency window |

Notes:
- Add each `KEY_*` constant, a `set*` setter (mirror existing `writePref` pattern), and entries in the `onPreferencesChange` key map and `loadPreferences`.
- **Env overrides** (Kilo parity): in `loadPreferences`, when `import.meta.env`/`process.env` exposes `ALTAI_DISABLE_AUTOCOMPACT=1` force `compactionAuto=false`; `ALTAI_DISABLE_PRUNE=1` forces `compactionPrune=false`. Tauri exposes env via `@tauri-apps/plugin-os`/shell env — read once at boot through a tiny `invoke` or `process.env` shim; if unavailable, skip silently.

### 1.2 Thread prefs into isanagent (Rust)
Files: `src-tauri/src/altai/agent/commands.rs`, `runtime.rs`.

- Add a `CompactionArg` struct (`#[serde(rename_all = "camelCase")]`: `auto, threshold_tokens, tail_turns`) to `commands.rs`; thread it through `agent_start` and `agent_send` as a new `Option<CompactionArg>` param (extend the `#[allow(clippy::too_many_arguments)]` arg lists — already the established pattern).
- In `runtime.rs`:
  - Extend `RuntimeFingerprint` with a `compaction: Option<(bool, usize, usize)>` field so a setting change rebuilds the instance on next send (reuse existing fingerprint machinery — do NOT hand-roll teardown).
  - In `build_instance`, accept compaction params and compute:
    ```
    let max_recent_summaries = compaction.tail_turns;          // default 5
    let short_term_threshold_turns = 20;                        // keep crate default
    let short_term_threshold_tokens =
        compaction.threshold_tokens.max(8_000);                 // default 100_000
    ```
    When `compaction.auto == false`, set `short_term_threshold_tokens = usize::MAX` (effectively disables auto-compaction while keeping manual `/compact` working).
  - `ensure_instance` / `route_send` / `start_agent` carry the new field end-to-end.
- TS side (`chatStore.ts` `sendViaIsanAgent` / `dispatchToSession`, `native.agentStart` / `native.agentSend`): read `usePreferencesStore` compaction fields, compute `thresholdTokens` (percent→tokens using `getModelContextLimit(selectedModelId)`), add to the `config` object and to `lastStartFingerprint`.

> No isanagent fork required: `AgentLogicParams` is public and already constructed by altai.

### 1.3 Manual `/compact` slash command
File: `src/modules/ai/lib/slashCommands.ts`.

- Register `compact` in `SLASH_COMMANDS` (icon: `Archive02Icon`, label "Compact context") — also matchable via `smol` / `condense` aliases (Kilo parity).
- In `tryRunSlashCommand`, add a `case "compact"` (and alias cases) returning:
  ```ts
  { kind: "send-prompt",
    prompt: "Run the compact_context tool now to summarize our conversation history so far, keeping the most recent turns intact. Do not ask for confirmation — compact immediately.",
    commandName: "compact" }
  ```
  This routes through the existing send flow; the model invokes the already-registered `CompactContextTool`, which renders in the transcript via tool.tsx.
- Also expose a compact icon button in the chat header (`AiStatusBarControls.tsx` or `AiChat.tsx` header) that calls `focusInput("/compact\n")` or dispatches directly — single visible entry point (Kilo parity: "task header button").

### 1.4 TS-side prune pass (display + persistence)
New file: `src/modules/ai/lib/compaction.ts`.

- `pruneOldToolOutputs(messages: UIMessage[], recencyTokens: number): UIMessage[]`
  - Walk messages **oldest-first**; for each completed `dynamic-tool` part whose `output` is beyond the trailing `recencyTokens` budget, replace its output with `{ cleared: true }` and render text `"[Old tool result content cleared]"`. Keep tool-call input + the most recent turns verbatim.
  - Token budget via `tokenlens` (already a dep). Pure function — unit-testable.
- Hook into the store: in `agentEventBridge.ts`, on the `done` event, if `prefs.compactionPrune`, call `useChatStore.getState()` → run prune over `nativeMessages` → `set({ nativeMessages })` (the existing persistence subscription at `chatStore.ts:759-773` debounces the write). Guard so it runs at most once per turn and never prunes the live in-flight turn.
- This is **display/persistence only** — it shrinks the DOM and the on-disk `altai-ai-sessions.json`. The model's own context is the runtime's responsibility (its native compaction already prunes).

### 1.5 Context-usage indicator
File: `src/modules/ai/components/AiStatusBarControls.tsx` (or `AiChat.tsx` header).

- Compute `usagePct = agentMeta.tokens.inputTokens / getModelContextLimit(selectedModelId) * 100`.
- Render a compact ring/bar + `%`. When `usagePct >= thresholdPercent` (or ≥ 90% if unset) and `compactionAuto`, show an "auto-compacting" hint; if auto is off, show a "Compact now" affordance that fires `/compact`.

### 1.6 Settings UI — new "Context" tab
Files: `src/modules/settings/openSettingsWindow.ts`, `src/settings/SettingsContent.tsx`, new `src/settings/sections/ContextSection.tsx`.

- Add `"context"` to the `SettingsTab` union.
- Register the tab in `SettingsContent.tsx` `TABS` (icon: `AiScanIcon` or `LayersIcon`).
- `ContextSection.tsx` renders:
  - **Context Condensing** card: toggles (`compactionAuto`, `compactionPrune`) + number inputs (`compactionThresholdPercent` optional, `compactionThresholdTokens`, `compactionTailTurns`, `compactionPruneRecencyTokens`) with a short description per field (mirroring the Kilo docs table). A "Compact now" button (calls `/compact` in the focused chat).
  - **`.isanagentignore`** card (see Feature 2.7) — grouped under the same tab since both are "context" controls.

---

## Feature 2 — `.isanagentignore`

### 2.1 Shared ignore helper (Rust)
New file: `src-tauri/src/modules/fs/isanagentignore.rs`.

- `pub const IGNORE_FILENAME: &str = ".isanagentignore";`
- `pub fn load_matcher(workspace_root: &Path) -> Arc<Mutex<Option<Gitignore>>>` — builds an `ignore::gitignore::Gitignore` from `<workspace_root>/.isanagentignore` (root-level, per Kilo spec), cached in a process-global with mtime invalidation. Returns a matcher usable by single-path commands.
- Register in `fs/mod.rs` (`pub mod isanagentignore;`).
- Resolve workspace root via the existing `workspace` module (`resolve_workspace_root` / current workspace folder).

### 2.2 Walker commands (automatic enforcement)
Files: `src-tauri/src/modules/fs/{search,grep}.rs` (`fs_search`, `fs_list_files`, `fs_grep`, `fs_glob`).

- On **every** `WalkBuilder`, add `.add_custom_ignore_filename(isanagentignore::IGNORE_FILENAME)`. The `ignore` crate then honors `.isanagentignore` at any depth (combined with existing `.parents(true)`), identical to `.gitignore` semantics.
- This affects: editor "find in files", file-explorer search, command-palette file search, and any TS-side walker call. **One-line change per builder.**

### 2.3 Single-path commands (opt-in enforcement)
Files: `src-tauri/src/modules/fs/file.rs` (`fs_read_file`, `fs_stat`, `fs_write_file`), `mutate.rs` (`fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_delete`).

- Add `enforce_isanagentignore: Option<bool>` param to each. When `Some(true)`, resolve the path to its workspace root, run the matcher (2.1), and return `Err("blocked by .isanagentignore: <path>")` if denied. Default `None`/`false` = current behavior unchanged (user's editor opens are not gated — matches Kilo's "only affects the agent" contract).
- **Why opt-in**: these commands serve both the editor (user opens) and TS-side features. Gating always-on would prevent the user from opening their own ignored files in the editor.

### 2.4 Thread opt-in through agent-facing TS wrappers
File: `src/modules/ai/lib/native.ts`.

- Add an optional `enforceIsanagentignore?: boolean` to the relevant `native.*` calls (`readFile`, `stat`, `writeFile`, etc.) and pass it to `invoke` as `enforceIsanagentignore`. Editor/explorer call sites continue to omit it (preserving user access).

### 2.5 Watcher
File: `src-tauri/src/modules/fs/watch.rs`.

- When a change event arrives, check the matcher (2.1); if the path is ignored, skip emitting `fs://changed` so ignored subtrees don't trigger refresh storms (Kilo `watcher.ignore` parity, scoped to `.isanagentignore`).

### 2.6 Tauri commands for the file (Settings UI)
Files: `src-tauri/src/modules/fs/isanagentignore.rs` (+ register in `lib.rs` `invoke_handler!`), `native.ts`.

- `fs_get_isanagentignore(workspace) -> Option<String>` — reads `<workspace>/.isanagentignore` (`None` if absent).
- `fs_set_isanagentignore(workspace, content)` — atomic write (reuse `write_atomic` from `file.rs`), then invalidate the cached matcher (2.1) so enforcement picks up edits immediately.

### 2.7 Settings UI (in the Context tab — see 1.6)
- In `ContextSection.tsx`, a `.isanagentignore` card: read via `fs_get_isanagentignore`, edit in a `<textarea>`, save via `fs_set_isanagentignore`. Include a short pattern-syntax reference (mirrors Kilo: `#` comment, `*`/`**`, trailing `/`, `!` negation) and a note that it applies to altai's file access (editor search/explorer/TS-side); full agent-tool enforcement is Tier 2.

### 2.8 Tier 2 — agent-tool enforcement (workstream in `altaidevorg/isanagent`)

Full Kilo parity (the **agent itself** cannot read/list/search ignored files) requires changes inside the isanagent crate. These are **PRs to `altaidevorg/isanagent`**, not the `efecnc` fork (see "Dependency-pin reality" in §0).

**PR A — `.isanagentignore` enforcement in agent tools** (`altaidevorg/isanagent`):
- Add a shared helper (mirror of 2.1) in the crate: a constant `ISANAGENTIGNORE_FILENAME = ".isanagentignore"` + a matcher builder reading the workspace-root `.isanagentignore`, cached with mtime invalidation.
- `GlobFilesTool` / `SearchTextTool` (and any internal walker): call `.add_custom_ignore_filename(ISANAGENTIGNORE_FILENAME)` on their `WalkBuilder`.
- `ReadFileTool` / `ListDirTool`: before reading/listing, check the path against the matcher; on match, return a clear tool error (e.g. `"blocked by .isanagentignore"`) so the model learns the path is off-limits.
- Respect `!` negation + nested `.isanagentignore` semantics via the `ignore` crate (already an isanagent dependency through its search stack).
- Add unit tests (deny / allow / negation / nested).

**PR B (optional, only if we want full Kilo knob parity) — compaction engine exposure** (`altaidevorg/isanagent`):
- Expose `reserved` (next-turn headroom), `preserve_recent_tokens` (verbatim tail budget), and a **dedicated compaction model** (separate provider/model for summarization) in `AgentLogicParams` / the crate's compaction path.
- Until this lands, altai-app maps what it can via the public `AgentLogicParams` fields (1.2) and the rest stays TS-side or absent.

**altai-app consumer side** (after PR A merges upstream):
- Bump `Cargo.toml` `isanagent.rev` to the merged commit (and drop the `efecnc` fork pin once #58 is also upstream).
- The opt-in `enforce_isanagentignore` plumbing in 2.3/2.4 can stay as defense-in-depth (editor/TS-side), but the agent is now enforced by the crate directly.

> This plan implements Tier 1 (altai-app fs + watcher + UI) fully in-app; Tier 2 is the `altaidevorg/isanagent` PR workstream above. State the Tier 1/Tier 2 split honestly in the Settings UI note and the changelog.

---

## Files touched (summary)

**Rust (`src-tauri/`):**
- `src/modules/fs/isanagentignore.rs` *(new)* — matcher + get/set commands
- `src/modules/fs/mod.rs` — register module
- `src/modules/fs/{search,grep}.rs` — `add_custom_ignore_filename` on 4 builders
- `src/modules/fs/file.rs`, `mutate.rs` — opt-in `enforce_isanagentignore` param
- `src/modules/fs/watch.rs` — skip ignored paths
- `src/lib.rs` — register new commands in `invoke_handler!`
- `src/altai/agent/commands.rs`, `runtime.rs` — `CompactionArg` + thread to `AgentLogicParams` + fingerprint field

**TS (`src/`):**
- `src/modules/settings/store.ts` — `CompactionPrefs` fields/keys/setters/load/env-overrides
- `src/modules/ai/lib/native.ts` — compaction args on agentStart/agentSend; `enforceIsanagentignore`; get/set isanagentignore
- `src/modules/ai/store/chatStore.ts` — compaction into config + `lastStartFingerprint`
- `src/modules/ai/lib/compaction.ts` *(new)* — `pruneOldToolOutputs` (+ test)
- `src/modules/ai/lib/agentEventBridge.ts` — trigger prune on `done`
- `src/modules/ai/lib/slashCommands.ts` — `/compact` (+ aliases)
- `src/modules/ai/components/AiStatusBarControls.tsx` (or `AiChat.tsx`) — usage indicator + compact button
- `src/modules/settings/openSettingsWindow.ts`, `src/settings/SettingsContent.tsx` — `"context"` tab
- `src/settings/sections/ContextSection.tsx` *(new)* — condensing + .isanagentignore UI

**Tests:**
- `src/modules/ai/lib/compaction.test.ts` — prune correctness (vitest, existing pattern)
- `src-tauri` Rust tests in `isanagentignore.rs` — matcher deny/allow/negation; opt-in param gates

---

## Verification (run before declaring done)

```bash
pnpm build                          # tsc + vite production build
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all
pnpm test                           # vitest — incl. new compaction.test.ts
```

Manual:
- `/compact` (and `smol`, `condense`) triggers the existing `compact_context` tool and the transcript shows the tool card.
- Set `compactionThresholdTokens` low → next turn auto-compacts (visible via the compact_context tool card).
- Toggle `compactionPrune` off → old tool outputs persist; on → they collapse to "[Old tool result content cleared]".
- Create `<workspace>/.isanagentignore` with `secrets/**` → editor "find in files" / explorer search no longer returns those; editor can still open them directly (Tier 1 contract).
- Env: `ALTAI_DISABLE_AUTOCOMPACT=1` → auto-compaction stays off regardless of the pref.

---

## Risks / open decisions

1. **Agent-tool enforcement of `.isanagentignore`** lives in `altaidevorg/isanagent` (Tier 2, PR A). Tier 1 (altai-app fs/watcher/UI) ships independently. Until PR A merges upstream, the agent itself can still read ignored files — the Settings UI must state this honestly, and altai-app's `Cargo.toml` pin coordination (§0) applies.
2. **Compaction setting change rebuilds the runtime** on the next send (via the extended fingerprint). Acceptable; documented. In-flight turns are unaffected (rebuild only happens between sends).
3. **`/compact` depends on the model calling `compact_context`**. It's a registered tool with a clear instruction; if a model refuses, the user can retry. True one-shot "force compact" would need an isanagent API surface (out of scope; candidate for `altaidevorg/isanagent` PR B).
4. **Kilo knob parity is partial**: isanagent exposes `short_term_threshold_tokens` / `max_recent_summaries`, not `reserved` / `preserve_recent_tokens` / a dedicated compaction model. altai-app maps `threshold_percent`→tokens and `tail_turns`→`max_recent_summaries`; the prune recency window is TS-side. The remaining knobs need `altaidevorg/isanagent` PR B if full parity is desired.

## Suggested build order
1. `.isanagentignore` Tier 1 (2.1–2.7) — self-contained in altai-app, lowest risk, ships value fast.
2. Context Condensing prefs + Rust threading (1.1–1.2) — makes the existing engine configurable (no crate change).
3. `/compact` + prune + indicator (1.3–1.5).
4. Settings UI "Context" tab (1.6 / 2.7) — wires both features together.
5. Tests + verification.
6. `altaidevorg/isanagent` workstream (2.8 PR A, optionally PR B) — parallel PR(s) upstream; bump `Cargo.toml` once merged (coordinate with #58 per §0).
