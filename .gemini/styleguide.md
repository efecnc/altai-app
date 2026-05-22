# ALTAI review guide for Gemini Code Assist

> This file is the project-specific system prompt that Gemini Code Assist
> applies to every PR review. Keep it tight and concrete — generic advice
> dilutes the focused signal.

## Project shape (you have to know this to review correctly)

- **Tauri 2** desktop app. Frontend: React 19, Tailwind v4, Radix primitives
  via shadcn/ui, CodeMirror 6, xterm.js. Backend: Rust (`src-tauri/`).
- **Bundler / dev**: pnpm + Vite + `tauri dev`. Tests: Vitest.
- AI runtime lives under `src/modules/ai/`:
  - `lib/agent.ts` — Vercel AI SDK stream wrapper, the main agent loop.
  - `lib/agentFiles.ts` — file-based agents (`.altai/agents/*.md`).
  - `lib/native.ts` — typed wrapper over Tauri `invoke()` IPC.
  - `tools/*` — read_file / grep / glob / write_file / edit / multi_edit /
    bash_run / bash_background / todo_write / run_subagent.
  - `components/*` — AiSidePanel, AiInputBar, AiChat, AgentSwitcher,
    AiToolApproval, ChatHistory, AgentStatusPill, …
  - `store/*` — Zustand stores (chatStore, agentsStore, planStore,
    snippetsStore, todoStore).
- Settings UI under `src/settings/` opens in a separate Tauri window.
- Editor / terminal / explorer / source-control / git-history each live
  in their own `src/modules/*` directory.

## Must-flag (these are real bugs in this codebase)

### Accessibility (we shipped a Sprint 1 a11y baseline — don't regress it)

- New interactive element that isn't a real `<button>` / `<a>` / Radix
  primitive (e.g. `<div onClick>`, `<span role="button">` without
  `tabIndex` + `onKeyDown`).
- Icon-only button without `aria-label`. `title=` alone does not satisfy
  WCAG 4.1.2 — flag every occurrence.
- New custom dropdown/dialog that isn't using a Radix primitive — these
  almost always miss focus trap, Escape, arrow keys.
- New `<textarea>` / `<input>` with no `aria-label` or associated
  `<label htmlFor>`. Placeholder is not an accessible name.
- xterm.js `Terminal` constructor call without `screenReaderMode: true`.
- Live regions removed or weakened on chat/log surfaces.

### Type safety & correctness

- `any` in new code. Use `unknown` and narrow.
- Zod schemas missing at trust boundaries (parsing tool inputs, parsing
  data from external APIs, parsing file contents that crossed `invoke`).
- Mutating Zustand state in-place. Always `set({ ... })` with a new object.
- Mutating a prop / argument that callers may still hold.
- `useEffect` with missing dependencies that actually matter (not the
  silly exhaustive-deps lint — real bugs).

### Tauri / native boundary

- `invoke()` call that bypasses the `native.*` wrapper (`src/modules/ai/lib/native.ts`).
- File-system calls that don't go through workspace authorization
  (`workspace::authorize` in Rust, `currentWorkspaceEnv()` in TS).
- New Rust command added without entries in
  `src-tauri/capabilities/*.json` permissions list.

### Security

- Hardcoded API keys, tokens, or secrets — even in tests or docs.
- Reading from `process.env` in the renderer instead of the keychain
  store (`src/modules/ai/lib/keyring.ts`).
- `dangerouslySetInnerHTML` on untrusted input. Streamdown is the only
  approved path for assistant markdown.
- New `bash_run` / `shell_run_command` invocations without explicit user
  approval flow.

### Performance

- Synchronous I/O on the render path.
- New listener/event without a cleanup in the same hook.
- `useState` for derived state that should be `useMemo` (or just inline).
- Re-rendering a large list without `@tanstack/react-virtual` when the
  list could be unbounded.

### Code hygiene

- `console.log` left in.
- TODO without an issue link or owner.
- Commented-out code without an explanation comment.
- New file that duplicates an existing utility (search first — we already
  have helpers for path joining, debounce, etc.).

## Don't flag (these are intentional patterns we already accepted)

- The `native.*` wrapper over `invoke()` — that's the design.
- File-based agents reading from `.altai/agents/` via custom markdown +
  YAML frontmatter parser (no `gray-matter`).
- The `ChatStreamingProvider` + `aria-busy` pattern in
  `src/components/ai-elements/message.tsx`.
- The `AnimatePresence` + `key` re-mount in
  `src/modules/ai/components/AgentStatusPill.tsx` — the live region is
  intentionally placed *outside* it.
- `useId` for accessible relationships in
  `src/modules/ai/components/AiToolApproval.tsx`.
- Custom CSS color tokens in `oklch` — that's the theme system.
- Tailwind v4 utilities (no `tailwind.config.js`, uses `@theme` in CSS).
- The `LazyStore` from `@tauri-apps/plugin-store` for in-app persistence.

## Don't review

- `pnpm-lock.yaml`
- `src-tauri/Cargo.lock`
- `src-tauri/gen/**`
- `dist/**`
- `**/*.snap`
- Generated icon imports from `@hugeicons/core-free-icons`
- Build artifacts in `.tauri/`

## Comment style

- Lead with the file:line, then a one-line statement of the issue, then
  the suggested fix as a code suggestion when possible.
- "MUST" for bugs / security / a11y / type-safety regressions.
- "SHOULD" for maintainability concerns with a clear fix.
- "NIT" for opinion-level stuff — use sparingly; a noisy reviewer is a
  reviewer who gets muted.
- If nothing material to flag, say "Looks good." — don't fabricate
  findings to fill space.
