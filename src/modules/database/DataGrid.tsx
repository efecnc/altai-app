import { cn } from "@/lib/utils";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { DbValue } from "./lib/api";

// Fixed-height rows let us virtualize cheaply (cf. GitHistoryPane). Columns are
// laid out as fixed-width flex cells, with the whole grid horizontally
// scrollable for wide tables.
const ROW_HEIGHT = 30;
const COL_WIDTH = 168;

interface DataGridProps {
  columns: string[];
  rows: DbValue[][];
}

function cellText(value: DbValue): { text: string; isNull: boolean } {
  if (value === null) return { text: "NULL", isNull: true };
  if (typeof value === "boolean") {
    return { text: value ? "true" : "false", isNull: false };
  }
  return { text: String(value), isNull: false };
}

export function DataGrid({ columns, rows }: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (columns.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Query returned no columns.
      </div>
    );
  }

  const gridWidth = columns.length * COL_WIDTH;

  return (
    <div ref={scrollRef} className="h-full w-full overflow-auto text-[12px]">
      <div style={{ minWidth: gridWidth }}>
        <div className="sticky top-0 z-10 flex border-b border-border bg-muted/70 font-medium backdrop-blur-sm">
          {columns.map((column, i) => (
            <div
              key={i}
              style={{ width: COL_WIDTH }}
              className="flex-shrink-0 truncate px-2.5 py-1.5"
              title={column}
            >
              {column}
            </div>
          ))}
        </div>

        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            return (
              <div
                key={virtualRow.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className={cn(
                  "flex border-b border-border/40",
                  virtualRow.index % 2 === 1 && "bg-muted/20",
                )}
              >
                {columns.map((_, ci) => {
                  const { text, isNull } = cellText(row[ci] ?? null);
                  return (
                    <div
                      key={ci}
                      style={{ width: COL_WIDTH }}
                      className={cn(
                        "flex-shrink-0 truncate px-2.5 py-1.5 font-mono",
                        isNull && "italic text-muted-foreground/50",
                      )}
                      title={text}
                    >
                      {text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
