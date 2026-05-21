# Installing ALTAI

Releases live on the [GitHub Releases page](https://github.com/efecnc/altai-app/releases). Download the file matching your platform from the latest `v*` tag.

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

## Self-build from source (alternative to downloads)

If you'd rather build locally and skip the unsigned-binary warnings entirely:

```bash
git clone https://github.com/efecnc/altai-app
cd altai
pnpm install
pnpm tauri:build
```

The bundles land under `src-tauri/target/release/bundle/` for your current platform.

Requires: Rust stable, Node 22+, pnpm 9+, and the platform-specific build deps (see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)).
