<div align="center">

<img src="public/logo.png" alt="ALTAI" width="120" />

# ALTAI

**The open agentic development environment.**
A single-binary desktop app that turns your terminal into a hands-on AI engineer — local, keychain-secured, no telemetry, no account.

[![Release](https://img.shields.io/github/v/release/efecnc/altai-app?label=release&color=6E56CF&style=flat-square)](https://github.com/efecnc/altai-app/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-22c55e?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/efecnc/altai-app/release.yml?label=build&style=flat-square)](https://github.com/efecnc/altai-app/actions/workflows/release.yml)
[![Platforms](https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey?style=flat-square)](INSTALL.md)

<p>
  <a href="#install">Install</a> ·
  <a href="#why-altai">Why</a> ·
  <a href="#agents">Agents</a> ·
  <a href="#the-altai-stack">The stack</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="https://altai.dev">altai.dev</a>
</p>

<sub>An open-source project by <a href="https://github.com/altaidevorg">Altai</a> — agentic infrastructure for engineers and ML researchers.</sub>

<!--
  Drop a hero GIF here once recorded from inside the app.
  Suggested capture: full window, user types a prompt, agent reads a file,
  proposes an edit (Ask-before-edit modal), user approves, terminal runs tests.
-->
<br/>
<img src="docs/media/hero.gif" alt="ALTAI hero demo" width="820" />

</div>

---

## About

ALTAI is what happens when you stop trying to bolt AI onto an editor and instead build the editor *around* an agent runtime. The terminal, the editor, and the file tree are first-class participants — the agent reads them, runs them, and edits them through the same primitives you do, gated by an explicit permission model.

Most "AI IDEs" are chat boxes that suggest code. ALTAI is a workspace where the agent **does the work**: reproduces an arXiv paper end-to-end on a free Colab GPU, generates a 10k-row DPO dataset, audits a diff for race conditions, ships a fix to a failing test — without ever asking you to copy-paste a thing.

It's a desktop app, not a service. Your code never leaves your machine; only the model call does. API keys live in your OS keychain. There is no account, no telemetry, no cloud round-trip.

## Why ALTAI

|                                | ALTAI | Cursor / Copilot | Aider / Cline | Cloud agent web UIs |
| ------------------------------ | :---: | :--------------: | :-----------: | :-----------------: |
| Native terminal + editor       |  ✅   |        ✅        |       ⛔      |          ⛔         |
| Local agent runtime (no cloud) |  ✅   |        ⛔        |       ✅      |          ⛔         |
| ML-aware agents (arXiv / HF)   |  ✅   |        ⛔        |       ⛔      |          ⚠️         |
| Background jobs + cron         |  ✅   |        ⛔        |       ⛔      |          ✅         |
| Bring-your-own-key, keychain   |  ✅   |        ⚠️        |       ✅      |          ⛔         |
| Single signed binary           |  ✅   |        ✅        |       ⛔      |          —          |
| No account, no telemetry       |  ✅   |        ⛔        |       ✅      |          ⛔         |

## Features

- 🛡️ **Three permission modes per session** — *Ask before edit* (default), *Edit automatically*, or *Bypass permissions* (gated behind an explicit Settings toggle). The agent never silently mutates your repo.
- 🤖 **9 built-in agents, fully editable** — Coder, Architect, Code Reviewer, Security, Designer, plus ML-focused agents (Paper Reproducer, Notebook Assistant, Dataset Generator). Override instructions, disable what you don't need, reset to defaults at any time.
- 🧠 **Dual agent runtime** — general agents stream through the Vercel AI SDK to your chosen provider; ML agents route through the embedded [**IsanAgent**](#-isanagent) Rust runtime with 44 tools, sub-agent DAGs, SQLite FTS5 memory, and a workspace-scoped execution harness (local · Jupyter · SSH · free Colab GPU).
- 🔑 **Bring your own keys** — Anthropic, OpenAI, Google, Groq, xAI, Cerebras, plus any OpenAI-compatible endpoint (LM Studio, MLX, Ollama). Keys live in a mode-0600 file under the app's local data dir on macOS and Linux, and in Credential Manager on Windows — never round-tripped through a cloud service, never bundled with the app.
- 🖥️ **First-class terminal** — xterm.js + portable-pty with shell integration for zsh, bash, fish, PowerShell. Emits OSC 7 (cwd) and OSC 133 (prompt boundaries) so the agent tracks every command boundary the way iTerm and Warp do.
- ✏️ **Editor with LSP** — CodeMirror 6, 20+ languages lazy-loaded, vim mode, 9 themes, inline diffs.
- 📊 **Background jobs that don't block you** — start a long training run, close the chat, come back later. Background jobs persist across restarts; the agent wakes when they finish.
- 🔬 **ML-domain tools out of the box** — `arxiv_search`, `arxiv_fetch`, `hf_hub_file_fetch`, `python_run`, and a Colab MCP bridge so paper reproduction works on free T4 GPUs.
- 🪪 **Zero account, zero telemetry, zero cloud round-trip.** Single signed binary. Apache 2.0.

<!--
  Drop a permission-modes GIF here.
  Suggested capture: open PermissionModeSwitcher, cycle through the three modes,
  then show an Ask-before-edit prompt appearing and being approved.
-->
<p align="center">
  <img src="docs/media/permission-modes.gif" alt="Permission modes" width="720" />
</p>

## Install

Grab the binary for your platform from the [Releases page](https://github.com/efecnc/altai-app/releases). One-time platform setup (Gatekeeper / SmartScreen bypass for the unsigned v0.1.0 build) is documented in **[INSTALL.md](INSTALL.md)**.

| Platform                  | File                                  | One-time setup                                              |
| ------------------------- | ------------------------------------- | ----------------------------------------------------------- |
| **macOS (Apple Silicon)** | `ALTAI_<version>_aarch64.dmg`         | `xattr -dr com.apple.quarantine /Applications/ALTAI.app`    |
| **macOS (Intel)**         | `ALTAI_<version>_x64.dmg`             | same as above                                               |
| **Windows**               | `ALTAI_<version>_x64_en-US.msi`       | SmartScreen → *More info* → *Run anyway*                    |
| **Linux (.deb)**          | `altai_<version>_amd64.deb`           | `sudo apt install ./altai_*.deb`                            |
| **Linux (.AppImage)**     | `altai_<version>_amd64.AppImage`      | `chmod +x` and run                                          |

Or build from source — see [Development](#development).

## Agents

ALTAI ships nine first-class agents. Each one is editable from the in-app **Agent Switcher** — change the system prompt, rename, disable, or reset to default. The runtime is auto-selected based on the agent.

| Agent                  | Domain                                       | Runtime         | Highlights                                                                            |
| ---------------------- | -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| **Coder**              | General-purpose engineering                  | `vercel`        | Pair-programs in your terminal, matches existing patterns, runs project checks.       |
| **Architect**          | System design & tradeoffs                    | `vercel`        | Restates the problem, surfaces 2–3 options with real tradeoffs before any code.        |
| **Code Reviewer**      | Diff review                                  | `vercel`        | Flags logic bugs, races, perf cliffs, security — skips formatting nits.                |
| **Security**           | Threat modeling                              | `vercel`        | Walks trust boundaries, scores severity, proposes class-of-bug fixes.                  |
| **Designer**           | UI/UX critique                               | `vercel`        | Specific, opinionated taste; Tailwind/CSS values where useful.                        |
| **Paper Reproducer**   | arXiv → working code                         | `isanagent`     | Reads the paper, extracts the architecture, emits runnable PyTorch.                    |
| **Notebook Assistant** | Jupyter / data-science workflows             | `isanagent`     | Cell-scoped edits, visualization-first, runs cells via the execution harness.          |
| **Dataset Generator**  | Synthetic SFT / DPO / tool-calling datasets  | `isanagent`     | Built on top of [**Afterimage**](#-afterimage). Pilot → verify → scale.                |
| **Custom**             | Bring your own                               | configurable    | Define your own agent, pick the runtime, tune the prompt.                              |

<!--
  Drop an agent-switcher screenshot or GIF here.
  Suggested capture: open AgentSwitcher panel, scroll through agents,
  click "Edit" on Paper Reproducer, show the instructions editor.
-->
<p align="center">
  <img src="docs/media/agent-switcher.png" alt="Agent switcher" width="720" />
</p>

## The Altai stack

ALTAI is the desktop surface of a small open-source stack. The other two pieces stand on their own — use them in your own projects.

### 🦀 IsanAgent

The Rust **agent runtime** embedded inside ALTAI. Not a sidecar — a crate that compiles into the binary.

- **44 tools** out of the box: filesystem, shell, web, arXiv, HuggingFace, execution, memory, cron, sub-agents.
- **4 execution providers** — local subprocess, Jupyter kernel, SSH remote, and **Colab MCP** (free T4 / TPU through a browser bridge).
- **Sub-agent DAGs** via `subagent_plan_execute` — coordinate `researcher` → `coder` → `evaluator` with declared dependencies.
- **SQLite FTS5 memory** — short-term session summaries plus a long-term reflection loop that runs every 60s.
- **Doom-loop detection** via SHA-256 fingerprinting of repeated tool calls, with automatic strategy switch.
- **Cron** persisted in SQLite for scheduled and webhook-triggered work.

→ **[github.com/altaidevorg/isanagent](https://github.com/altaidevorg/isanagent)**

### 🖼️ Afterimage

The Python **synthetic dataset library** the Dataset Generator agent leans on.

- **6+ dataset formats** — SFT conversational pairs, DPO preference data, structured-output JSON, tool-calling traces, MCQ, document-grounded QA.
- **Reproducible by default** — every generation pins seeds, logs parameters, and writes a config snapshot next to the dataset.
- **Multi-judge DPO** — preference data ships with judge-agreement rates so you can spot collapsed preferences early.
- **Outputs** as JSONL, Parquet, or HuggingFace `datasets`-compatible folders, with an auto-generated dataset card.

→ **[github.com/altaidevorg/afterimage](https://github.com/altaidevorg/afterimage)**

### 🌐 Altai

The lab behind ALTAI, IsanAgent, and Afterimage. We build **open agentic infrastructure for engineers and ML researchers** — the kind of tools we wanted but couldn't buy. Everything is Apache 2.0, BYO-keys, local-first.

→ **[altai.dev](https://altai.dev)** · **[github.com/altaidevorg](https://github.com/altaidevorg)**

## Architecture

```
┌─────────────────────────────────────────────────┐
│ React 19 + Vite                                 │
│   AiSidePanel · AgentSwitcher · Editor · Term   │
│   PermissionModeSwitcher · Settings             │
└─────────────────────────┬───────────────────────┘
                          │ Tauri IPC
┌─────────────────────────▼───────────────────────┐
│ Rust (Tauri 2)                                  │
│   workspace · fs · pty · shell · git · lsp      │
│   ┌─────────────────────────────────────────┐   │
│   │ isanagent (embedded crate)              │   │
│   │   AgentLogic · ExecutionHarness         │   │
│   │   Tools: arxiv, hf_hub, exec, todo, …   │   │
│   │   SQLite memory (FTS5) · sub-agent DAG  │   │
│   └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

Two runtimes, one chat surface:

- **`vercel`** — most agents. Streams via the Vercel AI SDK directly to your chosen provider. Tools (`edit`, `bash_run`, …) execute in the renderer and are gated by the current permission mode.
- **`isanagent`** — Paper Reproducer / Notebook Assistant / Dataset Generator. Routes through the embedded Rust runtime with the execution harness, persistent memory, and ML-domain tools.

The split is automatic — switch agents from the toolbar and the runtime swaps under the hood.

<!--
  Drop a paper-reproducer GIF here.
  Suggested capture: paste an arXiv URL, agent fetches it via arxiv_fetch,
  proposes the model file structure, writes the cells, kicks off training
  on Colab MCP, and shows the first loss value coming back.
-->
<p align="center">
  <img src="docs/media/paper-reproducer.gif" alt="Paper Reproducer running an arXiv paper" width="820" />
</p>

## Project layout

```
src/
  app/                  shell + tabs + global wiring
  modules/
    ai/                 agents, chat store, tools, transport
    editor/             CodeMirror integration + LSP client
    terminal/           xterm.js wrapper + session pool
    settings/           preferences store
  settings/             standalone Settings webview
src-tauri/
  src/
    altai/              owned ALTAI logic (agent runtime bridge)
    modules/            workspace, pty, fs, git, lsp, shell
```

## Development

Requires Rust stable, Node 22+, pnpm 9+, and the platform-specific [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/efecnc/altai-app.git
cd altai-app
pnpm install
pnpm tauri:dev
```

Type-check and lint:

```bash
pnpm build                                      # tsc + vite build
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all
```

## Release

Push a `v*` tag (or trigger the workflow manually):

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions matrix-builds for macOS (Apple Silicon + Intel), Linux (x86_64), and Windows (x86_64), then publishes binaries to the Releases page. ~20–30 min end-to-end.

## Roadmap

- [ ] Plugin SDK — third-party tools and agents installable from a registry
- [ ] Multi-workspace sessions with cross-workspace memory boundaries
- [ ] First-class MCP server hosting (alongside the existing client)
- [ ] Self-hosted update channel for air-gapped environments
- [ ] Code-signing on macOS and Windows (post-v0.1)

Have an idea? Open an [issue](https://github.com/efecnc/altai-app/issues) or start a [discussion](https://github.com/efecnc/altai-app/discussions).

## Contributing

Issues and PRs welcome. For non-trivial changes, please open an issue first to discuss scope.

The codebase favors:

- Small, focused files (200–400 lines typical).
- Explicit error handling at boundaries; no silent fallbacks.
- Immutable update patterns in stores.
- Comments only where the *why* is non-obvious.

## License

[Apache 2.0](LICENSE) — use it, ship it, fork it.

<sub>ALTAI · IsanAgent · Afterimage are projects of <a href="https://altai.dev">Altai</a> — open agentic infrastructure for engineers and ML researchers.</sub>
