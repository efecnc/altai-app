import { openUrl } from "@tauri-apps/plugin-opener";
import { currentWorkspaceFolder } from "@/modules/workspace/folder";
import { resolvePath } from "./paths";

/** Open a workspace file in the editor via the app-wide event bus. */
export function openWorkspaceFile(path: string): void {
  const trimmed = path.trim();
  if (!trimmed) return;
  let resolved = trimmed;
  if (!trimmed.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    const root = currentWorkspaceFolder();
    if (root) {
      try {
        resolved = resolvePath(trimmed.replace(/^\.\//, ""), root);
      } catch {
        // Keep the original path; App's open handler will surface the miss.
      }
    }
  }
  window.dispatchEvent(
    new CustomEvent<string>("altai:open-file", { detail: resolved }),
  );
}

export function isWebHref(href: string): boolean {
  return /^(https?|mailto|tel):/i.test(href.trim());
}

/**
 * Convert a markdown href into an absolute filesystem path when it points at
 * a local file (absolute, `file://`, or workspace-relative). Returns null for
 * web URLs or unresolvable relatives.
 */
export function hrefToFilePath(
  href: string,
  workspaceRoot: string | null,
): string | null {
  const raw = href.trim();
  if (!raw || raw === "streamdown:incomplete-link") return null;
  if (isWebHref(raw)) return null;

  let path = raw;
  if (/^file:/i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
      // Windows: file:///C:/Users/... → pathname `/C:/Users/...`
      if (/^\/[a-zA-Z]:[\\/]/.test(path)) path = path.slice(1);
    } catch {
      path = path.replace(/^file:\/\//i, "");
    }
  }

  if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return path;

  if (!workspaceRoot) return null;
  try {
    return resolvePath(path.replace(/^\.\//, ""), workspaceRoot);
  } catch {
    return null;
  }
}

/**
 * Open a chat markdown href: workspace files go to the editor, web URLs to
 * the system browser via Tauri's opener plugin.
 */
export async function openChatHref(href: string): Promise<void> {
  const trimmed = href.trim();
  if (!trimmed || trimmed === "streamdown:incomplete-link") return;

  if (isWebHref(trimmed)) {
    await openUrl(trimmed);
    return;
  }

  const filePath = hrefToFilePath(trimmed, currentWorkspaceFolder());
  if (filePath) {
    openWorkspaceFile(filePath);
    return;
  }

  // Bare host-looking strings (rare in markdown, common in tool output).
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:?]|$)/i.test(trimmed)) {
    await openUrl(`https://${trimmed}`);
  }
}
