import type { JSX } from "react";

type MetricEntry = {
  readonly name: string;
  readonly value: number | string;
};

type ExperimentData = {
  readonly experimentId: string;
  readonly metrics: Record<string, number | string>;
  readonly artifacts: readonly string[];
};

type ExperimentViewProps = {
  data: ExperimentData;
  onRerun?: () => void;
};

function formatMetricValue(value: number | string): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
  return value;
}

function MetricsTable({ entries }: { entries: readonly MetricEntry[] }): JSX.Element {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-border">
          <th className="px-3 py-1.5 text-left font-medium text-muted-foreground">
            Metric
          </th>
          <th className="px-3 py-1.5 text-right font-medium text-muted-foreground">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.name} className="border-b border-border/50">
            <td className="px-3 py-1.5 text-foreground">{entry.name}</td>
            <td className="px-3 py-1.5 text-right font-mono text-foreground">
              {formatMetricValue(entry.value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ArtifactList({ artifacts }: { artifacts: readonly string[] }): JSX.Element | null {
  if (artifacts.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-muted-foreground px-1">
        Artifacts
      </div>
      <ul className="flex flex-col gap-0.5">
        {artifacts.map((artifact) => (
          <li
            key={artifact}
            className="rounded-md bg-muted/30 px-3 py-1.5 text-xs font-mono text-foreground truncate"
            title={artifact}
          >
            {artifact}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ExperimentView({ data, onRerun }: ExperimentViewProps): JSX.Element {
  const entries: MetricEntry[] = Object.entries(data.metrics).map(
    ([name, value]) => ({ name, value }),
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-foreground">
          Experiment Results
        </div>
        <span className="text-xs font-mono text-muted-foreground">
          {data.experimentId}
        </span>
      </div>

      {/* Metrics */}
      {entries.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <MetricsTable entries={entries} />
        </div>
      )}

      {/* Artifacts */}
      <ArtifactList artifacts={data.artifacts} />

      {/* Re-run button */}
      {onRerun && (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onRerun}
            className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted transition-colors"
          >
            Re-run with changes
          </button>
        </div>
      )}
    </div>
  );
}
