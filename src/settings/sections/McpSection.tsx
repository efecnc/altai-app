import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getMcpServerStatus,
  getMcpServers,
  probeMcpServer,
  saveMcpServers,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerStatus,
  type McpState,
} from "@/modules/mcp/client";
import { currentWorkspaceFolder } from "@/modules/workspace/folder";
import {
  Add01Icon,
  Alert02Icon,
  CheckmarkCircle02Icon,
  Delete01Icon,
  PlayIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

type Result =
  | { kind: "idle" }
  | { kind: "success"; serverId: string; probe: McpProbeResult }
  | { kind: "error"; serverId?: string; message: string };

function serverId(name: string, command: string) {
  const source = name.trim() || command.trim() || "server";
  const id = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return id || "server";
}

function uniqueId(seed: string, servers: McpServerConfig[]) {
  if (!servers.some((server) => server.id === seed)) return seed;
  let suffix = 2;
  while (servers.some((server) => server.id === `${seed}-${suffix}`)) suffix += 1;
  return `${seed}-${suffix}`;
}

export function McpSection() {
  const workspace = currentWorkspaceFolder();
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  // Live runtime status per server id — polled from the Rust status registry
  // so the card shows `connected / error / starting` independent of the
  // per-Test-click probe. Keyed by serverId for O(1) lookup in render.
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");

  const reload = useCallback(async () => {
    if (!workspace) {
      setServers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setServers(await getMcpServers(workspace));
      setResult({ kind: "idle" });
    } catch (error) {
      setResult({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  const reloadStatuses = useCallback(async () => {
    if (!workspace) {
      setStatuses({});
      return;
    }
    try {
      const snapshot = await getMcpServerStatus(workspace);
      // Skip the setState when the registry returned structurally identical
      // data — otherwise the 4s poll re-renders the whole section (form
      // inputs + every card) even when nothing changed. The signature is a
      // cheap per-id fingerprint of the fields the UI actually reads.
      setStatuses((prev) => {
        const nextSig = signatureFor(snapshot);
        if (nextSig === signatureFor(Object.values(prev))) return prev;
        return Object.fromEntries(snapshot.map((s) => [s.serverId, s]));
      });
    } catch {
      // Status is advisory — a transient fetch failure just leaves the last
      // known state rather than surfacing an error banner.
    }
  }, [workspace]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Poll the runtime status registry. The registry only changes when an agent
  // instance is (re)built, so a 4s interval is plenty — it's not a hot path.
  // The poll self-cancels when the section unmounts or the workspace changes.
  useEffect(() => {
    void reloadStatuses();
    const timer = window.setInterval(() => void reloadStatuses(), 4000);
    return () => window.clearInterval(timer);
  }, [reloadStatuses]);

  const canAdd = useMemo(
    () => !!workspace && !!name.trim() && !!command.trim() && !saving,
    [workspace, name, command, saving],
  );

  async function persist(next: McpServerConfig[]) {
    if (!workspace) throw new Error("Open a workspace before configuring MCP.");
    setSaving(true);
    try {
      await saveMcpServers(workspace, next);
      setServers(next);
    } finally {
      setSaving(false);
    }
  }

  async function addServer() {
    if (!canAdd) return;
    let parsedEnv: Record<string, string> = {};
    try {
      if (env.trim()) {
        const raw: unknown = JSON.parse(env);
        if (!raw || Array.isArray(raw) || typeof raw !== "object") {
          throw new Error("Environment must be a JSON object.");
        }
        parsedEnv = Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [key, String(value)]),
        );
      }
      const next = [
        ...servers,
        {
          id: uniqueId(serverId(name, command), servers),
          name: name.trim(),
          command: command.trim(),
          args: args.split("\n").map((value) => value.trim()).filter(Boolean),
          env: parsedEnv,
          enabled: true,
        },
      ];
      await persist(next);
      setName("");
      setCommand("");
      setArgs("");
      setEnv("");
      setResult({ kind: "idle" });
    } catch (error) {
      setResult({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function removeServer(id: string) {
    try {
      await persist(servers.filter((server) => server.id !== id));
      if (result.kind !== "idle" && result.serverId === id) setResult({ kind: "idle" });
    } catch (error) {
      setResult({
        kind: "error",
        serverId: id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function toggleServer(server: McpServerConfig) {
    try {
      await persist(
        servers.map((candidate) =>
          candidate.id === server.id ? { ...candidate, enabled: !candidate.enabled } : candidate,
        ),
      );
    } catch (error) {
      setResult({
        kind: "error",
        serverId: server.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function testServer(server: McpServerConfig) {
    if (!workspace) return;
    setTesting(server.id);
    setResult({ kind: "idle" });
    try {
      const probe = await probeMcpServer(workspace, server);
      setResult({ kind: "success", serverId: server.id, probe });
    } catch (error) {
      setResult({
        kind: "error",
        serverId: server.id,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="MCP"
        description="Connect Model Context Protocol servers to ALTAI. A test performs the real initialize + tools/list handshake; enabled servers are loaded as agent tools on the next chat run."
      />

      {!workspace ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-5 text-[12px] text-muted-foreground">
          Open a workspace first. MCP server settings are stored in its <code>.isanagent/mcp.json</code> file.
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/60 p-5">
            <h3 className="text-[13px] font-medium">Add an MCP server</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label htmlFor="mcp-server-name" className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground">
                Name
                <Input id="mcp-server-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Filesystem" className="text-[12.5px]" />
              </label>
              <label htmlFor="mcp-server-command" className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground">
                Command
                <Input id="mcp-server-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" className="text-[12.5px]" />
              </label>
            </div>
            <label htmlFor="mcp-server-args" className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground">
              Arguments <span className="font-normal">(one argument per line)</span>
              <Textarea id="mcp-server-args" value={args} onChange={(event) => setArgs(event.target.value)} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'} className="min-h-20 resize-y font-mono text-[11.5px]" />
            </label>
            <label htmlFor="mcp-server-env" className="flex flex-col gap-1.5 text-[11px] font-medium text-muted-foreground">
              Environment <span className="font-normal">(optional JSON object)</span>
              <Input id="mcp-server-env" value={env} onChange={(event) => setEnv(event.target.value)} placeholder={'{"API_TOKEN":"…"}'} className="font-mono text-[11.5px]" />
            </label>
            <div><Button size="sm" onClick={() => void addServer()} disabled={!canAdd} className="gap-1.5"><HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />Add server</Button></div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-medium">Configured servers</h3>
            <Button size="sm" variant="ghost" onClick={() => { void reload(); void reloadStatuses(); }} disabled={loading} className="h-7 gap-1.5 text-[11px]"><HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} />Refresh</Button>
          </div>

          {loading ? <p className="text-[12px] text-muted-foreground">Loading MCP servers…</p> : null}
          {!loading && servers.length === 0 ? <p className="rounded-xl border border-dashed border-border/70 px-4 py-5 text-[12px] text-muted-foreground">No MCP servers configured for this workspace.</p> : null}
          <div className="flex flex-col gap-3">
            {servers.map((server) => {
              const success = result.kind === "success" && result.serverId === server.id ? result.probe : null;
              const error = result.kind === "error" && (!result.serverId || result.serverId === server.id) ? result.message : null;
              const runtime = statuses[server.id];
              return <div key={server.id} className="rounded-xl border border-border/60 bg-card/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0"><div className="flex items-center gap-2"><h4 className="text-[13px] font-medium">{server.name}</h4><Badge variant={server.enabled ? "secondary" : "outline"} className="text-[10px]">{server.enabled ? "Enabled" : "Disabled"}</Badge>{server.enabled ? <RuntimeStatusBadge status={runtime?.state} count={runtime?.toolCount} /> : null}</div><p className="mt-1 break-all font-mono text-[10.5px] text-muted-foreground">{server.command} {server.args.join(" ")}</p></div>
                  <div className="flex items-center gap-1"><Button size="sm" variant="outline" onClick={() => void testServer(server)} disabled={testing === server.id} className="h-7 gap-1.5 text-[11px]"><HugeiconsIcon icon={PlayIcon} size={11} strokeWidth={1.75} />{testing === server.id ? "Testing…" : "Test"}</Button><Button size="sm" variant="ghost" onClick={() => void toggleServer(server)} disabled={saving} className="h-7 text-[11px]">{server.enabled ? "Disable" : "Enable"}</Button><Button size="icon" variant="ghost" onClick={() => void removeServer(server.id)} disabled={saving} className="size-7 text-muted-foreground hover:text-destructive" aria-label={`Remove ${server.name}`}><HugeiconsIcon icon={Delete01Icon} size={13} strokeWidth={1.75} /></Button></div>
                </div>
                {runtime?.state === "error" && runtime.lastError ? <div className="mt-2 text-[10.5px] text-destructive/90">Runtime: {runtime.lastError}</div> : null}
                {success ? <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-2"><div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300"><HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} strokeWidth={1.75} />Connected — {success.tools.length} tool{success.tools.length === 1 ? "" : "s"} found.</div>{success.tools.length ? <ul className="mt-1.5 space-y-1 pl-4 text-[10.5px] text-muted-foreground">{success.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code>{tool.description ? ` — ${tool.description}` : ""}</li>)}</ul> : null}</div> : null}
                {error ? <div className="mt-3 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive"><HugeiconsIcon icon={Alert02Icon} size={12} strokeWidth={1.75} className="mt-0.5 shrink-0" />{error}</div> : null}
              </div>;
            })}
          </div>
        </>
      )}
     </div>
   );
}

/** Stable per-poll fingerprint of the status array. The poll runs every 4s
 *  and `setStatuses` builds a fresh object each time, so without a structural
 *  equality check the whole section re-renders even when nothing changed. The
 *  signature only includes fields the UI renders (state/toolCount/lastError);
 *  `updatedAtMs` is excluded so a no-op registry re-stamp doesn't churn the
 *  render. Order-stable because `mcp_server_status` returns entries sorted by
 *  server id. */
function signatureFor(statuses: McpServerStatus[]): string {
  return statuses
    .map((s) => `${s.serverId}:${s.state}:${s.toolCount ?? ""}:${s.lastError ?? ""}`)
    .join("|");
}

/** Inline badge that mirrors the live registry state from the Rust runtime.
 *  Absent status (the runtime never built an instance) renders nothing — the
 *  `Enabled` outline badge already conveys the persisted toggle in that case. */
function RuntimeStatusBadge({
  status,
  count,
}: {
  status: McpState | undefined;
  count?: number;
}) {
  if (!status) return null;
  const config: Record<
    McpState,
    { label: string; dot: string; className: string }
  > = {
    starting: {
      label: "Starting",
      dot: "bg-amber-500 animate-pulse",
      className:
        "border-amber-500/30 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300",
    },
    connected: {
      label:
        count != null ? `Connected · ${count} tool${count === 1 ? "" : "s"}` : "Connected",
      dot: "bg-emerald-500",
      className:
        "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300",
    },
    error: {
      label: "Unavailable",
      dot: "bg-destructive",
      className: "border-destructive/30 bg-destructive/[0.08] text-destructive",
    },
  };
  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${c.className}`}
      title={`Runtime status: ${c.label}`}
    >
      <span className={`size-1.5 rounded-full ${c.dot}`} />
      {c.label}
    </span>
  );
}
