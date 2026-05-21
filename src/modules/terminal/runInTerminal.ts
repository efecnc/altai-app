/**
 * Registry for the "Run in terminal" affordance.
 *
 * Any UI surface that wants to pipe a command into an interactive terminal
 * calls `runInTerminal(cmd)`. The host app (which owns the tab system and
 * the PTY handles) registers the actual implementation on mount via
 * [registerRunInTerminal]. Mirrors the pattern in
 * [openSettingsWindow](src/modules/settings/openSettingsWindow.ts) — keeps
 * call sites decoupled from the tabs hook.
 */

export type RunInTerminalOptions = {
  /** Working directory for the new terminal. Falls back to host default. */
  cwd?: string;
  /**
   * If true, append a newline so the shell runs the command immediately.
   * Default false — let the user review and press Enter themselves.
   */
  immediate?: boolean;
};

type Impl = (command: string, options?: RunInTerminalOptions) => void;

let impl: Impl | null = null;

export function registerRunInTerminal(fn: Impl): () => void {
  impl = fn;
  return () => {
    if (impl === fn) impl = null;
  };
}

export function runInTerminal(command: string, options?: RunInTerminalOptions): void {
  if (!impl) {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("runInTerminal called before registration");
    }
    return;
  }
  impl(command, options);
}
