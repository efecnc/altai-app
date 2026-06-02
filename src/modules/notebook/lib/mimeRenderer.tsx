import type { JSX } from "react";
import type { CellOutput } from "./ipynbParser";

/**
 * Render a cell output's MIME bundle into a React element.
 *
 * Supports the most common output types:
 * - text/plain, text/html
 * - image/png, image/svg+xml
 * - application/json
 * - stream (stdout/stderr)
 * - error (with ANSI traceback)
 */

function joinText(text: string | readonly string[] | undefined): string {
  if (!text) return "";
  if (typeof text === "string") return text;
  return text.join("");
}

function getMimeData(
  data: Readonly<Record<string, string | string[]>> | undefined,
  mime: string,
): string | null {
  if (!data) return null;
  const val = data[mime];
  if (!val) return null;
  return Array.isArray(val) ? val.join("") : val;
}

/** Strip ANSI escape codes for plain-text rendering. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function renderOutput(output: CellOutput, key: string): JSX.Element {
  switch (output.outputType) {
    case "stream":
      return (
        <pre
          key={key}
          className={`whitespace-pre-wrap text-xs font-mono px-3 py-1 ${
            output.name === "stderr"
              ? "text-red-400 bg-red-950/20"
              : "text-muted-foreground"
          }`}
        >
          {joinText(output.text)}
        </pre>
      );

    case "error":
      return (
        <pre
          key={key}
          className="whitespace-pre-wrap text-xs font-mono px-3 py-1 text-red-400 bg-red-950/20"
        >
          {output.traceback
            ? output.traceback.map(stripAnsi).join("\n")
            : `${output.ename ?? "Error"}: ${output.evalue ?? ""}`}
        </pre>
      );

    case "execute_result":
    case "display_data": {
      const data = output.data;
      if (!data) return <span key={key} />;

      // Prefer richer MIME types first.
      const html = getMimeData(data, "text/html");
      if (html) {
        return (
          <div
            key={key}
            className="px-3 py-1 text-sm notebook-html-output"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }

      const png = getMimeData(data, "image/png");
      if (png) {
        return (
          <div key={key} className="px-3 py-2">
            <img
              src={`data:image/png;base64,${png.trim()}`}
              alt="Cell output"
              className="max-w-full"
            />
          </div>
        );
      }

      const svg = getMimeData(data, "image/svg+xml");
      if (svg) {
        return (
          <div
            key={key}
            className="px-3 py-2"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        );
      }

      const json = getMimeData(data, "application/json");
      if (json) {
        return (
          <pre
            key={key}
            className="whitespace-pre-wrap text-xs font-mono px-3 py-1 text-muted-foreground"
          >
            {typeof json === "string" ? json : JSON.stringify(JSON.parse(json), null, 2)}
          </pre>
        );
      }

      const plain = getMimeData(data, "text/plain");
      if (plain) {
        return (
          <pre
            key={key}
            className="whitespace-pre-wrap text-xs font-mono px-3 py-1 text-muted-foreground"
          >
            {plain}
          </pre>
        );
      }

      return <span key={key} />;
    }

    default:
      return <span key={key} />;
  }
}

/** Render all outputs for a cell. */
export function renderOutputs(
  outputs: readonly CellOutput[],
  cellIndex: number,
): JSX.Element[] {
  return outputs.map((output, i) =>
    renderOutput(output, `cell-${cellIndex}-out-${i}`),
  );
}
