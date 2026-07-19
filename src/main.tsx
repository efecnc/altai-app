import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "@fontsource/jetbrains-mono/cyrillic-400.css";
import "@fontsource/jetbrains-mono/cyrillic-700.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";

import ReactDOM from "react-dom/client";
import { Component, type ErrorInfo, type ReactNode } from "react";
import App from "./app/App";
import { initPendingLaunches } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { WorkspaceGate } from "./modules/workspace/WorkspaceGate";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

type StartupBoundaryState = { error: Error | null };

/** Keep a renderer failure actionable instead of leaving the native window black. */
class StartupBoundary extends Component<{ children: ReactNode }, StartupBoundaryState> {
  state: StartupBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): StartupBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ALTAI renderer failed", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-background p-6 text-foreground">
        <section className="w-full max-w-2xl rounded-xl border border-destructive/40 bg-destructive/[0.06] p-5">
          <h1 className="text-sm font-semibold">ALTAI could not finish loading</h1>
          <p className="mt-1 text-xs text-muted-foreground">The renderer error is shown below.</p>
          <pre className="mt-4 max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-3 font-mono text-xs leading-relaxed text-destructive">
            {this.state.error.stack || this.state.error.message}
          </pre>
        </section>
      </main>
    );
  }
}

// Seed before first paint so default tab mounts at target cwd (no flicker).
// A failed native launch-payload read must not prevent React from mounting.
try {
  await initPendingLaunches();
} catch (error) {
  console.warn("initial launch payloads could not be read", error);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StartupBoundary>
    <WorkspaceGate>
      <App />
    </WorkspaceGate>
  </StartupBoundary>,
);
