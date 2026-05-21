/**
 * Parse and serialize Jupyter `.ipynb` notebook files.
 *
 * The parser produces an immutable `Notebook` object. Mutations should
 * create new objects via the helper functions below.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type OutputType =
  | "stream"
  | "display_data"
  | "execute_result"
  | "error";

export type CellOutput = {
  readonly outputType: OutputType;
  /** Execution count (execute_result only). */
  readonly executionCount?: number | null;
  /** MIME-keyed data bundle (display_data / execute_result). */
  readonly data?: Readonly<Record<string, string | string[]>>;
  /** Stream name: "stdout" | "stderr" (stream only). */
  readonly name?: string;
  /** Stream text or error traceback lines. */
  readonly text?: readonly string[];
  /** Error name (error only). */
  readonly ename?: string;
  /** Error value (error only). */
  readonly evalue?: string;
  /** Traceback lines (error only). */
  readonly traceback?: readonly string[];
};

export type CellType = "code" | "markdown" | "raw";

export type Cell = {
  readonly cellType: CellType;
  readonly source: string;
  readonly outputs: readonly CellOutput[];
  readonly executionCount: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
};

export type NotebookMetadata = {
  readonly kernelspec?: {
    readonly name: string;
    readonly display_name: string;
    readonly language?: string;
  };
  readonly language_info?: {
    readonly name: string;
    readonly version?: string;
  };
  readonly [key: string]: unknown;
};

export type Notebook = {
  readonly cells: readonly Cell[];
  readonly metadata: NotebookMetadata;
  readonly nbformat: number;
  readonly nbformatMinor: number;
};

// ── Parse ──────────────────────────────────────────────────────────────

function joinSource(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.join("");
  return "";
}

function parseOutput(raw: Record<string, unknown>): CellOutput {
  const outputType = (raw.output_type as string) ?? "stream";

  return {
    outputType: outputType as OutputType,
    executionCount: (raw.execution_count as number | null) ?? null,
    data: raw.data as Record<string, string | string[]> | undefined,
    name: raw.name as string | undefined,
    text: raw.text
      ? Array.isArray(raw.text)
        ? raw.text
        : [raw.text as string]
      : undefined,
    ename: raw.ename as string | undefined,
    evalue: raw.evalue as string | undefined,
    traceback: raw.traceback as string[] | undefined,
  };
}

function parseCell(raw: Record<string, unknown>): Cell {
  const cellType = (raw.cell_type as string) ?? "code";
  const rawOutputs = (raw.outputs as Record<string, unknown>[]) ?? [];

  return {
    cellType: cellType as CellType,
    source: joinSource(raw.source),
    outputs: rawOutputs.map(parseOutput),
    executionCount: (raw.execution_count as number | null) ?? null,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
  };
}

export function parse(json: string): Notebook {
  const raw = JSON.parse(json) as Record<string, unknown>;

  const rawCells = (raw.cells as Record<string, unknown>[]) ?? [];
  const metadata = (raw.metadata as NotebookMetadata) ?? {};
  const nbformat = (raw.nbformat as number) ?? 4;
  const nbformatMinor = (raw.nbformat_minor as number) ?? 5;

  return {
    cells: rawCells.map(parseCell),
    metadata,
    nbformat,
    nbformatMinor,
  };
}

// ── Serialize ──────────────────────────────────────────────────────────

function splitSource(source: string): string[] {
  if (!source) return [];
  // Preserve line endings for round-trip fidelity.
  const lines = source.split(/(?<=\n)/);
  return lines;
}

function serializeOutput(output: CellOutput): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    output_type: output.outputType,
  };

  if (output.outputType === "execute_result" || output.outputType === "display_data") {
    obj.data = output.data ?? {};
    obj.metadata = {};
    if (output.outputType === "execute_result") {
      obj.execution_count = output.executionCount ?? null;
    }
  }

  if (output.outputType === "stream") {
    obj.name = output.name ?? "stdout";
    obj.text = output.text ?? [];
  }

  if (output.outputType === "error") {
    obj.ename = output.ename ?? "";
    obj.evalue = output.evalue ?? "";
    obj.traceback = output.traceback ?? [];
  }

  return obj;
}

function serializeCell(cell: Cell): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    cell_type: cell.cellType,
    metadata: cell.metadata,
    source: splitSource(cell.source),
  };

  if (cell.cellType === "code") {
    obj.execution_count = cell.executionCount;
    obj.outputs = cell.outputs.map(serializeOutput);
  }

  return obj;
}

export function serialize(notebook: Notebook): string {
  const obj = {
    cells: notebook.cells.map(serializeCell),
    metadata: notebook.metadata,
    nbformat: notebook.nbformat,
    nbformat_minor: notebook.nbformatMinor,
  };

  return JSON.stringify(obj, null, 1) + "\n";
}

// ── Immutable helpers ──────────────────────────────────────────────────

export function updateCellSource(
  notebook: Notebook,
  index: number,
  source: string,
): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.map((c, i) =>
      i === index ? { ...c, source } : c,
    ),
  };
}

export function updateCellOutputs(
  notebook: Notebook,
  index: number,
  outputs: readonly CellOutput[],
): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.map((c, i) =>
      i === index ? { ...c, outputs } : c,
    ),
  };
}

export function insertCell(
  notebook: Notebook,
  index: number,
  cell: Cell,
): Notebook {
  const cells = [...notebook.cells];
  cells.splice(index, 0, cell);
  return { ...notebook, cells };
}

export function removeCell(notebook: Notebook, index: number): Notebook {
  return {
    ...notebook,
    cells: notebook.cells.filter((_, i) => i !== index),
  };
}

export function moveCell(
  notebook: Notebook,
  from: number,
  to: number,
): Notebook {
  if (from === to) return notebook;
  const cells = [...notebook.cells];
  const [removed] = cells.splice(from, 1);
  cells.splice(to, 0, removed);
  return { ...notebook, cells };
}

export function emptyCodeCell(): Cell {
  return {
    cellType: "code",
    source: "",
    outputs: [],
    executionCount: null,
    metadata: {},
  };
}

export function emptyMarkdownCell(): Cell {
  return {
    cellType: "markdown",
    source: "",
    outputs: [],
    executionCount: null,
    metadata: {},
  };
}
