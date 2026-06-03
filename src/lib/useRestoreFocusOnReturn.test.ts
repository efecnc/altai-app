import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-level regression test for the screen-reader focus-restore fix.
 *
 * The actual behaviour — VoiceOver / NVDA / Narrator re-entering the webview
 * content after an app-switch — can only be confirmed by a manual pass with a
 * live screen reader on the running app (it depends on the OS first-responder
 * transition, which has no headless harness). What we CAN lock down here are
 * the two layers of the fix:
 *
 *  1. NATIVE re-focus, in Rust on `WindowEvent::Focused(true)` (lib.rs). This
 *     is the part that actually un-strands the screen reader; the JS
 *     `setFocus()` IPC was tried and failed (notably on Windows), so guard
 *     against anyone reverting to a JS-only / no-op approach.
 *  2. ELEMENT restore, in this hook.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const raw = readFileSync(path.join(here, "useRestoreFocusOnReturn.ts"), "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const libRs = readFileSync(
  path.join(here, "..", "..", "src-tauri", "src", "lib.rs"),
  "utf8",
);

describe("screen-reader focus restore — native layer (Rust)", () => {
  it("re-asserts native webview focus on window focus-regain", () => {
    // The proven fix: re-install the webview as OS first responder when the
    // window is re-activated. Removing this re-breaks VoiceOver/NVDA/JAWS.
    expect(libRs).toMatch(/\.on_window_event\(/);
    expect(libRs).toMatch(/WindowEvent::Focused\(true\)/);
    expect(libRs).toMatch(/\.set_focus\(\)/);
  });

  it("targets the primary webview, not embedded child webviews", () => {
    // Looping all webviews would (last-wins) focus an embedded external
    // browser tab; we must focus the window's own webview by label.
    expect(libRs).toMatch(/get_webview\(\s*window\.label\(\)\s*\)/);
  });

  it("re-asserts once more on Windows to beat WebView2's async focus settle", () => {
    // The earlier attempt failed for JAWS/NVDA on Windows because the focus
    // call landed too early; a short delayed retry covers the async settle.
    expect(libRs).toMatch(/cfg!\(target_os = "windows"\)/);
  });
});

describe("useRestoreFocusOnReturn — element layer (JS)", () => {
  it("triggers on window focus regain only", () => {
    expect(code).toMatch(/onFocusChanged/);
    expect(code).toMatch(/if\s*\(\s*!\s*focused\s*\)\s*return/);
  });

  it("restores the precise last-focused element on the next frame", () => {
    expect(code).toMatch(/addEventListener\(\s*["']focusin["']/);
    expect(code).toMatch(/requestAnimationFrame/);
    expect(code).toMatch(/\.focus\(/);
  });

  it("does not gate behind a platform check", () => {
    // The original bug was a Windows-only gate; reintroducing one is the
    // exact regression to guard against.
    expect(code).not.toMatch(/IS_WINDOWS/);
    expect(code).not.toMatch(/navigator\s*\.\s*userAgent/);
  });

  it("cleans up its listeners on unmount", () => {
    expect(code).toMatch(/removeEventListener\(\s*["']focusin["']/);
    expect(code).toMatch(/unlisten/);
  });
});
