# ALTAI

> Open agentic development environment — a single-binary desktop app that turns your terminal into a hands-on AI engineer.

[![Release](https://img.shields.io/github/v/release/efecnc/altai-app?label=release&color=blue)](https://github.com/efecnc/altai-app/releases)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)](LICENSE)
[![Build](https://github.com/efecnc/altai-app/actions/workflows/release.yml/badge.svg)](https://github.com/efecnc/altai-app/actions/workflows/release.yml)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](INSTALL.md)

ALTAI runs locally, reads your workspace, edits files, executes shell commands, and reproduces ML papers — under your control, with no telemetry and no account.

---

## Why

Most AI coding tools are chat boxes bolted onto a sidebar. ALTAI is the other way around: a real terminal + editor with an agent runtime inside, so the agent can *do* the work — not narrate it. You pick the permission level. You pick the model. Keys live in your OS keychain.

## Features

- **Permission modes** per session — *Ask before edit* (default), *Edit automatically* (auto-approve file edits, still ask for shell), or *Bypass permissions* (auto-approve everything, gated behind a Settings toggle).
- **Built-in agents** — Coder, Architect, Code Reviewer, Security, Designer, plus ML-focused agents (Paper Reproducer, Notebook Assistant, Dataset Generator) backed by the embedded agent runtime with arxiv + HuggingFace tools.
- **Per-agent enable/disable + edit** — turn off agents you don't use; override built-in instructions without losing the ability to reset to defaults.
- **Bring your own keys** — Anthropic, OpenAI, Google, Groq, xAI, Cerebras, OpenAI-compatible (LM Studio, MLX, Ollama-style endpoints). Stored in macOS Keychain / Windows Credential Manager / Linux Secret Service — never in plain text.
- **Native terminal** — xterm.js + portable-pty with shell integration for zsh, bash, fish, PowerShell. Emits OSC 7 (cwd) + OSC 133 (prompt boundaries) for first-class command tracking.
- **Editor with LSP** — CodeMirror 6, 20+ languages lazy-loaded, vim mode, 9 themes.
- **No telemetry. No account. No cloud round-trip.** Your code stays local; only the model call leaves the box.

## Install

Releases live on the [Releases page](https://github.com/efecnc/altai-app/releases). One-time platform setup (Gatekeeper / SmartScreen bypass for the unsigned v0.1.0 build) is documented in **[INSTALL.md](INSTALL.md)**.

Quick install:

| Platform | File | One-time setup |
|---|---|---|
| **macOS (Apple Silicon)** | `ALTAI_<version>_aarch64.dmg` | `xattr -dr com.apple.quarantine /Applications/ALTAI.app` |
| **macOS (Intel)** | `ALTAI_<version>_x64.dmg` | same as above |
| **Windows** | `ALTAI_<version>_x64_en-US.msi` | SmartScreen → *More info* → *Run anyway* |
| **Linux (.deb)** | `altai_<version>_amd64.deb` | `sudo apt install ./altai_*.deb` |
| **Linux (.AppImage)** | `altai_<version>_amd64.AppImage` | `chmod +x` and run |

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
│   │ altai_agent (embedded crate)            │   │
│   │   AgentLogic · ExecutionHarness         │   │
│   │   Tools: arxiv, hf_hub, todo, ...       │   │
│   │   SQLite memory (FTS5)                  │   │
│   └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

Two AI backends route from a single chat UI:

- **`vercel`** — most agents. Streams via Vercel AI SDK directly to the chosen provider. Tools execute in the renderer (`edit`, `bash_run`, etc.) with per-tool approval prompts gated by permission mode.
- **`isanagent`** — Paper Reproducer / Notebook Assistant / Dataset Generator. Routes through the embedded Rust agent runtime with workspace-scoped execution harness, persistent SQLite memory, and ML-domain tools.

The split is automatic based on the selected agent — switch agents from the toolbar and the runtime swaps under the hood.

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

## Contributing

Issues and PRs welcome. For non-trivial changes, please open an issue first to discuss scope.

The codebase favors:

- Small focused files (200–400 lines typical).
- Explicit error handling at boundaries; no silent fallbacks.
- Immutable update patterns in stores.
- Comments only where the *why* is non-obvious.

## License

[Apache 2.0](LICENSE)
