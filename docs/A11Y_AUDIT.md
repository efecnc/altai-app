# altai Accessibility Audit (WCAG 2.2 AA)

> Status: audit. 2026-05-22. Auditor: a11y-architect subagent.
> Scope: keyboard navigation, screen-reader semantics, focus management, color contrast, motion. Code not modified.

## Executive summary

altai's foundation is better than average for a young product: most surfaces use Radix primitives, shadcn `<Button>` has a real `focus-visible` ring, source control already nails `role="listbox"` with `aria-activedescendant`, and roughly two-thirds of icon-only buttons carry `aria-label`. But the product is unusable for a blind developer today for three structural reasons. (1) The xterm.js terminal is initialised without `screenReaderMode`, so the terminal — half the product — is entirely silent to VoiceOver/NVDA/JAWS/Orca (`src/modules/terminal/lib/rendererPool.ts:83-95`). (2) The chat transcript is wrapped in `role="log"` but has no `aria-live` policy and the agent's permission-approval card has no role or live region, so the screen reader never announces streaming assistant output or "the agent is waiting for you to approve a shell command" (`src/components/ai-elements/conversation.tsx:14-22`, `src/modules/ai/components/AiToolApproval.tsx:39-82`). (3) The chat composer textarea and the commit-message textarea have no accessible name at all (`src/modules/ai/components/AiInputBar.tsx:292-348`, `src/modules/source-control/SourceControlPanel.tsx:563-572`). Fixing these three blockers plus a handful of `aria-label` additions on icon-only triggers (AgentSwitcher, PermissionModeSwitcher, ToolbarIcon, TerminalPane container) gets a blind developer to a functional state in roughly one sprint. The smaller passes after that are keyboard polish (close-tab `<span role="button">`, focus-visible on a couple of stragglers) and visual polish (muted-foreground contrast on light theme, no `prefers-reduced-motion` handling anywhere).

## Findings by severity

### Critical

| # | File:line | Issue | WCAG SC | Suggested fix |
|---|---|---|---|---|
| C1 | `src/modules/terminal/lib/rendererPool.ts:83-95` | `termOptions()` builds the xterm `Terminal` config without `screenReaderMode: true`. xterm.js defaults this to false, which means it never renders the off-screen `aria-live` row that screen readers read. The entire terminal pane is silent. | 1.3.1 Info & Relationships; 4.1.2 Name, Role, Value; 4.1.3 Status Messages | Add `screenReaderMode: true` to the returned options (gate behind a preference if you want to keep the WebGL perf path opt-out, but default it on when a SR is detected or when `prefers-reduced-motion` is set). |
| C2 | `src/modules/terminal/TerminalPane.tsx:70-78` | The pane container `<div>` has no `role`, no `aria-label`, no `aria-roledescription`. A screen reader user has no way to know they've tabbed into a terminal, let alone which leaf they're in. | 1.3.1; 4.1.2 | Add `role="application"` (or `region`) + `aria-label={\`Terminal pane \${leafId}\`}` on the container. Pair with C1 for actual output announcement. |
| C3 | `src/components/ai-elements/conversation.tsx:14-22` | `Conversation` sets `role="log"` but no explicit `aria-live`/`aria-relevant`/`aria-atomic`. Browsers default `log` to `polite` but Chromium-on-WebView in Tauri has historically been spotty. Critically, the streaming token-by-token assistant text inside `MessageResponse` is not in an atomic region, so screen readers re-announce on every chunk. | 4.1.3 Status Messages; 1.3.1 | Add `aria-live="polite"`, `aria-atomic="false"`, `aria-relevant="additions text"` on the log container. Wrap streaming assistant text in a child with `aria-busy={streaming}` so SRs hold announcement until the message finalises. |
| C4 | `src/modules/ai/components/AiToolApproval.tsx:39-82` | The "needs approval" card for `bash_run`, `write_file`, `edit`, etc. is a plain `<div>` with no `role="alertdialog"` / no `role="alert"` / no `aria-live`. A blind user running the agent will never know the agent has paused waiting for them to approve a destructive shell command — the agent will just appear hung. | 4.1.3 Status Messages; 3.2.2 On Input (implicit, the agent halted on the user) | Wrap in `role="group"` with `aria-labelledby` to the tool label and add a sibling `<div role="status" aria-live="assertive">{label} requires approval</div>` (or wrap the whole card in `role="alertdialog"` with focus auto-moved to the Approve button). |
| C5 | `src/modules/ai/components/AgentStatusPill.tsx:22-42` | Status transitions (`thinking` → `awaiting-approval` → `error`) are rendered as visible state changes on a button but never announced. The pill is the canonical "where is the agent right now" surface. | 4.1.3 Status Messages | Add `aria-live="polite"` on the wrapping element (separate from the button so the announcement isn't tied to focus), or render an off-screen `role="status"` sibling with the current `label`. |
| C6 | `src/modules/ai/components/AiInputBar.tsx:292-348` | The main chat composer `<textarea>` has neither `aria-label` nor an associated `<label>`. VoiceOver announces "edit text" with no context. | 4.1.2; 3.3.2 Labels or Instructions | Add `aria-label="Message ALTAI"` (or `aria-labelledby` pointing at a visually-hidden label). The placeholder is not an accessible name. |
| C7 | `src/modules/source-control/SourceControlPanel.tsx:563-572` | Commit-message `<Textarea>` has no label, only a placeholder. Same failure mode as C6 on the second-most-used input. | 4.1.2; 3.3.2 | Add `aria-label="Commit message"`. |
| C8 | `src/modules/tabs/TabBar.tsx:129-145` | Close-tab control is `<span role="button" aria-label="Close tab" onClick=...>` with **no `tabIndex` and no `onKeyDown`**. It is unreachable by keyboard and will not respond to Enter/Space — keyboard users cannot close tabs from the tab strip. | 2.1.1 Keyboard; 4.1.2 | Replace with a real `<button type="button">` (the click-stop-propagation logic still works). The Radix `TabsTrigger` parent won't interfere if you `stopPropagation` in `onClick`. |
| C9 | `src/modules/ai/components/AiSidePanel.tsx:142-177` | `SessionTab` is `<div role="tab" aria-selected onClick>` with **no `tabIndex`, no `onKeyDown`, no parent `role="tablist"`**, and the close-session button inside is `size-3.5` (14px) — below the 24px target minimum. Custom tabs that aren't Radix `Tabs` need full keyboard handling. | 2.1.1 Keyboard; 4.1.2; 2.5.8 Target Size (Minimum) | Either swap to shadcn `<Tabs>` (preferred — Radix gives you Arrow-Left/Right + `role="tablist"` for free) or add `tabIndex={active ? 0 : -1}`, `onKeyDown` for Enter/Space/Arrow keys, and a wrapping `role="tablist"` with `aria-orientation="horizontal"`. Bump the close button to a 24x24 hit area (visual size can stay smaller via inner span). |
| C10 | `src/modules/ai/components/ChatHistory.tsx:302-321` | `HistoryRow` is `<div role="button">` with Enter/Space handled — but several action sub-buttons (Rename, Delete) are inside the same row and `stopPropagation` is on the row click handler. Result: the row is reachable, but on Enter the row opens the session even when focus is on the icon-buttons inside. Mixing `role="button"` with nested real buttons is a common antipattern. | 2.1.1; 4.1.2 | Make the row a real `<button>` and put the icon-buttons *outside* it visually (CSS overlay) — or keep the wrapper but disable its Enter handler when `e.target !== e.currentTarget`. |

### High

| # | File:line | Issue | WCAG SC | Suggested fix |
|---|---|---|---|---|
| H1 | `src/modules/ai/components/AgentSwitcher.tsx:93-114`, `src/modules/ai/components/PermissionModeSwitcher.tsx:82-110`, `src/modules/ai/components/AiInputBar.tsx:491-505` (`ToolbarIcon`) | Icon-only `DropdownMenuTrigger` / `Button` instances rely on `title=` for the accessible name. `title` is unreliable on screen readers and doesn't satisfy 4.1.2. | 4.1.2; 2.5.3 Label in Name | Add `aria-label` mirroring the title text. (Six call sites: AgentSwitcher, PermissionModeSwitcher, every `<ToolbarIcon>` in AiInputBar, the new-folder/new-file/refresh buttons in `FileExplorer.tsx:402-424` already missing labels.) |
| H2 | `src/settings/sections/ModelsSection.tsx:106, 162, 336, 457, 624` (`<Label>{text}</Label>` without `htmlFor`) | The shadcn `<Label>` is Radix `LabelPrimitive.Root`. When used as a non-wrapping sibling with no `htmlFor`, it's a meaningless `<label>`. Screen readers won't tie "Default model" to the dropdown, "Cloud providers" to the grid, etc. Same pattern recurs in `LocalServerBlock` (line 336) and `AutocompleteBlock`. | 1.3.1; 3.3.2 | Either give each input an `id` and the `<Label>` a matching `htmlFor`, or wrap the input inside the `<Label>` (Radix supports both). For section-heading uses ("Cloud providers"), promote to `<h3>` instead of `<Label>`. |
| H3 | `src/modules/ai/components/AiChat.tsx:259-266` | Inline error inside the chat ("Something went wrong …") is a plain `<div>` with no `role="alert"`. Errors must be announced. | 4.1.3 | Add `role="alert"` to the error wrapper (or use shadcn `<Alert>` which already sets `role="alert"`, see `src/components/ui/alert.tsx:30`). |
| H4 | `src/modules/ai/components/PaperImport.tsx:80` | Native `<input>` with `focus:outline-none focus:ring-1 focus:ring-ring` — falls back to `focus:` (not `focus-visible:`) which means mouse clicks also show the ring (acceptable) but the input has no `<label>` either. | 2.4.7 Focus Visible; 3.3.2 | Pair with `<label htmlFor>` and prefer `focus-visible:` for consistency with the rest of the app. |
| H5 | `src/modules/explorer/FileExplorer.tsx:367-371` | The explorer is a single `tabIndex={0}` container with custom `onKeyDown`, but the rendered file rows have no `role="treeitem"` / `aria-level` / `aria-expanded` — there's no tree semantics. SR users won't perceive depth, expand/collapse state, or which row is "selected". (Source control got this right at `SourceControlPanel.tsx:693-703`; explorer didn't.) | 1.3.1; 4.1.2 | Wrap the virtual list in `role="tree"` and add `role="treeitem"`, `aria-level={depth+1}`, `aria-expanded` (for dirs), `aria-selected`, and `aria-activedescendant` on the container. Same shape as the source-control listbox. |
| H6 | `src/modules/ai/components/AiSidePanel.tsx:67-86` | AI side panel root is a `<div data-ai-side-panel>` with no `role="complementary"` / `aria-label="AI assistant"`. Combined with the absence of `role="tablist"` on `SessionTabs`, a SR user has no landmark to jump to. | 1.3.1; 2.4.1 Bypass Blocks | Make the root `<aside aria-label="AI assistant">` and add `role="tablist"` to the session-tabs row. |
| H7 | `src/app/App.tsx:1409-1436` | The app shell has a `<main>` landmark but no skip-link, no `<nav>` for the sidebar rail, and the header in `src/modules/header/Header.tsx` is a `<div>` rather than `<header role="banner">`. Tabbing from window controls lands somewhere in the toolbar with no way to skip to the editor or AI panel. | 2.4.1 Bypass Blocks; 1.3.1 | Add a visually-hidden "Skip to editor" / "Skip to AI assistant" link as the first focusable element in `<main>`. Promote `Header` to `<header>` and the `SidebarRail` to `<nav aria-label="Workspace views">`. |
| H8 | `src/components/ai-elements/message.tsx:263, 286` (and other icon-buttons across the chat primitives) | "Previous branch" / "Next branch" buttons are correctly labeled but no broader review was done of `src/components/ai-elements/*.tsx`. Tool result rows (`tool.tsx:178`) use `aria-label={STATUS_LABEL[state]}` but the surrounding chrome (collapsible triggers, copy buttons, "Run in active terminal") are sometimes labeled, sometimes not. | 4.1.2 | Sweep `src/components/ai-elements/` for icon-only triggers and add `aria-label` where missing. Cap: ~8 call sites, all in chat-code.tsx, snippet.tsx, tool.tsx, message.tsx. |

### Medium

| # | File:line | Issue | WCAG SC | Suggested fix |
|---|---|---|---|---|
| M1 | `src/styles/globals.css:54-87` (light theme) | `--muted-foreground: oklch(0.56 …)` on `--background: oklch(1.0)` = ~3.5:1, on `--muted: oklch(0.963)` = ~3.2:1. Many secondary labels (hint text, "Cancel", time stamps, the `· no edits queued` plan-mode strip, `text-muted-foreground/70` example shortcuts) fail AA 4.5:1 for normal text. Dark theme is fine. | 1.4.3 Contrast (Minimum) | Darken light-theme `--muted-foreground` to `oklch(0.48 …)` or below; verify all `text-muted-foreground` uses against `--background` and `--muted`. Avoid `text-muted-foreground/70` or `/55` for any content the user must read (composer placeholder at `AiInputBar.tsx:345`, agent hint at `AiSidePanel.tsx:478`). |
| M2 | `src/styles/globals.css:69-71`, `:104` | `--border: oklch(0.925 …)` on `--background: oklch(1.0)` ≈ 1.15:1; dark theme `--border: oklch(1 0 0 / 10%)` ≈ similar. Borders that *only* convey state (active tab, focused input, separator between non-decorative regions) fail 3:1 for non-text UI. | 1.4.11 Non-text Contrast | Borders used purely decoratively are fine. For state-carrying borders (focus rings, active-tab outline, plan-mode amber strip border) ensure 3:1 — most already pair with a background fill, but the AI side-panel session tab "active" state at `AiSidePanel.tsx:148-150` is `bg-foreground/[0.07]` which on light theme is ~1.07:1 against background. Pair with a text-weight change (already done) but also add an inset ring or stronger fill. |
| M3 | `src/modules/ai/components/AiChat.tsx:549-563` (`PartAppear`), `src/modules/ai/components/AiInputBar.tsx:454-472, 527-625`, `AgentStatusPill.tsx:23-41`, `src/styles/globals.css:254-283` (collapsible keyframes), `animate-pulse` at many call sites | No `prefers-reduced-motion` handling anywhere in the codebase. `motion` library animations, Tailwind `animate-pulse` on the recording-indicator and approval pill, and the custom `altai-collapsible-down/up` keyframes all run unconditionally. Streaming chat surfaces are particularly motion-heavy. | 2.3.3 Animation from Interactions; 1.4.2 (indirect) | Add a global `@media (prefers-reduced-motion: reduce)` rule in `globals.css` that disables the collapsible keyframes and `animate-*` utilities. Wrap `motion.div` instances with the `useReducedMotion()` hook from `motion/react` and skip the `initial/animate/exit` props. |
| M4 | `src/components/ai-elements/conversation.tsx:14-22` (no heading hierarchy in chat); `src/modules/ai/components/AiSidePanel.tsx` (no `<h1>`/`<h2>` in side panel); `src/settings/components/SectionHeader.tsx` (need to verify it emits a heading) | The product as a whole has effectively no heading structure outside `ConversationEmptyState.h3` (`conversation.tsx:63`) and the Radix `DialogTitle`. SR users navigating by heading (`H` key) get nothing. | 1.3.1; 2.4.6 Headings and Labels | Use `<h1>` for the active session title in the AI panel, `<h2>` for each settings section, `<h3>` for sub-blocks. Visually hidden `<h1 class="sr-only">altai workspace</h1>` at the top of `App.tsx` would also help. |
| M5 | `src/modules/ai/components/AiSidePanel.tsx:164-174` (close-session button is 14px), `src/modules/ai/components/ChatHistory.tsx:422-437` (`RowIconButton` is 20px = `size-5`), `src/modules/source-control/SourceControlPanel.tsx:585-605` (24px ✓) | Several icon-only buttons sit below the 24x24 CSS px minimum for pointer targets. Cap target spacing too: when targets are <24px they need ≥24px clear space around them, which the hover-only-visible icons in `SessionTab` and `HistoryRow` do not guarantee. | 2.5.8 Target Size (Minimum) | Bump min size to `size-6` (24px) on all interactive icon buttons. If visual density is critical, keep the icon glyph at 14px but pad the hit area to 24px. |
| M6 | `src/modules/ai/components/AiSidePanel.tsx:53-64` | Global `Escape` handler closes the AI panel from anywhere except inside an `<input>`/`<textarea>` — including when focus is inside a Radix `DropdownMenu` or `Popover`. Escape will close the panel out from under the menu. | 2.1.2 No Keyboard Trap (inverse — over-eager exit) | Tighten the guard to also bail on `[role="menu"]`, `[role="listbox"]`, `[data-state="open"]` ancestors. |

### Low

| # | File:line | Issue | WCAG SC | Suggested fix |
|---|---|---|---|---|
| L1 | App-wide | No documented "keyboard shortcuts reference" surface advertised to SR users. The `ShortcutsSection` exists but isn't discoverable from the main UI. | 3.3.5 Help (AAA, but cheap) | Add a help-link in the header that opens the shortcuts settings section. |
| L2 | `src/styles/globals.css:130, 153-164` | `body { overflow: hidden }` and fixed-height `#root` will likely break content reflow at very high zoom (1.4.10 Reflow). Tauri WebView users can hit this with `Ctrl+=`. | 1.4.10 Reflow | Audit the resizable panel groups at 200% zoom — confirm no horizontal scroll required at 320 CSS px equivalent. |
| L3 | `src/components/ui/dialog.tsx:69-79`, similar in alert-dialog | The Dialog auto-close button uses `<span className="sr-only">Close</span>` which is fine, but the close icon is also the only visual affordance and lives 16px from the corner — fine for mouse, fine for keyboard via Escape. AAA target spacing not met but acceptable for Level AA. | 2.5.8 (AAA) | No change needed for AA. |
| L4 | Theme tokens: `--ring` light = oklch(0.723) on background = ~2.1:1 | The focus ring color itself is on the low end. The button focus-visible uses `ring/30` (alpha) which further reduces visible contrast, relying on the 3px ring width to compensate. | 1.4.11 Non-text Contrast | Darken `--ring` light-theme to oklch(0.5) or rely on the `focus-visible:border-ring` pattern (button already does this). |

## Per-surface notes

**AI side panel (`src/modules/ai/components/`).** This is the most-used surface and the weakest. The good: `AiSidePanel.tsx` uses real `<button>`s for new-session and close-session, the composer has proper Escape-to-close logic, and the example-prompt grid uses `<button>` with text labels. The bad: the textarea has no label (C6); the agent-approval card is invisible to SRs (C4); session tabs aren't a real tablist (C9); the agent status pill announces nothing on state change (C5); the chat transcript has `role="log"` but no live policy (C3). One narrow but consequential bug: `AiSidePanel.tsx:53-64` globally swallows Escape, conflicting with Radix menus (M6). The lazy `PaperImport.tsx` has a labelless input (H4).

**Settings (`src/settings/`).** Better than the AI panel because shadcn `<Tabs>` + Radix `<DropdownMenu>` carry their own semantics. The `<main>` landmark is correctly placed (`SettingsContent.tsx:93`). But every form section uses `<Label>` as a section title without `htmlFor`, so the inputs themselves remain unlabeled (H2). `ProviderKeyCard.tsx:134` correctly labels the show/hide-key button. `GeneralSection.tsx:214` correctly labels the info button. No heading hierarchy beyond `SectionHeader` (verify what it emits).

**Top-level layout & tabs.** `App.tsx` has `<main>` (good) but no `<header>`, no `<nav>`, no skip-link (H7). `TabBar.tsx` uses Radix `<Tabs>` correctly except for the close-tab `<span role="button">` keyboard trap (C8). Header search at `SearchInline.tsx:197` is labeled.

**File explorer (`src/modules/explorer/`).** Single tabIndex container + custom key handling but no tree semantics on rows (H5). The header action buttons at `FileExplorer.tsx:402, 411, 420` have `title` but no `aria-label` — the "New file" and "New folder" buttons would be silent. Search input is labeled (`FileExplorer.tsx:393`).

**Source control + git history.** This is the best-modeled surface in the app. `SourceControlPanel.tsx:693-703` correctly uses `role="listbox"` + `aria-label` + `aria-activedescendant` + `tabIndex={0}` + custom key handling. Stage buttons have aria-labels. Commit-button has a tooltipped aria-label. The two gaps: commit-message textarea is unlabeled (C7), and the AlertDialog "Discard changes?" content is fine (Radix handles `role="alertdialog"`, `aria-modal`, focus trap automatically).

**Editor & terminal.** The xterm integration is the single biggest accessibility blocker (C1, C2). CodeMirror's own a11y is reasonable out of the box but worth verifying the integration doesn't disable it. Per scope, internals not deep-audited.

**Shadcn UI primitives (`src/components/ui/`).** Radix-backed primitives (Dialog, AlertDialog, DropdownMenu, Popover, Tabs, Tooltip, Select, RadioGroup, Switch, Checkbox, Label) are correct and handle their own a11y. `dialog.tsx:69-79` correctly includes the visually-hidden "Close" label. `spinner.tsx:11` has `role="status"`. `alert.tsx:30` has `role="alert"`. `breadcrumb.tsx:11` has `aria-label="breadcrumb"`. No regressions detected from the shadcn baseline.

## Color contrast

Tokens measured from `src/styles/globals.css` (light and dark) at the typical pairings. Values are approximations from oklch L-channel → sRGB luminance, accurate to ±0.1 in ratio.

| Token (light) | Background | Ratio | AA normal (4.5) | AA large/UI (3.0) |
|---|---|---|---|---|
| `--foreground` (0.148) | `--background` (1.0) | ~21:1 | PASS AAA | PASS |
| `--muted-foreground` (0.56) | `--background` (1.0) | ~3.5:1 | **FAIL** | PASS |
| `--muted-foreground` (0.56) | `--muted` (0.963) | ~3.2:1 | **FAIL** | PASS |
| `--muted-foreground/70` (0.56 @70%) | `--background` (1.0) | ~2.5:1 | **FAIL** | **FAIL** |
| `--primary` (0.218) | `--background` (1.0) | ~14:1 | PASS AAA | PASS |
| `--destructive` (0.577) | `--background` (1.0) | ~4.0:1 | **FAIL** | PASS |
| `--border` (0.925) | `--background` (1.0) | ~1.15:1 | n/a | **FAIL** (state-carrying only) |
| `--ring` (0.723) | `--background` (1.0) | ~2.1:1 | n/a | **FAIL** (relies on 3px width) |

| Token (dark) | Background | Ratio | AA normal (4.5) | AA large/UI (3.0) |
|---|---|---|---|---|
| `--foreground` (0.987) | `--background` (0.148) | ~17:1 | PASS AAA | PASS |
| `--muted-foreground` (0.723) | `--background` (0.148) | ~7.5:1 | PASS AAA | PASS |
| `--muted-foreground` (0.723) | `--muted` (0.275) | ~4.7:1 | PASS | PASS |
| `--destructive` (0.704) | `--background` (0.148) | ~7.0:1 | PASS | PASS |
| `--border` (rgba(255,255,255,0.10)) | `--background` (0.148) | ~1.3:1 | n/a | **FAIL** (state-carrying only) |
| `--ring` (0.56) | `--background` (0.148) | ~3.8:1 | n/a | PASS |

Summary: light theme has real AA failures on the secondary text track (`muted-foreground` and its `/70`, `/55` variants used throughout the chat composer and status strips). Dark theme is comfortable for AA. State-carrying borders fail 3:1 in both themes; rely on additional cues (fills, weight) where they exist.

## Remediation plan (3 sprints)

### Sprint 1 — Unblock screen-reader users (1-2 sessions)
- Set `screenReaderMode: true` in `rendererPool.ts:termOptions()` (C1) and label the TerminalPane container with `role` + `aria-label` (C2).
- Add `aria-live="polite"`, `aria-atomic="false"`, `aria-relevant="additions text"` on the `Conversation` log container (C3); wrap streaming assistant text with `aria-busy={streaming}`.
- Wrap `AiToolApproval` in `role="alertdialog"` (or sibling `role="alert"`) with focus moved to the Approve button; ensure the approval transition also fires the AgentStatusPill update with a live region (C4, C5).
- Add `aria-label="Message ALTAI"` to the chat composer textarea (C6) and `aria-label="Commit message"` to the commit textarea (C7).
- Sweep icon-only triggers (AgentSwitcher, PermissionModeSwitcher, every `ToolbarIcon`, FileExplorer header buttons, ai-elements/* icon buttons) for missing `aria-label` (H1, H8).

### Sprint 2 — Keyboard polish (1 session)
- Replace `<span role="button">` close-tab with real `<button>` (C8); ditto session-tab `<div role="tab">` → real Radix `<Tabs>` or full keyboard handlers (C9).
- Decouple `HistoryRow` Enter handler from focus on nested action buttons (C10).
- Add `role="tree"` + `treeitem` + `aria-level` + `aria-expanded` to FileExplorer rows, mirroring source-control's listbox pattern (H5).
- Tighten the AiSidePanel global Escape handler to ignore open Radix menus/popovers (M6).
- Promote `<Header>` to `<header>`, `<SidebarRail>` to `<nav aria-label="Workspace views">`, AiSidePanel root to `<aside aria-label="AI assistant">`; add a visually-hidden "Skip to editor" / "Skip to AI assistant" link in `App.tsx` (H7, H6).
- Fix `<Label>` without `htmlFor` across `ModelsSection.tsx` and friends (H2).
- Add `role="alert"` to the inline chat error wrapper (H3).

### Sprint 3 — Visual / motion polish (1 session)
- Darken light-theme `--muted-foreground` to oklch(0.48) or below; audit all `text-muted-foreground/70` and `/55` usages (M1).
- Add a single global `@media (prefers-reduced-motion: reduce)` rule in `globals.css` that disables `animate-*` utilities, the `altai-collapsible-*` keyframes, and `motion` animations (use `useReducedMotion()` for the `motion/react` call sites) (M3).
- Add a heading hierarchy: `<h1 class="sr-only">` in App, `<h2>` per settings section, `<h3>` in sub-blocks (M4).
- Bump every interactive icon button to a 24x24 hit area (M5).
- Raise focus-ring contrast on light theme (L4).
- Validate reflow at 200% zoom (L2).

## Out of scope

- CodeMirror 6 editor internals (a11y of completion popups, diagnostics gutter, search/replace) — only the integration points were considered.
- xterm.js internal behaviour with `screenReaderMode: true` (the addon-driven `aria-live` row, accessibility-tree size limits, performance impact of the parallel ARIA buffer) — needs a follow-up after C1 is in place.
- Locale / RTL support, font-size scaling beyond browser zoom, OS-level high-contrast modes (Windows ForcedColors, macOS Increase Contrast).
- Automated a11y test setup (axe-core, Playwright `@axe-core/playwright`) — recommended but not part of this audit.
- Voice control flows beyond the existing OpenAI Whisper voice-input button (Talon, Dragon, macOS Voice Control compatibility).
- Mini-window (`AiStatusBarControls`) was sampled but not exhaustively audited; assume the same patterns as the main side panel apply.
- Plugin / extension surfaces (`docs/sample-plugin`) — third-party plugins inherit the host's a11y posture but aren't audited individually.
