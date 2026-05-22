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
  <a href="#-adaptive-ml-agent">Adaptive ML</a> ·
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

At the center of ALTAI's ML side is the **[Adaptive ML agent](#-adaptive-ml-agent)** — a discovery-first agent that turns open-ended ML requests ("fine-tune Llama on our legal docs", "fix my agent's tool calls", "serve this 70B cheaply") into research → pilot → evaluate → scale loops. No hard-coded recipes; the agent surveys the 2026 literature, runs the smallest verifiable pilots in parallel, presents numeric tradeoffs, then scales the winner.

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
- ✨ **[Adaptive ML agent](#-adaptive-ml-agent)** — open-ended ML requests (fine-tune, RAG, quantize, serve, evaluate, debug a training run) become an 8-step *discover → research → enumerate → pilot → evaluate → scale → verify → persist* loop. The agent surveys current literature, runs the smallest verifiable pilots in parallel, presents numeric tradeoffs, and only commits after evidence. No hard-coded recipes.
- 🤖 **10 built-in agents, fully editable** — Coder, Architect, Code Reviewer, Security, Designer, plus four ML-focused agents (**Adaptive ML**, Paper Reproducer, Notebook Assistant, Dataset Generator). Override instructions, disable what you don't need, reset to defaults at any time.
- 🧠 **Single embedded agent runtime** — every chat goes through the in-process [**IsanAgent**](#-isanagent) Rust runtime: 44 tools, sub-agent DAGs, SQLite FTS5 memory, and a workspace-scoped execution harness (local · Jupyter · SSH · free Colab GPU). The model picker in the toolbar selects which provider IsanAgent calls (Anthropic native; OpenAI, xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter, and Gemini via OpenAI-compatible endpoints; or self-hosted options like LM Studio, MLX, and generic OpenAI-compatible servers).
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

> **Building from source skips the security warnings entirely** — no `xattr`, no SmartScreen, no Gatekeeper. The locally-produced binary is implicitly trusted on the machine that produced it. See **[INSTALL.md → Build from source](INSTALL.md#build-from-source)** for the full prerequisites + commands + per-platform troubleshooting.

## Agents

ALTAI ships ten first-class agents. Each one is editable from the in-app **Agent Switcher** — change the system prompt, rename, disable, or reset to default. Every agent runs on the embedded IsanAgent runtime; the picker chooses the persona, the toolbar's model dropdown chooses the upstream provider.

The picker groups the four ML-domain agents (**Adaptive ML**, Paper Reproducer, Notebook Assistant, Dataset Generator) under an **ML Agents ▸** submenu so the general-purpose agents stay one click away. The active agent is always reflected on the toolbar trigger.

| Agent                  | Domain                                       | Highlights                                                                            |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Adaptive ML** ✨     | Open-ended ML requests                        | Discovers its own solution. Research → enumerate → pilot → evaluate → scale → verify → persist. See [section below](#-adaptive-ml-agent). |
| **Coder**              | General-purpose engineering                  | Pair-programs in your terminal, matches existing patterns, runs project checks.       |
| **Architect**          | System design & tradeoffs                    | Restates the problem, surfaces 2–3 options with real tradeoffs before any code.        |
| **Code Reviewer**      | Diff review                                  | Flags logic bugs, races, perf cliffs, security — skips formatting nits.                |
| **Security**           | Threat modeling                              | Walks trust boundaries, scores severity, proposes class-of-bug fixes.                  |
| **Designer**           | UI/UX critique                               | Specific, opinionated taste; Tailwind/CSS values where useful.                        |
| **Paper Reproducer**   | arXiv → working code                         | Reads the paper, extracts the architecture, emits runnable PyTorch.                    |
| **Notebook Assistant** | Jupyter / data-science workflows             | Cell-scoped edits, visualization-first, runs cells via the execution harness.          |
| **Dataset Generator**  | Synthetic SFT / DPO / tool-calling datasets  | Built on top of [**Afterimage**](#-afterimage). Pilot → verify → scale.                |
| **Custom**             | Bring your own                               | Define your own agent, tune the system prompt; runtime is IsanAgent.                   |

<!--
  Drop an agent-switcher screenshot or GIF here.
  Suggested capture: open AgentSwitcher panel, scroll through agents,
  click "Edit" on Paper Reproducer, show the instructions editor.
-->
<p align="center">
  <img src="docs/media/agent-switcher.png" alt="Agent switcher" width="720" />
</p>

## ✨ Adaptive ML Agent

The flagship of ALTAI's ML side. Where the other agents do one specialized job (read this paper, write this notebook, generate this dataset), **Adaptive ML accepts open-ended ML requests and finds its own way through them**.

> "Fine-tune Llama-3 on our legal docs."
> "My agent fails BFCL — get it above 75."
> "Serve this 70B for $500/month."
> "Beat MathArena AIME 2026 at 50%+."

Same agent. Four wildly different paths. No hard-coded recipes — every step is *discovered* via research and pilots.

### The 8-step meta-pattern

Every Adaptive ML run follows the same loop. Which modules, libraries, and hyperparameters get chosen is the *output* of the loop, not the input.

```
1. UNDERSTAND  → parse the request, ask if data / GPU budget / target metric missing
                 write a verifiable goal: "X metric >= Y on dataset Z"
2. RESEARCH    → arxiv_search + web_search + hf_hub_file_fetch + search_memory
                 last 12 months only; no method picked yet
3. ENUMERATE   → propose 2-4 candidate paths with cost + cited failure modes
4. PILOT       → smallest verifiable version of each path, in parallel
                 (50-100 steps, 1% of data, 100 docs, …)
                 pass criteria written BEFORE running
5. EVALUATE    → compare against goal proxy; reject failures
                 close calls → present numeric tradeoff to ask_user
6. SCALE       → run the winner at full budget; monitor sub-agent tails logs
7. VERIFY      → final eval against the real goal; on miss, loop back to 3
                 with the failure class identified
8. PERSIST     → write a memory delta; emit a SKILL.md if a path won 3x
```

### What's fixed vs what's discovered

| Fixed (hard-coded)                                                    | Discovered (per request)                            |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| IsanAgent runtime + 44 tools + execution harness + cron + doom-loop   | Which tool to call, in what order                    |
| Afterimage modules (Magpie SFT, multi-judge DPO, APIGen-MT, RAGAS-QA) | Whether data needs generating; if so, which modules  |
| The 8-step loop itself                                                | What happens inside each step                        |
| The *existence* of a capability catalog                               | Which library / format / algorithm gets picked       |
| Doom-loop defense (3× same call → strategy change; 150% budget → ask) | When defense triggers                                |
| Memory + SKILL.md emission discipline                                 | Which patterns rise to skill status                  |

### The capability catalog the agent picks from

The agent has explicit knowledge of the 2026 landscape across every ML stage. It does not commit to any of these until research and pilots justify it.

- **Data generation** — [Afterimage](#-afterimage) (Magpie SFT, multi-judge DPO/KTO/ORPO with Krippendorff α, APIGen-MT tool-calling traces, RAGAS-style document-grounded QA, structured-output, MCQ). Croissant + HF Dataset Card emit by default.
- **Filtering & dedup** — datatrove MinHash, SemDeDup, FineWeb-Edu classifier, n-gram contamination check, Presidio PII.
- **Training** — Unsloth, TRL, Axolotl, LLaMA-Factory, torchtune, verl, OpenRLHF, NeMo-Aligner.
- **PEFT** — LoRA, QLoRA (NF4 + double-quant), DoRA, rsLoRA, LoftQ.
- **Preference / RL** — DPO, KTO, ORPO, SimPO, IPO, GRPO, DAPO, RLOO, OnlineDPO.
- **Quantization** — AWQ (GPTQModel + Marlin), GPTQ, W8A8 INT (llm-compressor + SmoothQuant), FP8 E4M3, GGUF Q4_K_M / IQ4_XS, EXL3, HQQ, AQLM.
- **Serving** — vLLM (V1), SGLang, LMDeploy, llama.cpp, Ollama, MLX-LM, ExLlamaV3 + TabbyAPI, TensorRT-LLM, ExecuTorch.
- **Speculative decoding** — EAGLE-3, DeepSeek MTP, Medusa, Lookahead.
- **RAG** — bge-m3 / Qwen3-Embedding / voyage-3, pgvector / Qdrant / LanceDB, bge-reranker-v2-m3 / mxbai-rerank, Contextual Retrieval / RAPTOR / GraphRAG / CRAG / Self-RAG, ColBERT late-interaction.
- **Eval** — lm-evaluation-harness, lighteval, Inspect AI, OpenCompass, HELM, DeepEval, RAGAS. Benchmarks: MMLU-Pro, GPQA, HLE, MathArena (live), BFCL v3, τ³-bench, OSWorld-Verified, BigCodeBench, LiveCodeBench (live), Aider Polyglot, IFEval, Arena-Hard v2, RULER, AILuminate.

Contaminated / saturated benchmarks (MMLU, HumanEval, HellaSwag, GSM8K, SWE-bench Verified) are treated as smoke tests only. Benchmark currency is re-verified every run via `arxiv_search("benchmark contamination 2026")`.

### Worked example: same request, different paths

Two trajectories from real Adaptive ML runs — same meta-pattern, completely different conclusions.

> **"Cheap serve our 70B model — $500/month, p99 < 3s."**
> Research surfaces three paths: W4A16 quantize + spot H100, distill to 8B, or hybrid routing (easy queries → 8B, hard → 70B). All three get piloted in parallel.
> Results: quantize $720/mo (over budget), distill $90/mo with –3% quality, routing $140/mo with same quality but +400 ms p99. Agent presents the numeric tradeoff. User picks routing.
> Scale + verify lands at $138/mo, p99 2.7s. Memory delta written: *"cheap-serve-70B: routing won when quality floor was hard."*

> **"My agent fails BFCL — get it above 75 (currently 58)."**
> Research surfaces APIGen-MT, xLAM, ToolACE. Three candidates: prompt engineering, APIGen-MT data + SFT, or APIGen-MT + GRPO with execution reward. Pilots run.
> Results: prompt-only ceilings at 62; SFT alone hits 78 on mini-BFCL. GRPO not needed — rejected for cost. Scale runs the full 60k APIGen-MT trace SFT.
> Final BFCL v3: 79.2. Skill emitted after this is the 3rd successful tool-calling improvement: `agent-tool-calling-improvement.md`.

### Why this works

The agent has the tools to research (`arxiv_search`, `web_search`, `hf_hub_file_fetch`), the harness to pilot at scale (`execution_run_background` on local / Jupyter / SSH / free Colab GPU), the discipline to evaluate (gated pilot criteria, numeric tradeoffs), the memory to learn (`search_memory` + auto-emitted skills), and the defenses to stop runaway loops (doom-loop detection, 150 % budget cap). The instruction binds them into one loop.

Every part of this is editable from the in-app Agent Switcher. Disable steps, change the catalog, lower the budget cap, swap the eval gate — all via the Adaptive ML agent's system prompt.

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

One runtime, one chat surface:

- Every chat — Coder, Architect, Reviewer, Security, Designer, the four ML agents, and any custom agent you create — runs on the embedded **IsanAgent** Rust runtime in-process. No sidecar, no IPC over the network.
- The toolbar's **model picker** chooses which upstream provider IsanAgent calls. Anthropic uses the native Messages API; everything else routes through the OpenAI-compatible chat-completions endpoint for that provider (xAI, Cerebras, Groq, DeepSeek, Mistral, OpenRouter, Gemini's OpenAI-compat endpoint, and self-hosted LM Studio / MLX / generic OpenAI-compatible servers).
- The agent's `instructions` field (editable in **Settings → Agents**) is appended to IsanAgent's compiled system prompt at runtime startup, so personas survive across the full runtime — sub-agent DAGs, persistent memory, the execution harness, and the doom-loop defense.

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
pnpm tauri:dev          # hot-reload dev mode
pnpm tauri:build        # production bundle (.dmg / .msi / .deb / .AppImage)
```

Pre-PR checks (also gated by CI):

```bash
pnpm build                                          # tsc + vite production build
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all
pnpm test                                           # vitest unit tests
```

Full per-platform prerequisites, bundle output paths, and source-build troubleshooting live in **[INSTALL.md → Build from source](INSTALL.md#build-from-source)** — recommended even if you just want to avoid the unsigned-binary warnings on download.

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
