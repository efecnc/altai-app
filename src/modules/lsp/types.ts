/**
 * Minimal subset of LSP 3.17 types — only what the foundation actually
 * touches. Bigger surfaces (call hierarchy, code lenses, semantic tokens)
 * can be filled in later as features are wired up.
 */

export type Position = {
  line: number;
  character: number;
};

export type Range = {
  start: Position;
  end: Position;
};

export type TextDocumentIdentifier = {
  uri: string;
};

export type VersionedTextDocumentIdentifier = TextDocumentIdentifier & {
  version: number;
};

export type TextDocumentItem = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
};

export type TextDocumentPositionParams = {
  textDocument: TextDocumentIdentifier;
  position: Position;
};

export type Diagnostic = {
  range: Range;
  severity?: 1 | 2 | 3 | 4; // Error | Warning | Information | Hint
  code?: number | string;
  source?: string;
  message: string;
  tags?: number[];
};

export type PublishDiagnosticsParams = {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
};

export type MarkupContent = {
  kind: "plaintext" | "markdown";
  value: string;
};

export type Hover = {
  contents: MarkupContent | string | Array<MarkupContent | string>;
  range?: Range;
};

export type CompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  textEdit?: { range: Range; newText: string };
};

export type CompletionList = {
  isIncomplete: boolean;
  items: CompletionItem[];
};

export type ServerCapabilities = {
  textDocumentSync?:
    | number
    | {
        openClose?: boolean;
        change?: number;
      };
  hoverProvider?: boolean | object;
  completionProvider?: { triggerCharacters?: string[] };
  definitionProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
};

export type InitializeResult = {
  capabilities: ServerCapabilities;
  serverInfo?: { name: string; version?: string };
};

/** LSP server spec — how to launch a server for a given language. */
export type LspServerSpec = {
  /** Stable id (e.g. "typescript", "python"). */
  id: string;
  /** Display name shown in Settings. */
  name: string;
  /** Executable to invoke. Must be on PATH or absolute. */
  command: string;
  /** Args appended to the executable. */
  args: string[];
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** LSP `languageId` to declare for documents (e.g. "typescript"). */
  languageId: string;
  /** File extensions this server handles (without leading dot). */
  extensions: string[];
  /** Install hint for the user if the binary isn't found. */
  installHint?: string;
};
