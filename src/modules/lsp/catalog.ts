import type { LspServerSpec } from "./types";

/**
 * Default LSP server specs for the four bootstrap languages. Each entry
 * targets the install command commonly used in the language's own
 * tooling (npm for TS, pip for Python, rustup for Rust, go install for Go).
 *
 * The `installHint` is surfaced verbatim in Settings when the binary isn't
 * on PATH, so it has to be a real working command on the user's shell.
 */

const TYPESCRIPT: LspServerSpec = {
  id: "typescript",
  name: "TypeScript",
  command: "typescript-language-server",
  args: ["--stdio"],
  languageId: "typescript",
  extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
  installHint:
    "Install with: npm install -g typescript-language-server typescript",
};

const PYTHON: LspServerSpec = {
  id: "python",
  name: "Python",
  command: "pylsp",
  args: [],
  languageId: "python",
  extensions: ["py", "pyi"],
  installHint: "Install with: pip install 'python-lsp-server[all]'",
};

const GO: LspServerSpec = {
  id: "go",
  name: "Go",
  command: "gopls",
  args: [],
  languageId: "go",
  extensions: ["go"],
  installHint: "Install with: go install golang.org/x/tools/gopls@latest",
};

const RUST: LspServerSpec = {
  id: "rust",
  name: "Rust",
  command: "rust-analyzer",
  args: [],
  languageId: "rust",
  extensions: ["rs"],
  // Homebrew is the most reliable path on macOS — it installs a
  // standalone binary that doesn't depend on rustup's active toolchain
  // having the `rust-analyzer` component. On Linux, prefer
  // `rustup component add rust-analyzer` (the friendly-error path
  // mentions it when it detects the rustup proxy failure).
  installHint: "Install with: brew install rust-analyzer",
};

export const DEFAULT_LSP_SERVERS: readonly LspServerSpec[] = [
  TYPESCRIPT,
  PYTHON,
  GO,
  RUST,
] as const;

/** Look up a server spec by id. */
export function getSpec(id: string): LspServerSpec | undefined {
  return DEFAULT_LSP_SERVERS.find((s) => s.id === id);
}

/** Match a file path to the first server spec that handles its extension. */
export function specForPath(path: string): LspServerSpec | undefined {
  const ext = extractExtension(path);
  if (!ext) return undefined;
  return DEFAULT_LSP_SERVERS.find((s) => s.extensions.includes(ext));
}

function extractExtension(path: string): string | undefined {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const file = path.slice(lastSlash + 1);
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return file.slice(dot + 1).toLowerCase();
}
