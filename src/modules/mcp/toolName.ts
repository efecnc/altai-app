/** Metadata encoded in an agent-facing dynamically discovered MCP tool name. */
export type McpToolInfo = { server: string; tool: string };

/** MCP tools are registered natively as `mcp_<server>_<tool>`. */
export function parseMcpToolName(name: string): McpToolInfo | null {
  if (!name.startsWith("mcp_")) return null;
  const [, server, ...toolParts] = name.split("_");
  if (!server || toolParts.length === 0) return null;
  return { server: humanize(server), tool: humanize(toolParts.join("_")) };
}

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
