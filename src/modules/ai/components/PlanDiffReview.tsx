import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  FileEditIcon,
  FilePlusIcon,
  FolderAddIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { native, type CheckpointInfo } from "../lib/native";
import { usePlanStore, type AppliedPlanEdit, type QueuedEdit } from "../store/planStore";
import { useChatStore } from "../store/chatStore";

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function diffStats(
  original: string,
  proposed: string,
): { added: number; removed: number } {
  const a = original.split("\n");
  const b = proposed.split("\n");
  const setA = new Set(a);
  const setB = new Set(b);
  let added = 0;
  let removed = 0;
  for (const line of b) if (!setA.has(line)) added++;
  for (const line of a) if (!setB.has(line)) removed++;
  return { added, removed };
}

export function PlanDiffReview({
  open = false,
  autoOpen = true,
  onClose,
}: {
  /** Opens the review centre even when no plan edits are pending. */
  open?: boolean;
  /** Pending plan edits normally interrupt the chat for a deliberate review. */
  autoOpen?: boolean;
  onClose?: () => void;
}) {
  const queue = usePlanStore((s) => s.queue);
  const applied = usePlanStore((s) => s.applied);
  const removeOne = usePlanStore((s) => s.removeOne);
  const clear = usePlanStore((s) => s.clear);
  const applyOne = usePlanStore((s) => s.applyOne);
  const applyAll = usePlanStore((s) => s.applyAll);
  const addActivity = useChatStore((s) => s.addActivity);
  const [busy, setBusy] = useState(false);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);

  useEffect(() => {
    if (!open && queue.length === 0) return;
    let mounted = true;
    void native.checkpointList().then((items) => {
      if (mounted) setCheckpoints(items);
    });
    return () => {
      mounted = false;
    };
  }, [open, queue.length]);

  if (!open && (!autoOpen || queue.length === 0)) return null;
  const historyCount = applied.length + checkpoints.length;

  const onApply = async () => {
    setBusy(true);
    try {
      const results = await applyAll();
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        console.error("plan apply failures:", failed);
        setFeedback(`${failed.length} change${failed.length === 1 ? "" : "s"} could not be applied. They remain in review.`);
        addActivity({
          label: "Some reviewed changes could not be applied",
          detail: `${failed.length} change${failed.length === 1 ? "" : "s"} remain queued`,
          tone: "error",
        });
      } else {
        setFeedback(`${results.length} change${results.length === 1 ? "" : "s"} applied. A restore point is available in Undo.`);
        addActivity({
          label: `Applied ${results.length} reviewed change${results.length === 1 ? "" : "s"}`,
          detail: "Restore points are available in Undo",
          tone: "success",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const onApplyOne = async (id: string) => {
    setApplyingId(id);
    setFeedback(null);
    try {
      const result = await applyOne(id);
      if (!result) return;
      if (result.ok) {
        setFeedback("Change applied. A restore point is available in Undo.");
        addActivity({
          label: "Applied a reviewed change",
          detail: "Restore point available in Undo",
          tone: "success",
        });
      } else {
        setFeedback(`Could not apply change: ${result.error ?? "Unknown error"}`);
        addActivity({
          label: "Reviewed change could not be applied",
          detail: result.error,
          tone: "error",
        });
      }
    } finally {
      setApplyingId(null);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background/85 backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[13px] font-semibold tracking-tight">
            Change review
          </span>
          <span className="text-[10.5px] text-muted-foreground">
            {queue.length
              ? `${queue.length} pending change${queue.length === 1 ? "" : "s"}`
              : historyCount
                ? `${historyCount} restorable change${historyCount === 1 ? "" : "s"}`
                : "No changes to review"}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {queue.length ? <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-[11px] hover:bg-destructive/10 hover:text-destructive"
            onClick={() => clear()}
            disabled={busy}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            Discard all
          </Button> : null}
          {queue.length ? <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 text-[11px]"
            onClick={onApply}
            disabled={busy}
          >
            <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
            Apply {queue.length}
          </Button> : null}
          {onClose ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={onClose}
              aria-label="Close change review"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
            </Button>
          ) : null}
        </div>
      </div>
      {feedback ? (
        <div className="border-b border-border/40 bg-muted/25 px-3 py-1.5 text-[10.5px] text-muted-foreground">
          {feedback}
        </div>
      ) : null}
      <div className="flex flex-1 flex-col gap-3 overflow-auto p-3">
        {queue.length ? <section>
          <div className="mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Awaiting your decision</div>
          <ul className="flex flex-col gap-1.5">
          {queue.map((q) => (
          <PlanRow
            key={q.id}
            item={q}
            busy={busy || applyingId === q.id}
            onOpenDiff={() => {
              if (q.kind === "create_directory") return;
              window.dispatchEvent(
                new CustomEvent("altai:plan-review-diff", { detail: q }),
              );
            }}
            onApply={() => void onApplyOne(q.id)}
            onReject={() => removeOne(q.id)}
          />
          ))}
          </ul>
        </section> : null}
        <ReviewHistory items={checkpoints} applied={applied} onCheckpointsChange={setCheckpoints} />
        {!queue.length && !historyCount ? <div className="rounded-lg border border-dashed border-border/60 px-4 py-8 text-center text-[11px] leading-relaxed text-muted-foreground">When the agent proposes a plan or edits a file, it will appear here with a safe restore option.</div> : null}
      </div>
    </div>
  );
}

function PlanRow({
  item,
  busy,
  onOpenDiff,
  onApply,
  onReject,
}: {
  item: QueuedEdit;
  busy: boolean;
  onOpenDiff: () => void;
  onApply: () => void;
  onReject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isDir = item.kind === "create_directory";
  const isNew = item.isNewFile && !isDir;
  const stats = isDir
    ? null
    : diffStats(item.originalContent, item.proposedContent);
  const Icon = isDir
    ? FolderAddIcon
    : isNew
      ? FilePlusIcon
      : FileEditIcon;

  return (
    <li className="group/row overflow-hidden rounded-md border border-border/50 bg-card">
      <div className="flex items-start gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={() => !isDir && setOpen((v) => !v)}
          disabled={isDir}
          className={cn(
            "mt-0.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
            isDir && "invisible",
          )}
          aria-label="Toggle diff"
        >
          <HugeiconsIcon icon={ArrowDown01Icon} size={11} strokeWidth={1.75} />
        </button>
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 font-mono text-[11.5px]">
            <span className="truncate text-foreground">
              {basename(item.path)}
            </span>
            {isNew ? (
              <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                new
              </span>
            ) : null}
          </div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {item.path}
          </div>
          {stats ? (
            <div className="mt-0.5 flex items-center gap-2 text-[10px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">
                +{stats.added}
              </span>
              <span className="text-destructive">−{stats.removed}</span>
              <span className="text-muted-foreground">
                {item.kind === "multi_edit" ? "multi-edit" : item.kind}
              </span>
            </div>
          ) : (
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {item.description ?? "create directory"}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
          {!isDir ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-5"
              onClick={onOpenDiff}
              disabled={busy}
              aria-label="Open full diff"
            >
              <HugeiconsIcon icon={FileEditIcon} size={11} strokeWidth={1.75} />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-5"
            onClick={onReject}
            disabled={busy}
            aria-label="Reject"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-5 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400"
            onClick={onApply}
            disabled={busy}
            aria-label="Apply this change"
          >
            <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={1.75} />
          </Button>
        </div>
      </div>
      {open && !isDir ? (
        <div className="border-t border-border/40 bg-muted/20 px-2.5 py-2">
          <UnifiedDiffPreview
            original={item.originalContent}
            proposed={item.proposedContent}
          />
        </div>
      ) : null}
    </li>
  );
}

function ReviewHistory({
  items,
  applied,
  onCheckpointsChange,
}: {
  items: CheckpointInfo[];
  applied: AppliedPlanEdit[];
  onCheckpointsChange: (items: CheckpointInfo[]) => void;
}) {
  const restoreApplied = usePlanStore((s) => s.restoreApplied);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!items.length && !applied.length) return null;

  const restoreCheckpoint = async (id: string) => {
    if (restoring) return;
    setError(null);
    setRestoring(id);
    try {
      await native.checkpointRestore(id);
      onCheckpointsChange(await native.checkpointList());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring(null);
    }
  };

  const restoreReviewed = async (id: string) => {
    if (restoring) return;
    setError(null);
    setRestoring(id);
    try {
      const result = await restoreApplied(id);
      if (result && !result.ok) setError(result.error ?? "Could not restore change.");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="border-t border-border/45 pt-3">
      <div className="mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Restore points</div>
      <p className="mb-2 px-0.5 text-[10px] leading-relaxed text-muted-foreground">Every agent edit has a pre-edit snapshot. Restoring a new file removes it; restoring an existing file puts its prior content back.</p>
      {error ? <p className="mb-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[10px] text-destructive">{error}</p> : null}
      <div className="space-y-1.5">
        {[...applied].reverse().map((item) => (
          <HistoryRow
            key={`plan-${item.id}`}
            path={item.path}
            detail={`Accepted review · ${item.isNewFile ? "remove new file" : "restore prior content"}`}
            restoring={restoring === item.id}
            onRestore={() => void restoreReviewed(item.id)}
          />
        ))}
        {items.map((item) => (
          <HistoryRow
            key={item.id}
            path={item.path}
            detail={`${item.label} · ${new Date(item.createdMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
            restoring={restoring === item.id}
            onRestore={() => void restoreCheckpoint(item.id)}
          />
        ))}
      </div>
    </section>
  );
}

function HistoryRow({
  path,
  detail,
  restoring,
  onRestore,
}: {
  path: string;
  detail: string;
  restoring: boolean;
  onRestore: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card/60 px-2.5 py-2">
      <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-foreground" title={path}>{basename(path)}</div>
        <div className="truncate text-[9.5px] text-muted-foreground" title={detail}>{detail}</div>
      </div>
      <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" disabled={restoring} onClick={onRestore}>
        {restoring ? "Restoring…" : "Restore"}
      </Button>
    </div>
  );
}

function UnifiedDiffPreview({
  original,
  proposed,
}: {
  original: string;
  proposed: string;
}) {
  // Coarse line-level diff (LCS-lite via set membership). For real diffs
  // we'd reach for a library; this is good enough for at-a-glance review.
  const a = original.split("\n");
  const b = proposed.split("\n");
  const setA = new Set(a);
  const setB = new Set(b);

  const lines: Array<{ kind: "add" | "del" | "ctx"; text: string }> = [];
  // First pass: removed (in a, not in b).
  for (const l of a) if (!setB.has(l)) lines.push({ kind: "del", text: l });
  // Then: added (in b, not in a).
  for (const l of b) if (!setA.has(l)) lines.push({ kind: "add", text: l });

  if (lines.length === 0) {
    return (
      <div className="text-[11px] italic text-muted-foreground">
        no line-level changes
      </div>
    );
  }

  const MAX = 80;
  const shown = lines.slice(0, MAX);
  const rest = lines.length - shown.length;

  return (
    <div className="overflow-hidden rounded border border-border/40 font-mono text-[11px] leading-relaxed">
      <div className="max-h-72 overflow-auto">
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn(
              "flex whitespace-pre",
              l.kind === "add"
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/10 text-destructive",
            )}
          >
            <span className="w-4 shrink-0 select-none px-1 text-center opacity-70">
              {l.kind === "add" ? "+" : "-"}
            </span>
            <span className="min-w-0 flex-1 overflow-x-auto pr-2">
              {l.text || " "}
            </span>
          </div>
        ))}
        {rest > 0 ? (
          <div className="px-2 py-1 text-[10px] italic text-muted-foreground">
            … {rest} more changes
          </div>
        ) : null}
      </div>
    </div>
  );
}
