import type { ProcessHandle } from "./process";

/**
 * JSON-RPC 2.0 client speaking LSP's base protocol — `Content-Length`-framed
 * UTF-8 messages over stdio. The transport (process) is injected so this
 * class doesn't know about Tauri; the same client works for MCP servers
 * later (MCP uses the same line-delimited or framed JSON-RPC dialect).
 */

export type JsonRpcId = number | string;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
};

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private notificationHandlers = new Map<string, (params: unknown) => void>();
  private requestHandlers = new Map<
    string,
    (params: unknown) => Promise<unknown> | unknown
  >();
  private parser = new FrameParser((msg) => this.dispatch(msg));
  private encoder = new TextEncoder();
  private disposed = false;

  constructor(private readonly proc: ProcessHandle) {}

  /** Feed raw bytes from the child's stdout. */
  feed(bytes: Uint8Array): void {
    this.parser.feed(bytes);
  }

  /** Send a request and await its response. */
  async request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.disposed) throw new Error("JsonRpcClient disposed");
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as R),
        reject,
        method,
      });
    });
    await this.send(payload);
    return promise;
  }

  /** Send a notification (no response expected). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.disposed) return;
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    await this.send(payload);
  }

  /** Register a handler for server-initiated notifications. */
  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Register a handler for server-initiated requests. The handler's return
   * value (or thrown error) becomes the response. LSP servers occasionally
   * call back into the client (e.g. `workspace/configuration`, `window/showMessageRequest`).
   */
  onRequest(
    method: string,
    handler: (params: unknown) => Promise<unknown> | unknown,
  ): void {
    this.requestHandlers.set(method, handler);
  }

  /** Reject every pending request and stop accepting new traffic. */
  dispose(error?: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    const cause = error ?? new Error("JsonRpcClient disposed");
    for (const pending of this.pending.values()) {
      pending.reject(cause);
    }
    this.pending.clear();
  }

  private async send(message: JsonRpcMessage): Promise<void> {
    const body = JSON.stringify(message);
    const bodyBytes = this.encoder.encode(body);
    const header = `Content-Length: ${bodyBytes.byteLength}\r\n\r\n`;
    const headerBytes = this.encoder.encode(header);
    const frame = new Uint8Array(headerBytes.byteLength + bodyBytes.byteLength);
    frame.set(headerBytes, 0);
    frame.set(bodyBytes, headerBytes.byteLength);
    await this.proc.write(frame);
  }

  private dispatch(message: JsonRpcMessage): void {
    if ("id" in message && message.id != null && !("method" in message)) {
      // Response to an outgoing request.
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `LSP error from ${pending.method}: ${message.error.code} ${message.error.message}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("method" in message) {
      if ("id" in message && message.id != null) {
        // Server-initiated request — needs a response.
        void this.handleServerRequest(message as JsonRpcRequest);
      } else {
        // Notification.
        const handler = this.notificationHandlers.get(message.method);
        handler?.(message.params);
      }
    }
  }

  private async handleServerRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    let response: JsonRpcResponse;
    if (!handler) {
      response = {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not handled: ${req.method}` },
      };
    } else {
      try {
        const result = await handler(req.params);
        response = { jsonrpc: "2.0", id: req.id, result };
      } catch (e) {
        response = {
          jsonrpc: "2.0",
          id: req.id,
          error: {
            code: -32000,
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    }
    await this.send(response);
  }
}

/**
 * Streaming parser for LSP's `Content-Length`-framed messages. Buffers raw
 * bytes across chunk boundaries; emits one parsed message per complete frame.
 */
class FrameParser {
  // We buffer raw bytes (not a string) because Content-Length counts BYTES,
  // not characters — splitting on UTF-8 boundaries before we know how much
  // to read would corrupt multi-byte codepoints.
  private buf = new Uint8Array(0);
  private decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(private readonly onMessage: (msg: JsonRpcMessage) => void) {}

  feed(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const merged = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.byteLength);
    this.buf = merged;
    this.drain();
  }

  private drain(): void {
    // Loop because a single chunk may contain multiple complete messages.
    for (;;) {
      const headerEnd = findHeaderEnd(this.buf);
      if (headerEnd < 0) return;
      const headerBytes = this.buf.subarray(0, headerEnd);
      const headerText = this.decoder.decode(headerBytes);
      const contentLength = parseContentLength(headerText);
      if (contentLength == null) {
        // Malformed header; skip past it to avoid getting wedged.
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buf.byteLength < bodyEnd) return; // wait for more bytes
      const body = this.decoder.decode(this.buf.subarray(bodyStart, bodyEnd));
      this.buf = this.buf.subarray(bodyEnd);
      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        this.onMessage(msg);
      } catch (e) {
        // Single corrupt frame shouldn't kill the stream; just log and move on.
        if (typeof console !== "undefined") {
          // eslint-disable-next-line no-console
          console.warn("LSP frame parse failed:", e);
        }
      }
    }
  }
}

function findHeaderEnd(buf: Uint8Array): number {
  // Scan for "\r\n\r\n" (bytes 13 10 13 10).
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (
      buf[i] === 13 &&
      buf[i + 1] === 10 &&
      buf[i + 2] === 13 &&
      buf[i + 3] === 10
    ) {
      return i;
    }
  }
  return -1;
}

function parseContentLength(headers: string): number | null {
  for (const line of headers.split(/\r\n/)) {
    const match = /^Content-Length:\s*(\d+)/i.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}
