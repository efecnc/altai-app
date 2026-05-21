# README media

The top-level `README.md` references four media files that live in this folder.
None of them are recorded yet — capture them from inside the running app, drop
them in here with the exact filenames below, and they'll show up on GitHub.

| File                       | Type | Suggested capture                                                                                                                                                                          | Size hint            |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `hero.gif`                 | GIF  | Full window. User types a prompt → agent reads a file → proposes an edit (Ask-before-edit modal) → user approves → terminal runs the project's tests and they pass.                          | ~820px wide, 8–12s   |
| `permission-modes.gif`     | GIF  | Open `PermissionModeSwitcher`, cycle through *Ask before edit* → *Edit automatically* → *Bypass permissions* (with the Settings toggle), then approve a single Ask-before-edit prompt.       | ~720px wide, 6–8s    |
| `agent-switcher.png`       | PNG  | `AgentSwitcher` panel open with the nine built-in agents visible; ideally with the *Edit* sheet open over **Paper Reproducer** so the editable instructions are visible.                    | ~720px wide          |
| `paper-reproducer.gif`     | GIF  | Paste an arXiv URL → agent calls `arxiv_fetch` → proposes the model file structure → writes the cells → kicks off training on Colab MCP → first loss value streams back into the chat.       | ~820px wide, 15–20s  |

## Recording tips

- **macOS:** QuickTime for raw capture, then convert to GIF with
  `ffmpeg -i input.mov -vf "fps=18,scale=820:-1:flags=lanczos,palettegen" palette.png`
  followed by `ffmpeg -i input.mov -i palette.png -filter_complex "fps=18,scale=820:-1[x];[x][1:v]paletteuse" hero.gif`.
- Keep GIFs under ~5 MB so GitHub doesn't lazy-load them; drop the fps to 15
  or trim the clip if you're over budget.
- Hide personal paths, tokens, and any in-progress projects before recording.
- Use a clean demo workspace (a fresh `cargo new` or `vite` scaffold) so the
  attention stays on the agent's behavior, not on unrelated repo noise.

Once a file lands here, the matching `<img>` tag in the top-level README will
pick it up automatically — no further edits needed.
