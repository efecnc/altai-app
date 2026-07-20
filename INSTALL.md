# Installing ALTAI

Releases live on the [GitHub Releases page](https://github.com/altaidevorg/altai-app/releases). Download the file matching your platform from the latest `v*` tag.

> **Important.** ALTAI binaries are **unsigned** — they don't carry an Apple Developer or Windows EV certificate. Apple Gatekeeper and Windows SmartScreen will warn you the first time you launch the app. The steps below are a one-time bypass per machine; the app behaves normally afterwards.

---

## macOS

Pick the build matching your Mac:

- **Apple Silicon (M1/M2/M3/M4):** `ALTAI_<version>_aarch64.dmg`
- **Intel:** `ALTAI_<version>_x64.dmg`

Then:

1. Open the `.dmg` and drag `ALTAI.app` into `/Applications`.
2. Open Terminal and run **once**:

   ```bash
   xattr -dr com.apple.quarantine /Applications/ALTAI.app
   ```

3. Launch ALTAI normally — Gatekeeper will no longer block it.

> Without step 2, macOS will show "ALTAI is damaged and can't be opened" or "Apple could not verify ALTAI is free of malware." That's Gatekeeper rejecting the unsigned binary, not actual damage. The `xattr` command removes the quarantine flag that Safari/Finder attaches to downloaded files.

If you skipped step 2 and already got the prompt, you can also recover via System Settings → Privacy & Security → scroll to the bottom → "Open Anyway."

---

## Windows

Download `ALTAI_<version>_x64_en-US.msi` (preferred) or `ALTAI_<version>_x64-setup.exe`.

1. Double-click the installer.
2. Windows SmartScreen will show: *"Windows protected your PC."*
3. Click **More info** → **Run anyway**.
4. Complete the install wizard.

> SmartScreen warns because the binary isn't signed with an EV code-signing certificate. The warning disappears once Microsoft sees enough downloads of the same hash — but for v0.1.0, expect the prompt.

---

## Linux

Pick whichever package fits your distro:

- **Debian / Ubuntu / Mint:** `altai_<version>_amd64.deb`

  ```bash
  sudo apt install ./altai_0.1.0_amd64.deb
  ```

- **Fedora / RHEL / openSUSE:** `altai-<version>-1.x86_64.rpm`

  ```bash
  sudo dnf install ./altai-0.1.0-1.x86_64.rpm
  ```

- **Any distro (portable):** `altai_<version>_amd64.AppImage`

  ```bash
  chmod +x altai_0.1.0_amd64.AppImage
  ./altai_0.1.0_amd64.AppImage
  ```

> **AppImage runtime dependency:** newer Ubuntu releases (24.04+) may need `libfuse2`:
>
> ```bash
> sudo apt install libfuse2
> ```

Linux binaries are not subject to Gatekeeper / SmartScreen — no bypass step is needed.

---

## Verify the install

Launch ALTAI. You should see:

- The main window opens with an empty terminal.
- Click **Settings** → **About**: version should match the tag you installed.
- Try `/init` in the AI panel: ALTAI scans the workspace and proposes an `ALTAI.md` summary file.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| macOS: "ALTAI.app is damaged" | Quarantine flag from Safari | Run the `xattr -dr` command in the macOS section. |
| macOS: "App can't be opened because Apple cannot check it" | Gatekeeper, unsigned binary | Right-click the app → Open → confirm in the dialog, OR run the `xattr` command. |
| Windows: "Windows protected your PC" | SmartScreen, unsigned MSI | Click *More info* → *Run anyway*. |
| Linux: AppImage won't launch | Missing `libfuse2` | `sudo apt install libfuse2` (Ubuntu 24.04+). |
| Linux: `.deb` reports missing libraries | Missing GTK / WebKit deps | `sudo apt install libwebkit2gtk-4.1-0 libayatana-appindicator3-1`. |
| ALTAI starts but the AI panel says "no API key" | Models not configured | Settings → Models, paste a provider API key (stored in your OS keychain). |

---

## Build from source

Building locally is the cleanest install path: no Gatekeeper / SmartScreen warnings, no `xattr` workaround, and you can audit every line of what you're running. A locally-built binary is implicitly trusted on the machine that produced it — macOS ad-hoc-signs your build, and Windows skips SmartScreen because the file never carries the "downloaded from the internet" zone identifier.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| **Rust** | stable (1.80+) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Node.js** | 22+ | [nodejs.org](https://nodejs.org/) or `nvm install 22 && nvm use 22` |
| **pnpm** | 9+ | `corepack enable && corepack prepare pnpm@latest --activate` (or `npm i -g pnpm`) |
| **Platform deps** | — | See below |

#### macOS

```bash
xcode-select --install
```

That's it. Xcode Command Line Tools provide the linker and SDK headers Tauri needs.

#### Linux (Debian / Ubuntu / Mint)

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libgtk-3-dev \
  build-essential \
  curl \
  wget \
  file \
  pkg-config
```

Fedora / RHEL / openSUSE: install the equivalent `webkit2gtk4.1-devel`, `openssl-devel`, `libappindicator-gtk3-devel`, `librsvg2-devel`, `gtk3-devel`, plus `gcc`, `gcc-c++`, `make`.

#### Windows

- **Microsoft Visual Studio Build Tools 2022** with the "Desktop development with C++" workload (provides MSVC + Windows SDK).
- **WebView2 Runtime** — preinstalled on Windows 11. On Windows 10, install from the [Microsoft Edge WebView2 page](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

The full upstream list lives at [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) if you hit something exotic.

### Clone and install

```bash
git clone https://github.com/altaidevorg/altai-app
cd altai-app
pnpm install
```

The first `pnpm install` is also when Tauri pulls down Rust crates — expect a few minutes the first time, near-instant on subsequent runs.

### Two ways to run

**Hot-reload dev mode (recommended for poking around):**

```bash
pnpm tauri:dev
```

Opens an ALTAI window directly. Edits to `src/` hot-reload, edits to `src-tauri/` rebuild Rust and relaunch the app. No DMG / MSI / AppImage produced — this is the inner-loop dev experience.

**Production bundle (what you'd actually install):**

```bash
pnpm tauri:build
```

Compiles in release mode and assembles the platform-native installer(s). Takes 5–15 minutes depending on machine. Bundles land at:

| Platform | Bundle path (relative to repo root) |
|----------|-------------------------------------|
| macOS    | `src-tauri/target/release/bundle/macos/ALTAI.app` and `bundle/dmg/ALTAI_<version>_<arch>.dmg` |
| Windows  | `src-tauri/target/release/bundle/msi/ALTAI_<version>_x64_en-US.msi` and `bundle/nsis/ALTAI_<version>_x64-setup.exe` |
| Linux    | `src-tauri/target/release/bundle/deb/*.deb`, `bundle/rpm/*.rpm`, and `bundle/appimage/*.AppImage` |

Drop the `.app` into `/Applications`, install the `.msi` / `.deb` / `.rpm`, or just run the AppImage — same UX as the official downloads, **minus the security warnings**.

### Sanity checks before opening a PR

```bash
pnpm build                                          # tsc + vite production build
cargo check --manifest-path src-tauri/Cargo.toml    # Rust type check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -W clippy::all
pnpm test                                           # vitest unit tests
```

CI runs all four on every push. Type-check failures are the most common cause of red builds.

### Troubleshooting source builds

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `error: linker 'cc' not found` (macOS) | Missing Xcode CLT | `xcode-select --install` |
| `Package webkit2gtk-4.1 was not found` (Linux) | Missing GTK dev headers | Install the deps listed above; the package name on older Ubuntu is `libwebkit2gtk-4.0-dev` |
| `error MSB8036: The Windows SDK version was not found` | Missing Windows SDK | Install Visual Studio Build Tools 2022 with the Desktop C++ workload |
| `error: could not compile 'tauri-build'` after pulling main | Rust toolchain drift | `rustup update stable && cargo clean --manifest-path src-tauri/Cargo.toml` |
| `pnpm install` hangs on `postinstall` | Corporate proxy blocking `cargo fetch` | Set `CARGO_HTTP_PROXY` and `HTTPS_PROXY` env vars before installing |
| `pnpm tauri:dev` shows a blank white window | Vite dev server didn't start | Check terminal output — usually a port conflict. Free port 1420 or set `VITE_PORT` in `.env.local` |
| Build succeeds but DMG step fails on macOS | `create-dmg` permission prompt | Re-run with the terminal in the foreground; macOS needs you to approve the AppleScript that drives `create-dmg` |
| AppImage from your build won't launch on another distro | glibc / openssl version skew | Build inside an Ubuntu 22.04 container for the broadest compatibility, or distribute the `.deb` / `.rpm` instead |

### Why this avoids the unsigned-binary warnings

- **macOS:** Tauri ad-hoc-signs your build with the local identity. The binary never receives the `com.apple.quarantine` extended attribute (that flag is only attached by Safari, Mail, AirDrop, and similar download surfaces). Gatekeeper sees a locally-produced binary and lets it run.
- **Windows:** A `.msi` you produced yourself doesn't carry the Mark-of-the-Web Alternate Data Stream that SmartScreen checks. The reputation lookup is skipped and the installer runs without the "Windows protected your PC" dialog.
- **Linux:** No Gatekeeper-equivalent; source builds and binary downloads are treated identically.

If you later move the artifact to another machine (USB / network share / Slack), reapply the same security-bypass steps from the macOS and Windows sections above — the moment a file crosses a download boundary, the OS re-applies its mark.
