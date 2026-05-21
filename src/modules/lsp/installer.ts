/**
 * Type-safe wrapper around the Rust `lsp_install_*` commands.
 *
 * Keep this file thin — the goal is to give callers (`useLanguageServer`,
 * the LSP Settings section) a TypeScript-typed handle on the backend's
 * install surface. Business logic (when to install, when to ask, how to
 * present errors) belongs in the consumers, not here.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

import type {
  InstallPhase,
  LspInstallStatus,
  LspManifest,
} from "./manifest";

/** Return every LSP manifest known to the backend registry. */
export async function listRegistry(): Promise<LspManifest[]> {
  return invoke<LspManifest[]>("lsp_registry_list");
}

/** Look up a single manifest by id. Returns `null` if the id is unknown. */
export async function getManifest(id: string): Promise<LspManifest | null> {
  const result = await invoke<LspManifest | null>("lsp_registry_get", { id });
  return result ?? null;
}

/** "Is this LSP installed?" — checks managed install first, then PATH. */
export async function getInstallStatus(
  id: string,
): Promise<LspInstallStatus> {
  return invoke<LspInstallStatus>("lsp_install_status", { id });
}

/**
 * Trigger an install. The returned promise resolves with the installed
 * binary path once the backend finishes; in the meantime `onProgress`
 * fires for every phase frame the Rust side emits.
 *
 * Errors surface as a rejected promise. The progress channel will also
 * have received a `{kind: "failed"}` frame with the same message.
 */
export async function runInstall(
  id: string,
  onProgress: (phase: InstallPhase) => void,
): Promise<string> {
  const channel = new Channel<InstallPhase>();
  channel.onmessage = (phase) => {
    onProgress(phase);
  };
  try {
    return await invoke<string>("lsp_install_run", {
      id,
      onProgress: channel,
    });
  } finally {
    // Detach the listener so a late frame from a cancelled / completed
    // install doesn't reach a consumer that has already moved on.
    channel.onmessage = () => undefined;
  }
}

/**
 * Signal the in-flight install for `id` to cancel. The corresponding
 * `runInstall` promise rejects with "cancelled" and its progress channel
 * receives a `cancelled` frame. No-op if nothing is installing.
 */
export async function cancelInstall(id: string): Promise<void> {
  await invoke("lsp_install_cancel", { id });
}

/**
 * Delete the managed install for `id`. Idempotent. Doesn't touch the
 * user's PATH-installed binary if any.
 */
export async function uninstallLsp(id: string): Promise<void> {
  await invoke("lsp_install_uninstall", { id });
}

/**
 * Resolve the path we should spawn for this LSP — managed > system > none.
 * Centralized here so `LspClient.start` and the Settings UI agree on the
 * resolution order.
 */
export async function resolveExecutablePath(
  id: string,
): Promise<string | null> {
  const status = await getInstallStatus(id);
  return status.managedPath ?? status.systemPath ?? null;
}
