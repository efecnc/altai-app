import { invoke } from "@tauri-apps/api/core";

export type McpServerConfig = {
  id: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
};

export type McpProbeResult = {
  tools: Array<{ name: string; description: string }>;
};

/** Live connection state of one MCP server within a workspace. Mirrors the
 *  Rust `McpServerStatus` / `McpState` contract in `src-tauri/.../mcp.rs`.
 *  There is no `disabled` state — a disabled server simply has no registry
 *  entry, and the Settings UI shows the "Disabled" outline badge from the
 *  persisted `enabled` field instead. */
export type McpState = "starting" | "connected" | "error";

export type McpServerStatus = {
  serverId: string;
  state: McpState;
  toolCount?: number;
  lastError?: string;
  updatedAtMs: number;
};

export function getMcpServers(workspacePath: string) {
  return invoke<McpServerConfig[]>("mcp_get_servers", { workspacePath });
}

export function saveMcpServers(
  workspacePath: string,
  servers: McpServerConfig[],
) {
  return invoke<void>("mcp_save_servers", { workspacePath, servers });
}

export function probeMcpServer(
  workspacePath: string,
  server: McpServerConfig,
) {
  return invoke<McpProbeResult>("mcp_probe_server", { workspacePath, server });
}

/** Poll the live runtime status of every MCP server in a workspace. Absent
 *  entries (servers the runtime never connected) are treated as a fresh
 *  `disabled`-equivalent by the UI. Used by the Settings card to show
 *  `connected / error / starting` badges independent of the Test probe. */
export function getMcpServerStatus(workspacePath: string) {
  return invoke<McpServerStatus[]>("mcp_server_status", { workspacePath });
}
