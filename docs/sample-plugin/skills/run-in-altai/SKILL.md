---
name: run-in-altai
description: Keep Colab and Jupyter work inside the ALTAI app. When the user or another agent asks to run something on Colab or in a Jupyter notebook, use ALTAI's native webview tab (Colab) and notebook tab (Jupyter) instead of sending the user to a browser or a separate `jupyter` process.
---

ALTAI ships first-class surfaces for both Colab and Jupyter. Use them. Never tell the user to "open colab.research.google.com in your browser" or "run `jupyter notebook` in a terminal" — the app already handles both inside the workspace.

## Colab

Trigger phrases: "open Colab", "run on Colab", "Colab GPU", "T4", "free GPU", an arXiv-paper reproduction request that needs a GPU, or any URL whose host is `colab.research.google.com` / `colab.google.com` / `*.colab.google.com`.

What to do:

1. Open the Colab URL as a tab in ALTAI. The preview layer auto-promotes Colab hosts to a native child webview (`WebviewStack`), so logins, runtimes, and cell execution work exactly as in a real browser. Use `newPreviewTab(url)` and let the promotion happen, or call `newWebviewTab(url)` directly for a fresh notebook (`https://colab.research.google.com/#create=true`).
2. For code execution against a Colab runtime that the agent needs to drive programmatically, route through the **Colab MCP bridge** that the IsanAgent runtime exposes (`python_run` + execution harness, provider = Colab). Do not shell out to `gcloud`, `colab-cli`, or scraped HTTP endpoints.
3. If multiple Colab notebooks are open, each gets its own isolated webview label (`wv-<tab id>`) — no shared session state, no login churn.

Do not:

- Iframe-embed Colab. The preview layer already refuses (X-Frame-Options); a webview tab is the only working path.
- Suggest the user copy code into Colab manually. The agent's `python_run` tool runs it via the harness.

## Jupyter

Trigger phrases: "open this notebook", "run the notebook", "edit cell …", "add a cell", any path ending in `.ipynb`, or a data-science / ML workflow that fits the **Notebook Assistant** built-in agent.

What to do:

1. Open the `.ipynb` with `openNotebookTab(path)`. This routes to `NotebookStack`, which parses the notebook with the in-tree ipynb parser and renders editable cells — not a read-only preview.
2. Run cells through the execution harness (provider = `jupyter` for a local kernel, `ssh` for remote, or `colab` for free GPU). Do not spawn a standalone `jupyter notebook` / `jupyter lab` server and point the user at `localhost:8888`.
3. When adding cells, keep each cell focused on one logical step (load → transform → visualize → train → evaluate). Mirror the existing notebook's cell granularity.
4. If the user asks for a new notebook, create the `.ipynb` on disk first, then open it with `openNotebookTab`. Do not paste cell content into the chat as a substitute.

Do not:

- Open `.ipynb` files as plain text in the editor tab. They have a dedicated notebook tab kind.
- Recommend `pip install jupyter` to the user as a setup step. The embedded harness handles kernels.

## Provider selection (when both surfaces apply)

If the task needs a free GPU and the user has no local CUDA device → Colab webview tab + Colab MCP execution.
If the user has a local Python environment and the task is CPU-bound or has a local GPU → Jupyter notebook tab + local execution provider.
If the user has an SSH-reachable box (lab cluster, remote workstation) → notebook tab + SSH provider.

When in doubt, ask once which surface to use, then commit.
