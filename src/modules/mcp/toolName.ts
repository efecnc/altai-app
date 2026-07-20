/** Metadata encoded in an agent-facing dynamically discovered MCP tool name. */
export type McpToolInfo = { server: string; tool: string };

/**
 * Parse an agent-facing MCP tool name into its `{ server, tool }` parts.
 *
 * Contract (canonical, written by `tool_name()` in `src-tauri/.../mcp.rs`):
 *   `mcp__<server>__<tool>` — double-underscore separators, where `<server>`
 *   and `<tool>` are normalized to `[a-z0-9-]`. The `__` boundary is always
 *   unambiguous regardless of underscores in either segment.
 *
 * Legacy fallback: names matching the deprecated single-underscore shape
 * `mcp_<server>_<tool>` (from older transcripts) still parse by assuming the
 * first underscore-separated segment is the server id. This is only
 * best-effort — server ids containing `_` were inherently ambiguous under the
 * old contract, which is exactly why it changed.
 */
export function parseMcpToolName(name: string): McpToolInfo | null {
  // Canonical: split on `__`. The leading `mcp__` prefix carries two
  // underscores, so splitting on `__` yields ["mcp", server, tool].
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
    return { server: humanize(parts[1]), tool: humanize(parts[2]) };
  }
  // Legacy: single-underscore `mcp_<server>_<tool>`. Best-effort for old
  // transcripts; assumes the second `_`-segment is the whole server id.
  if (name.startsWith("mcp_")) {
    const [, server, ...toolParts] = name.split("_");
    if (!server || toolParts.length === 0) return null;
    return { server: humanize(server), tool: humanize(toolParts.join("_")) };
  }
  return null;
}

function humanize(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
