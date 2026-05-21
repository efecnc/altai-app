import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LspClient } from "@/modules/lsp/client";
import { DEFAULT_LSP_SERVERS } from "@/modules/lsp/catalog";
import {
  cancelInstall,
  getInstallStatus,
  listRegistry,
  runInstall,
  uninstallLsp,
} from "@/modules/lsp/installer";
import type { InstallPhase, LspManifest } from "@/modules/lsp/manifest";
import type { LspServerSpec, ServerCapabilities } from "@/modules/lsp/types";
import { runInTerminal } from "@/modules/terminal/runInTerminal";
import {
  Alert02Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  CodeSquareIcon,
  ComputerTerminal02Icon,
  Copy01Icon,
  Download01Icon,
  Delete01Icon,
  PlayIcon,
  Refresh01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/**
 * Per-spec runtime state.
 *
 * States span two lifecycles glued together:
 *   1. Install lifecycle — `probing` → `not-installed` / `installed` →
 *      `downloading` → `installed` / `install-failed`.
 *   2. Server lifecycle — `installed` → `starting` → `ready` / `failed`.
 *
 * `installed.via` distinguishes "we downloaded it" (managed) from
 * "found it on PATH" (system). The Uninstall button is only offered for
 * managed installs — we don't own the user's system binaries.
 */
type ServerState =
  | { kind: "probing" }
  | { kind: "not-installed" }
  | {
      kind: "installed";
      via: "managed" | "system";
      version: string | null;
    }
  | {
      kind: "downloading";
      bytes: number;
      totalBytes: number | null;
    }
  | { kind: "install-failed"; message: string }
  | { kind: "starting" }
  | {
      kind: "ready";
      via: "managed" | "system";
      serverInfo?: { name: string; version?: string };
      capabilities: ServerCapabilities;
      logs: string[];
    }
  | {
      kind: "failed";
      message: string;
      logs: string[];
    };

export function LanguageServersSection() {
  const [states, setStates] = useState<Record<string, ServerState>>(() =>
    Object.fromEntries(
      DEFAULT_LSP_SERVERS.map((s) => [s.id, { kind: "probing" } as ServerState]),
    ),
  );
  const [workspaceRoot, setWorkspaceRoot] = useState<string>("");
  /**
   * Backend manifests keyed by id. Populated once on mount; the absence of
   * a manifest disables the Install button (we'd have nothing to drive it).
   * Cards always render even before this resolves — the existing
   * `DEFAULT_LSP_SERVERS` already carries everything we need for layout.
   */
  const [manifests, setManifests] = useState<Map<string, LspManifest>>(
    () => new Map(),
  );
  const clientsRef = useRef<Map<string, LspClient>>(new Map());

  const setSpecState = useCallback((id: string, next: ServerState) => {
    setStates((prev) => ({ ...prev, [id]: next }));
  }, []);

  /**
   * "Is this server present on disk?" — managed install wins over PATH so
   * a deliberate Install always overrides a stale `brew install` from years
   * ago.
   */
  const probe = useCallback(
    async (spec: LspServerSpec) => {
      try {
        const status = await getInstallStatus(spec.id);
        if (status.managedPath) {
          setSpecState(spec.id, {
            kind: "installed",
            via: "managed",
            version: status.version ?? null,
          });
        } else if (status.systemPath) {
          setSpecState(spec.id, {
            kind: "installed",
            via: "system",
            version: null,
          });
        } else {
          setSpecState(spec.id, { kind: "not-installed" });
        }
      } catch {
        // Backend not available (e.g. running standalone vite without
        // tauri) — treat as not-installed so the card still renders.
        setSpecState(spec.id, { kind: "not-installed" });
      }
    },
    [setSpecState],
  );

  // Probe + load registry + resolve home dir on mount.
  useEffect(() => {
    void (async () => {
      const home = await invoke<string | null>("proc_home_dir");
      setWorkspaceRoot(home ?? "");
    })();
    void (async () => {
      try {
        const list = await listRegistry();
        setManifests(new Map(list.map((m) => [m.id, m])));
      } catch {
        // Registry call failing isn't fatal — the UI just falls back to
        // the legacy manual-install hints.
      }
    })();
    for (const spec of DEFAULT_LSP_SERVERS) {
      void probe(spec);
    }
  }, [probe]);

  // Stop every running server on unmount so the dev loop / HMR doesn't
  // leak processes across re-renders.
  useEffect(() => {
    const clients = clientsRef.current;
    return () => {
      for (const client of clients.values()) {
        void client.stop();
      }
      clients.clear();
    };
  }, []);

  async function start(spec: LspServerSpec) {
    const prior = clientsRef.current.get(spec.id);
    if (prior) {
      clientsRef.current.delete(spec.id);
      void prior.stop();
    }
    setSpecState(spec.id, { kind: "starting" });
    // Snapshot the via at start-time so a successful Ready state can
    // surface "running from managed install" without re-probing.
    const status = await getInstallStatus(spec.id).catch(() => null);
    const via: "managed" | "system" = status?.managedPath ? "managed" : "system";

    const client = await LspClient.start(spec, workspaceRoot);
    clientsRef.current.set(spec.id, client);

    if (client.state === "failed") {
      // start() now never throws — capture the stderr it buffered during
      // the (failed) handshake so the UI has something to show.
      setSpecState(spec.id, {
        kind: "failed",
        message: friendlyError(
          client.failureReason ?? "Server failed to start",
          client.logs,
        ),
        logs: client.logs,
      });
      return;
    }

    // Tail subsequent stderr into the same logs array for the ready card.
    // Seed with whatever the server emitted during bootstrap so the panel
    // isn't empty even on a clean start.
    const logs: string[] = [...client.logs];
    client.onLog((line) => {
      logs.push(line);
      if (logs.length > 50) logs.splice(0, logs.length - 50);
      setStates((prev) => {
        const current = prev[spec.id];
        if (current?.kind === "ready") {
          return {
            ...prev,
            [spec.id]: { ...current, logs: [...logs] },
          };
        }
        return prev;
      });
    });
    setSpecState(spec.id, {
      kind: "ready",
      via,
      serverInfo: client.serverInfo,
      capabilities: client.capabilities,
      logs,
    });
  }

  async function stop(spec: LspServerSpec) {
    const client = clientsRef.current.get(spec.id);
    if (client) {
      clientsRef.current.delete(spec.id);
      await client.stop();
    }
    // After Stop, we want the card to reflect "installed" with the most
    // recent install kind — re-probe rather than guess.
    await probe(spec);
  }

  async function recheck(spec: LspServerSpec) {
    setSpecState(spec.id, { kind: "probing" });
    await probe(spec);
  }

  async function install(spec: LspServerSpec) {
    setSpecState(spec.id, { kind: "downloading", bytes: 0, totalBytes: null });
    try {
      await runInstall(spec.id, (phase: InstallPhase) => {
        switch (phase.kind) {
          case "started":
            setSpecState(spec.id, {
              kind: "downloading",
              bytes: 0,
              totalBytes: phase.totalBytes ?? null,
            });
            break;
          case "downloaded":
            setSpecState(spec.id, {
              kind: "downloading",
              bytes: phase.bytes,
              totalBytes: phase.totalBytes ?? null,
            });
            break;
          // extracting / verifying flow through downloading — final state is
          // set by the "done" frame OR the awaited promise resolving below.
          case "failed":
            setSpecState(spec.id, {
              kind: "install-failed",
              message: phase.message,
            });
            break;
          case "cancelled":
            setSpecState(spec.id, { kind: "not-installed" });
            break;
          case "done":
            setSpecState(spec.id, {
              kind: "installed",
              via: "managed",
              version: phase.version,
            });
            break;
          // No-ops in UI; the downloading bar already carries momentum.
          case "extracting":
          case "verifying":
            break;
        }
      });
    } catch {
      // The progress channel already produced a `failed` or `cancelled`
      // frame with the user-visible message — don't double-report.
    }
  }

  async function cancelInstallFor(spec: LspServerSpec) {
    await cancelInstall(spec.id);
    // The progress stream emits a `cancelled` frame which flips state;
    // no eager update here avoids a race between the two writers.
  }

  async function uninstall(spec: LspServerSpec) {
    // Stop any running client of ours before wiping the binary —
    // unlink on an open file works on Unix but the spawned process keeps
    // running until kill, which is just confusing UX.
    const client = clientsRef.current.get(spec.id);
    if (client) {
      clientsRef.current.delete(spec.id);
      await client.stop();
    }
    await uninstallLsp(spec.id);
    await probe(spec);
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Languages"
        description="Language servers give the editor intellisense, diagnostics, and hover docs. Install the ones you need on your system; ALTAI connects to them automatically."
      />

      <ul className="flex flex-col gap-2">
        {DEFAULT_LSP_SERVERS.map((spec) => (
          <ServerCard
            key={spec.id}
            spec={spec}
            manifest={manifests.get(spec.id)}
            state={states[spec.id] ?? { kind: "probing" }}
            onStart={() => void start(spec)}
            onStop={() => void stop(spec)}
            onRecheck={() => void recheck(spec)}
            onInstall={() => void install(spec)}
            onCancelInstall={() => void cancelInstallFor(spec)}
            onUninstall={() => void uninstall(spec)}
          />
        ))}
      </ul>
    </div>
  );
}

function ServerCard({
  spec,
  manifest,
  state,
  onStart,
  onStop,
  onRecheck,
  onInstall,
  onCancelInstall,
  onUninstall,
}: {
  spec: LspServerSpec;
  manifest: LspManifest | undefined;
  state: ServerState;
  onStart: () => void;
  onStop: () => void;
  onRecheck: () => void;
  onInstall: () => void;
  onCancelInstall: () => void;
  onUninstall: () => void;
}) {
  const accent = stateAccent(state.kind);
  // Phase 4: all three install kinds are wired up. The Install button is
  // gated on the backend having a manifest at all, not on the source kind.
  const canManagedInstall = manifest !== undefined;
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card/60 px-3.5 py-3",
        accent.border,
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-md", accent.iconBg)}>
          <HugeiconsIcon icon={CodeSquareIcon} size={15} strokeWidth={1.5} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[12.5px] font-medium">{spec.name}</span>
            <span className="rounded bg-muted/50 px-1 py-0.5 font-mono text-[9.5px] text-muted-foreground">
              {spec.extensions.map((e) => `.${e}`).join(" ")}
            </span>
            <StatusBadge state={state} />
            <SourceBadge state={state} />
          </div>
          <span className="font-mono text-[10.5px] text-muted-foreground">
            $ {spec.command}
            {spec.args.length > 0 ? ` ${spec.args.join(" ")}` : ""}
          </span>
        </div>
        <CardAction
          state={state}
          canManagedInstall={canManagedInstall}
          onStart={onStart}
          onStop={onStop}
          onRecheck={onRecheck}
          onInstall={onInstall}
          onCancelInstall={onCancelInstall}
          onUninstall={onUninstall}
        />
      </div>

      <CardBody state={state} spec={spec} canManagedInstall={canManagedInstall} />
    </li>
  );
}

function CardAction({
  state,
  canManagedInstall,
  onStart,
  onStop,
  onRecheck,
  onInstall,
  onCancelInstall,
  onUninstall,
}: {
  state: ServerState;
  canManagedInstall: boolean;
  onStart: () => void;
  onStop: () => void;
  onRecheck: () => void;
  onInstall: () => void;
  onCancelInstall: () => void;
  onUninstall: () => void;
}) {
  switch (state.kind) {
    case "probing":
      return (
        <span className="text-[10.5px] text-muted-foreground">Checking…</span>
      );
    case "not-installed":
      // Primary action depends on whether the backend can drive the install.
      // For stubbed sources (npm / go) we keep Re-check as the only action
      // and steer the user toward the manual command in the body.
      if (canManagedInstall) {
        return (
          <Button
            size="sm"
            variant="default"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={onInstall}
          >
            <HugeiconsIcon icon={Download01Icon} size={11} strokeWidth={1.75} />
            Install
          </Button>
        );
      }
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={onRecheck}
        >
          <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={1.75} />
          Re-check
        </Button>
      );
    case "downloading":
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={onCancelInstall}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
          Cancel
        </Button>
      );
    case "install-failed":
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={onInstall}
        >
          <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={1.75} />
          Retry
        </Button>
      );
    case "installed":
      // Two buttons: Test (primary) + Uninstall (only for managed installs —
      // we don't touch the user's PATH install).
      return (
        <div className="flex items-center gap-1.5">
          {state.via === "managed" ? (
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={onUninstall}
              title="Uninstall managed binary"
            >
              <HugeiconsIcon icon={Delete01Icon} size={12} strokeWidth={1.75} />
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="default"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={onStart}
          >
            <HugeiconsIcon icon={PlayIcon} size={11} strokeWidth={1.75} />
            Test
          </Button>
        </div>
      );
    case "starting":
      return <span className="text-[10.5px] text-muted-foreground">Starting…</span>;
    case "ready":
    case "failed":
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2.5 text-[11px]"
          onClick={state.kind === "ready" ? onStop : onStart}
        >
          {state.kind === "ready" ? (
            <>
              <HugeiconsIcon icon={StopIcon} size={11} strokeWidth={1.75} />
              Stop
            </>
          ) : (
            <>
              <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={1.75} />
              Retry
            </>
          )}
        </Button>
      );
  }
}

function CardBody({
  state,
  spec,
  canManagedInstall,
}: {
  state: ServerState;
  spec: LspServerSpec;
  canManagedInstall: boolean;
}) {
  if (state.kind === "not-installed") {
    return <NotInstalledBody spec={spec} canManagedInstall={canManagedInstall} />;
  }
  if (state.kind === "downloading") {
    return <DownloadingBody state={state} />;
  }
  if (state.kind === "install-failed") {
    return <InstallFailedBody state={state} spec={spec} />;
  }
  if (state.kind === "installed" && state.version) {
    return (
      <div className="ml-10.5 text-[10.5px] text-muted-foreground">
        Installed version: <span className="font-mono">{state.version}</span>
      </div>
    );
  }
  if (state.kind === "ready") {
    return <ReadyBody state={state} />;
  }
  if (state.kind === "failed") {
    return <FailedBody state={state} spec={spec} />;
  }
  return null;
}

function NotInstalledBody({
  spec,
  canManagedInstall,
}: {
  spec: LspServerSpec;
  canManagedInstall: boolean;
}) {
  const install = installCommand(spec);
  if (canManagedInstall) {
    // Managed-install path is one click away; the manual command lives
    // in a collapsed "Advanced" section so power users can still reach it.
    return (
      <div className="ml-10.5 flex flex-col gap-2">
        <span className="text-[11px] text-muted-foreground">
          Not installed yet. Click Install to download and manage it locally.
        </span>
        {install ? (
          <details className="text-[10.5px] text-muted-foreground">
            <summary className="cursor-pointer select-none">
              Advanced: install manually instead
            </summary>
            <div className="mt-1.5">
              <CodeBlock command={install} />
            </div>
          </details>
        ) : null}
      </div>
    );
  }
  // Stubbed source — keep the legacy manual hint as the primary path.
  return (
    <div className="ml-10.5 flex flex-col gap-2">
      <span className="text-[11px] text-muted-foreground">
        Not installed on your system. Managed install coming soon — for now,
        use the command below.
      </span>
      {install ? <CodeBlock command={install} label="Install command" /> : null}
    </div>
  );
}

function DownloadingBody({
  state,
}: {
  state: Extract<ServerState, { kind: "downloading" }>;
}) {
  const pct =
    state.totalBytes && state.totalBytes > 0
      ? Math.min(100, Math.round((state.bytes / state.totalBytes) * 100))
      : null;
  return (
    <div className="ml-10.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Downloading{state.totalBytes ? ` ${formatMB(state.bytes)} / ${formatMB(state.totalBytes)}` : ` ${formatMB(state.bytes)}`}
        </span>
        {pct !== null ? <span className="font-mono">{pct}%</span> : null}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/40">
        <div
          className="h-full bg-foreground/70 transition-[width] duration-200"
          style={{ width: pct === null ? "100%" : `${pct}%` }}
        />
      </div>
    </div>
  );
}

function InstallFailedBody({
  state,
  spec,
}: {
  state: Extract<ServerState, { kind: "install-failed" }>;
  spec: LspServerSpec;
}) {
  const install = installCommand(spec);
  return (
    <div className="ml-10.5 flex flex-col gap-1.5">
      <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={12}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-destructive"
        />
        <span className="text-[11px] leading-relaxed text-destructive">
          {state.message}
        </span>
      </div>
      {install ? (
        <details className="text-[10.5px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Install manually instead
          </summary>
          <div className="mt-1.5">
            <CodeBlock command={install} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function formatMB(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReadyBody({
  state,
}: {
  state: Extract<ServerState, { kind: "ready" }>;
}) {
  const c = state.capabilities;
  const features = [
    c.hoverProvider ? "hover" : null,
    c.completionProvider ? "completion" : null,
    c.definitionProvider ? "definition" : null,
    c.documentFormattingProvider ? "format" : null,
  ].filter(Boolean) as string[];
  return (
    <div className="ml-10.5 flex flex-col gap-1.5">
      {state.serverInfo ? (
        <span className="text-[11px] text-muted-foreground">
          {state.serverInfo.name}
          {state.serverInfo.version ? ` ${state.serverInfo.version}` : ""}
        </span>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {features.length === 0 ? (
          <span className="text-[10px] text-muted-foreground">
            No optional capabilities reported.
          </span>
        ) : (
          features.map((f) => (
            <span
              key={f}
              className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px]"
            >
              {f}
            </span>
          ))
        )}
      </div>
      {state.logs.length > 0 ? (
        <details className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Server stderr ({state.logs.length})
          </summary>
          <pre className="mt-1 max-h-28 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[10px] leading-snug">
            {state.logs.join("\n")}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function FailedBody({
  state,
  spec,
}: {
  state: Extract<ServerState, { kind: "failed" }>;
  spec: LspServerSpec;
}) {
  return (
    <div className="ml-10.5 flex flex-col gap-1.5">
      <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
        <HugeiconsIcon
          icon={Alert02Icon}
          size={12}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-destructive"
        />
        <span className="text-[11px] leading-relaxed text-destructive">
          {state.message}
        </span>
      </div>
      {/* Stderr is auto-expanded on failure — usually the only useful clue */}
      {state.logs.length > 0 ? (
        <details open className="text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Server stderr ({state.logs.length})
          </summary>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[10px] leading-snug">
            {state.logs.join("\n")}
          </pre>
        </details>
      ) : (
        <span className="text-[10px] text-muted-foreground">
          Server produced no stderr output before exiting.
        </span>
      )}
      {spec.installHint ? (
        <CodeBlock command={extractCommand(spec.installHint)} label="Reinstall" />
      ) : null}
    </div>
  );
}

function CodeBlock({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore — clipboard isn't reachable in some webviews */
    }
  }
  return (
    <div className="flex flex-col gap-0.5">
      {label ? (
        <span className="text-[9.5px] tracking-tight text-muted-foreground uppercase">
          {label}
        </span>
      ) : null}
      <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {command}
        </code>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-[10px]"
          onClick={() => runInTerminal(command)}
          title="Open a new terminal tab with this command ready to run"
        >
          <HugeiconsIcon
            icon={ComputerTerminal02Icon}
            size={11}
            strokeWidth={1.75}
          />
          Run
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          onClick={() => void copy()}
          title="Copy"
        >
          <HugeiconsIcon
            icon={copied ? CheckmarkCircle02Icon : Copy01Icon}
            size={11}
            strokeWidth={1.75}
            className={copied ? "text-emerald-600" : undefined}
          />
        </Button>
      </div>
    </div>
  );
}

function StatusBadge({ state }: { state: ServerState }) {
  switch (state.kind) {
    case "probing":
      return null;
    case "not-installed":
      return (
        <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
          Not installed
        </Badge>
      );
    case "downloading":
      return (
        <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
          Downloading
        </Badge>
      );
    case "install-failed":
      return (
        <Badge
          variant="secondary"
          className="h-4 gap-0.5 px-1 text-[9px] uppercase text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={9} strokeWidth={2} />
          Install failed
        </Badge>
      );
    case "installed":
      return (
        <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
          Installed
        </Badge>
      );
    case "starting":
      return (
        <Badge variant="secondary" className="h-4 px-1 text-[9px] uppercase">
          Starting
        </Badge>
      );
    case "ready":
      return (
        <Badge
          variant="secondary"
          className="h-4 gap-0.5 px-1 text-[9px] uppercase text-emerald-700 dark:text-emerald-300"
        >
          <HugeiconsIcon
            icon={CheckmarkCircle02Icon}
            size={9}
            strokeWidth={2}
          />
          Ready
        </Badge>
      );
    case "failed":
      return (
        <Badge
          variant="secondary"
          className="h-4 gap-0.5 px-1 text-[9px] uppercase text-destructive"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={9} strokeWidth={2} />
          Crashed
        </Badge>
      );
  }
}

/**
 * Show "Managed" / "PATH" next to the status when we have an opinion.
 * Helps the user remember which binary they're talking to — important
 * because Altai's managed install and a `brew install` can coexist with
 * different versions.
 */
function SourceBadge({ state }: { state: ServerState }) {
  const via =
    state.kind === "installed" || state.kind === "ready" ? state.via : null;
  if (!via) return null;
  const label = via === "managed" ? "Managed" : "PATH";
  return (
    <Badge
      variant="outline"
      className="h-4 border-border/60 px-1 text-[9px] tracking-tight uppercase text-muted-foreground"
    >
      {label}
    </Badge>
  );
}

function stateAccent(kind: ServerState["kind"]) {
  switch (kind) {
    case "ready":
      return { border: "border-foreground/15", iconBg: "bg-emerald-500/10" };
    case "failed":
    case "install-failed":
      return { border: "border-destructive/30", iconBg: "bg-destructive/10" };
    case "not-installed":
      return { border: "border-border/40", iconBg: "bg-muted/30" };
    case "downloading":
      return { border: "border-foreground/20", iconBg: "bg-foreground/5" };
    default:
      return { border: "border-border/60", iconBg: "bg-muted/40" };
  }
}

/**
 * Translate raw spawn / RPC errors into something a non-Rust user can act on.
 * The original message stays accessible in the stderr panel.
 *
 * `logs` lets us match against known stderr patterns (e.g. rustup's
 * "Unknown binary" shim error) that don't show up in the high-level
 * failure reason but tell the user exactly what's wrong.
 */
function friendlyError(raw: string, logs: string[] = []): string {
  const allLogs = logs.join("\n");

  // The `rust-analyzer` binary on macOS is usually a rustup proxy. When
  // the active toolchain doesn't have the component installed, rustup
  // prints this and exits without speaking LSP. The user's "fix" is to
  // either install the component or grab a standalone build via brew.
  if (/Unknown binary ['"]rust-analyzer['"]/.test(allLogs)) {
    return "Your active Rust toolchain doesn't have rust-analyzer installed. Try `rustup update` then `rustup component add rust-analyzer` — or on macOS, `brew install rust-analyzer` (gives you a standalone binary that bypasses rustup).";
  }
  if (/rustup .* component .* not (?:installed|available)/i.test(allLogs)) {
    return "rust-analyzer isn't a valid component for your toolchain. Update rustup (`rustup update`) and try again, or install via Homebrew: `brew install rust-analyzer`.";
  }
  if (/ModuleNotFoundError/.test(allLogs) || /No module named/.test(allLogs)) {
    return "The Python language server imported a module that isn't installed. The install command needs the [all] extras: `pip install 'python-lsp-server[all]'`.";
  }

  if (/No such file or directory/i.test(raw)) {
    return "The server binary couldn't be found. Install it and re-check.";
  }
  if (/permission denied/i.test(raw)) {
    return "The server binary isn't executable. Check its permissions.";
  }
  if (raw.includes("LSP server exited")) {
    return "The server started, then exited before responding. Check the stderr below for the actual reason.";
  }
  return raw;
}

/**
 * Pull the actual command from a free-text install hint
 * ("Install with: npm install -g ...") so the CodeBlock shows only the
 * runnable command. Falls back to the original string if we can't parse it.
 */
function extractCommand(hint: string): string {
  const m = /:\s*(.+)$/.exec(hint);
  return m ? m[1].trim() : hint;
}

function installCommand(spec: LspServerSpec): string | null {
  return spec.installHint ? extractCommand(spec.installHint) : null;
}
