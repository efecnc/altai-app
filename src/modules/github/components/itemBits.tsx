import { cn } from "@/lib/utils";
import {
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Target01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GHItem, GHLabel, GHPullDetail, ItemKind } from "../lib/items";

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
          className="rounded-full px-1.5 py-px text-[10px] font-medium leading-[1.35] ring-1 ring-inset ring-black/[0.06] dark:ring-white/10"
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

type ItemState = "open" | "closed" | "merged" | "draft" | "not_planned";

/**
 * Resolve the display state of an item. Detail rows carry an explicit `merged`
 * flag; list rows don't, so we fall back to `merged_at` (and `pull_request`
 * for issue-shaped PR rows) — otherwise every merged PR would look "closed".
 * Issues closed as "not_planned" get their own state so a resolved issue
 * (completed) reads differently from a dismissed one.
 */
export function itemState(item: GHItem | GHPullDetail): ItemState {
  if (
    ("merged" in item && item.merged) ||
    item.merged_at ||
    item.pull_request?.merged_at
  )
    return "merged";
  // `draft` is independent of open/closed: a PR closed while still a draft
  // carries draft:true + state:"closed" and must read as "Closed", not "Draft".
  if (item.draft && item.state === "open") return "draft";
  if (item.state === "closed" && item.state_reason === "not_planned")
    return "not_planned";
  return item.state;
}

type Visual = {
  icon: typeof GitPullRequestIcon;
  label: string;
  /** Tailwind text color for the standalone glyph. */
  iconColor: string;
  /** Tailwind classes for the pill badge (bg + text + ring). */
  badgeClass: string;
};

/**
 * Map a resolved state (and kind, when known) to a GitHub-native glyph, label,
 * and color. Issues use the circle-dot / check glyphs; PRs use the git glyphs.
 */
function resolveVisual(state: ItemState, kind?: ItemKind): Visual {
  const isIssue = kind === "issues";
  switch (state) {
    case "merged":
      return {
        icon: GitMergeIcon,
        label: "Merged",
        iconColor: "text-violet-400",
        badgeClass: "bg-violet-500/15 text-violet-400 ring-violet-500/30",
      };
    case "draft":
      return {
        icon: GitPullRequestDraftIcon,
        label: "Draft",
        iconColor: "text-muted-foreground",
        badgeClass: "bg-muted text-muted-foreground ring-border/60",
      };
    case "not_planned":
      return {
        icon: CancelCircleIcon,
        label: "Not planned",
        iconColor: "text-muted-foreground",
        badgeClass: "bg-muted text-muted-foreground ring-border/60",
      };
    case "closed":
      return isIssue
        ? {
            icon: CheckmarkCircle02Icon,
            label: "Closed",
            iconColor: "text-violet-400",
            badgeClass: "bg-violet-500/15 text-violet-400 ring-violet-500/30",
          }
        : {
            icon: GitPullRequestClosedIcon,
            label: "Closed",
            iconColor: "text-red-500",
            badgeClass: "bg-red-500/15 text-red-500 ring-red-500/30",
          };
    default:
      return {
        icon: isIssue ? Target01Icon : GitPullRequestIcon,
        label: "Open",
        iconColor: "text-emerald-500",
        badgeClass: "bg-emerald-500/15 text-emerald-500 ring-emerald-500/30",
      };
  }
}

/** Standalone color-coded glyph for a list row's leading column. */
export function ItemStateIcon({
  state,
  kind,
  size = 15,
}: {
  state: ItemState;
  kind?: ItemKind;
  size?: number;
}) {
  const v = resolveVisual(state, kind);
  return (
    <HugeiconsIcon
      icon={v.icon}
      size={size}
      strokeWidth={1.9}
      className={cn("shrink-0", v.iconColor)}
    />
  );
}

export function StateBadge({
  state,
  kind,
}: {
  state: ItemState;
  kind?: ItemKind;
}) {
  const v = resolveVisual(state, kind);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide ring-1",
        v.badgeClass,
      )}
    >
      <HugeiconsIcon icon={v.icon} size={11} strokeWidth={2.1} />
      {v.label}
    </span>
  );
}

/** Inline, color-coded one-word status for dense meta lines (no pill chrome). */
export function StateText({
  state,
  kind,
}: {
  state: ItemState;
  kind?: ItemKind;
}) {
  const v = resolveVisual(state, kind);
  return (
    <span className={cn("font-semibold", v.iconColor)}>{v.label}</span>
  );
}
