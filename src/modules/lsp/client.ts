import { resolveExecutablePath } from "./installer";
import { JsonRpcClient } from "./jsonrpc";
import { spawnProcess, type ProcessHandle } from "./process";
import type {
  CompletionList,
  Hover,
  InitializeResult,
  LspServerSpec,
  Position,
  PublishDiagnosticsParams,
  ServerCapabilities,
} from "./types";

/**
 * High-level LSP client. Owns one language server process, drives the
 * handshake, and tracks the open-document set for `didChange` versioning.
 *
 * Lifecycle:
 *   const client = await LspClient.start(spec, workspaceRoot);
 *   client.onDiagnostics(handler);
 *   client.didOpen(uri, text);
 *   ...
 *   await client.stop();
 *
 * The client owns the process; callers shouldn't reach into it directly.
 */
export type ClientState = "starting" | "ready" | "failed" | "stopped";

const LOG_BUFFER_CAP = 200;

export class LspClient {
  private rpc: JsonRpcClient | null = null;
  private proc: ProcessHandle | null = null;
  private documents = new Map<string, { version: number }>();
  private diagnosticsHandlers = new Set<
    (params: PublishDiagnosticsParams) => void
  >();
  private logHandlers = new Set<(line: string) => void>();
  private _state: ClientState = "starting";
  private _capabilities: ServerCapabilities = {};
  private _serverInfo: InitializeResult["serverInfo"];
  /** Last reason for entering `failed` state — usable even if start() didn't throw. */
  private _failureReason: string | undefined;
  /** Internal ring of stderr lines. Always populated from spawn time, so a
   *  server that dies during bootstrap still leaves its stderr accessible. */
  private logBuffer: string[] = [];
  private stderrBuffer = "";

  private constructor(public readonly spec: LspServerSpec) {}

  /**
   * Spawn the server and run the handshake. Never throws — the returned
   * client carries `state` (`ready` | `failed`) and, on failure,
   * `failureReason` + `logs` so callers can render a useful error UI.
   *
   * Capturing stderr inside the client (rather than via an external
   * `onLog` callback) means stderr emitted during the brief life of a
   * server that crashes during initialize is still recoverable.
   */
  static async start(
    spec: LspServerSpec,
    workspaceRoot: string,
  ): Promise<LspClient> {
    const client = new LspClient(spec);
    try {
      await client.bootstrap(workspaceRoot);
    } catch (e) {
      client._state = "failed";
      client._failureReason = e instanceof Error ? e.message : String(e);
    }
    return client;
  }

  get state(): ClientState {
    return this._state;
  }

  get capabilities(): ServerCapabilities {
    return this._capabilities;
  }

  get serverInfo(): InitializeResult["serverInfo"] | undefined {
    return this._serverInfo;
  }

  /** If the client is in `failed` state, the underlying error message. */
  get failureReason(): string | undefined {
    return this._failureReason;
  }

  /** Snapshot of stderr lines collected since spawn. */
  get logs(): string[] {
    return [...this.logBuffer];
  }

  onDiagnostics(handler: (params: PublishDiagnosticsParams) => void): () => void {
    this.diagnosticsHandlers.add(handler);
    return () => {
      this.diagnosticsHandlers.delete(handler);
    };
  }

  /** Subscribe to server stderr (line-buffered). Useful for surfacing
   *  server-side errors in the UI without taking over Console. */
  onLog(handler: (line: string) => void): () => void {
    this.logHandlers.add(handler);
    return () => {
      this.logHandlers.delete(handler);
    };
  }

  async didOpen(uri: string, languageId: string, text: string): Promise<void> {
    if (this._state !== "ready" || !this.rpc) return;
    this.documents.set(uri, { version: 1 });
    await this.rpc.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async didChangeFull(uri: string, text: string): Promise<void> {
    if (this._state !== "ready" || !this.rpc) return;
    const doc = this.documents.get(uri);
    if (!doc) return;
    doc.version += 1;
    await this.rpc.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  async didClose(uri: string): Promise<void> {
    if (this._state !== "ready" || !this.rpc) return;
    this.documents.delete(uri);
    await this.rpc.notify("textDocument/didClose", {
      textDocument: { uri },
    });
  }

  async hover(uri: string, position: Position): Promise<Hover | null> {
    if (this._state !== "ready" || !this.rpc) return null;
    if (!this._capabilities.hoverProvider) return null;
    return this.rpc.request<Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position,
    });
  }

  async completion(
    uri: string,
    position: Position,
  ): Promise<CompletionList | null> {
    if (this._state !== "ready" || !this.rpc) return null;
    if (!this._capabilities.completionProvider) return null;
    const result = await this.rpc.request<
      CompletionList | CompletionList["items"] | null
    >("textDocument/completion", {
      textDocument: { uri },
      position,
    });
    if (!result) return null;
    // LSP allows the server to return either `CompletionList` or a raw
    // array of items; normalize.
    if (Array.isArray(result)) {
      return { isIncomplete: false, items: result };
    }
    return result;
  }

  async stop(): Promise<void> {
    if (this._state === "stopped") return;
    this._state = "stopped";
    try {
      if (this.rpc) {
        // Best-effort shutdown sequence. Servers that hang are killed below.
        await Promise.race([
          this.rpc.request("shutdown").catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
        await this.rpc.notify("exit").catch(() => undefined);
      }
    } finally {
      this.rpc?.dispose();
      this.rpc = null;
      await this.proc?.kill().catch(() => undefined);
      this.proc = null;
    }
  }

  private async bootstrap(workspaceRoot: string): Promise<void> {
    // Prefer the Altai-managed install (under `<app_data>/lsp/<id>/bin/...`)
    // over the spec's raw command, which would only succeed if the binary
    // happens to be on PATH. When neither exists the spawn below fails
    // with ENOENT and surfaces as a clean "not installed" error in the UI.
    const command =
      (await resolveExecutablePath(this.spec.id).catch(() => null)) ??
      this.spec.command;

    let handle: ProcessHandle;
    try {
      handle = await spawnProcess(
        {
          command,
          args: this.spec.args,
          env: this.spec.env,
          cwd: workspaceRoot,
        },
        {
          onStdout: (bytes) => this.rpc?.feed(bytes),
          onStderr: (bytes) => this.handleStderr(bytes),
          onExit: () => this.handleExit(),
        },
      );
    } catch (e) {
      this._state = "failed";
      throw new Error(
        `Failed to spawn LSP server '${this.spec.id}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    this.proc = handle;
    this.rpc = new JsonRpcClient(handle);

    // Servers often need to call back into the client during initialize
    // (e.g. workspace/configuration). Stub those out with sane defaults so
    // we don't block the handshake.
    this.rpc.onRequest("workspace/configuration", () => []);
    this.rpc.onRequest("client/registerCapability", () => null);
    this.rpc.onRequest("client/unregisterCapability", () => null);
    this.rpc.onRequest("window/workDoneProgress/create", () => null);
    this.rpc.onNotification("textDocument/publishDiagnostics", (params) => {
      for (const handler of this.diagnosticsHandlers) {
        handler(params as PublishDiagnosticsParams);
      }
    });
    this.rpc.onNotification("window/logMessage", () => undefined);
    this.rpc.onNotification("window/showMessage", () => undefined);

    try {
      const result = await this.rpc.request<InitializeResult>("initialize", {
        processId: null,
        clientInfo: { name: "altai", version: "0.1.0" },
        // LSP servers use the root to detect project type, load config,
        // and scope diagnostics. `null` is legal (no workspace) but
        // disables a lot of features.
        rootUri: this.workspaceUri(workspaceRoot),
        workspaceFolders: workspaceRoot
          ? [
              {
                uri: this.workspaceUri(workspaceRoot),
                name: workspaceRoot.split("/").pop() ?? "workspace",
              },
            ]
          : null,
        capabilities: clientCapabilities(),
      });
      this._capabilities = result.capabilities;
      this._serverInfo = result.serverInfo;
      await this.rpc.notify("initialized", {});
      this._state = "ready";
    } catch (e) {
      this._state = "failed";
      await this.proc?.kill().catch(() => undefined);
      throw e;
    }
  }

  private handleStderr(bytes: Uint8Array): void {
    this.stderrBuffer += new TextDecoder().decode(bytes);
    const lines = this.stderrBuffer.split("\n");
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed) continue;
      // Always buffer so `client.logs` works on the very first failure,
      // before the UI has had a chance to attach `onLog`. Cap to keep a
      // chatty server from growing unboundedly.
      this.logBuffer.push(trimmed);
      if (this.logBuffer.length > LOG_BUFFER_CAP) this.logBuffer.shift();
      for (const handler of this.logHandlers) handler(trimmed);
    }
  }

  private handleExit(): void {
    if (this._state !== "stopped") {
      this._state = "failed";
    }
    this.rpc?.dispose(new Error("LSP server exited"));
  }

  private workspaceUri(root: string): string {
    if (!root) return "";
    if (root.startsWith("file://")) return root;
    return `file://${root.startsWith("/") ? root : `/${root}`}`;
  }
}

/**
 * Conservative client capability declaration. We claim only what we
 * actually intend to implement in Phase A; expand as features land so
 * servers don't waste cycles producing data we'll ignore.
 */
function clientCapabilities(): object {
  return {
    textDocument: {
      synchronization: {
        didSave: false,
        willSave: false,
        willSaveWaitUntil: false,
        dynamicRegistration: false,
      },
      publishDiagnostics: {
        relatedInformation: true,
        versionSupport: false,
        tagSupport: { valueSet: [1, 2] },
      },
      hover: {
        contentFormat: ["markdown", "plaintext"],
        dynamicRegistration: false,
      },
      completion: {
        completionItem: {
          snippetSupport: false,
          documentationFormat: ["markdown", "plaintext"],
        },
        dynamicRegistration: false,
      },
    },
    workspace: {
      workspaceFolders: true,
      configuration: true,
    },
  };
}
