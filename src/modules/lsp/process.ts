import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Thin wrapper around the Rust `proc::proc_*` commands. Owns the channels
 * for stdout/stderr/exit and exposes them as plain handlers. The Rust side
 * streams raw bytes (ArrayBuffer) on stdout/stderr, matching how
 * [pty-bridge](src/modules/terminal/lib/pty-bridge.ts) ferries PTY output.
 */
export type ExitInfo = {
  signal?: number;
  code?: number;
};

export type ProcessHandlers = {
  onStdout: (bytes: Uint8Array) => void;
  onStderr?: (bytes: Uint8Array) => void;
  onExit?: (info: ExitInfo) => void;
};

export type SpawnOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type ProcessHandle = {
  id: number;
  write: (bytes: Uint8Array) => Promise<void>;
  kill: () => Promise<void>;
};

export async function spawnProcess(
  opts: SpawnOptions,
  handlers: ProcessHandlers,
): Promise<ProcessHandle> {
  const onStdout = new Channel<ArrayBuffer>();
  const onStderr = new Channel<ArrayBuffer>();
  const onExit = new Channel<ExitInfo>();

  let released = false;
  const noop = () => {};
  const release = () => {
    if (released) return;
    released = true;
    onStdout.onmessage = noop;
    onStderr.onmessage = noop;
    onExit.onmessage = noop;
  };

  onStdout.onmessage = (buf) => handlers.onStdout(new Uint8Array(buf));
  onStderr.onmessage = (buf) =>
    handlers.onStderr?.(new Uint8Array(buf));
  onExit.onmessage = (info) => {
    handlers.onExit?.(info);
    release();
  };

  const id = await invoke<number>("proc_spawn", {
    command: opts.command,
    args: opts.args ?? [],
    env: opts.env ?? null,
    cwd: opts.cwd ?? null,
    onStdout,
    onStderr,
    onExit,
  });

  let killed = false;
  return {
    id,
    write: async (bytes) => {
      // Tauri serializes Uint8Array as a JSON number array — fine for the
      // small frames LSP/MCP exchange, but the cost grows quadratically
      // with size. If a server ever ships large payloads to us we'll
      // revisit (binary IPC payload, or a chunking protocol).
      await invoke("proc_stdin_write", { id, data: Array.from(bytes) });
    },
    kill: async () => {
      if (killed) return;
      killed = true;
      try {
        await invoke("proc_kill", { id });
      } finally {
        release();
      }
    },
  };
}
