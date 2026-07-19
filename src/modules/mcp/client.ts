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
