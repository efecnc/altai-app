import { cn } from "@/lib/utils";
import type { GHItem, GHLabel, GHPullDetail } from "../lib/items";

/** Pick readable text color for a label's background hex. */
function labelText(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length < 6) return "#fff";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  // Perceived luminance → dark text on light labels, light on dark.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#1f2328" : "#ffffff";
}

export function Labels({ labels }: { labels: GHLabel[] }) {
  if (!labels.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <span
          key={l.id}
          className="rounded-full px-2 py-px text-[10px] font-medium"
          style={{ backgroundColor: `#${l.color}`, color: labelText(l.color) }}
        >
          {l.name}
        </span>
      ))}
    </div>
  );
}

export function Avatar({
  url,
  size = 20,
}: {
  url: string | undefined;
  size?: number;
}) {
  if (!url) return null;
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-full ring-1 ring-border/50"
    />
  );
}

type ItemState =
  | "open"
  | "closed"
  | "merged"
  | "draft";

/** Resolve the display state of an item (PR detail carries merge/draft info). */
export function itemState(item: GHItem | GHPullDetail): ItemState {
  if ("merged" in item && item.merged) return "merged";
  if (item.draft) return "draft";
  return item.state;
}

const STATE_STYLES: Record<ItemState, string> = {
  open: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30",
  closed: "bg-red-500/15 text-red-500 ring-red-500/30",
  merged: "bg-violet-500/15 text-violet-400 ring-violet-500/30",
  draft: "bg-muted text-muted-foreground ring-border/60",
};

const STATE_LABEL: Record<ItemState, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
  draft: "Draft",
};

export function StateBadge({ state }: { state: ItemState }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ring-1",
        STATE_STYLES[state],
      )}
    >
      {STATE_LABEL[state]}
    </span>
  );
}
