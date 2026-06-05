import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { RepoSlug } from "@/modules/github/lib/items";
import {
  assignGitHubItem,
  isItemAssigned,
  useAssignmentsStore,
} from "@/modules/github/store/assignmentsStore";
import { Robot01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

type Props = {
  kind: "issue" | "pr";
  slug: RepoSlug;
  number: number;
  title: string;
  body: string | null;
  url: string;
  /** "chip" for list rows, "button" for the detail actions bar. */
  variant?: "chip" | "button";
};

/** Dispatch an agent for a GitHub issue/PR. Shows an assigned state once a run
 *  exists, and surfaces dispatch errors (e.g. no model configured). */
export function AssignAgentButton({
  kind,
  slug,
  number,
  title,
  body,
  url,
  variant = "chip",
}: Props) {
  const assignments = useAssignmentsStore((s) => s.assignments);
  const assigned = isItemAssigned(assignments, kind, number);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy || assigned) return;
    setBusy(true);
    setError(null);
    try {
      await assignGitHubItem({ kind, slug, number, title, body, url });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (assigned) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 font-medium text-emerald-500",
          variant === "button" ? "text-[12px]" : "text-[10px]",
        )}
      >
        <HugeiconsIcon icon={Robot01Icon} size={12} strokeWidth={1.9} />
        Assigned
      </span>
    );
  }

  if (variant === "button") {
    return (
      <Button
        size="xs"
        variant="outline"
        className="h-7 gap-1.5 text-[11px]"
        onClick={onClick}
        disabled={busy}
        title={error ?? undefined}
      >
        {busy ? (
          <Spinner className="size-3.5" />
        ) : (
          <HugeiconsIcon icon={Robot01Icon} size={12} strokeWidth={1.9} />
        )}
        Assign agent
      </Button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={error ?? "Assign an agent to work on this"}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors",
        error
          ? "text-red-500 hover:bg-red-500/10"
          : "text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {busy ? (
        <Spinner className="size-3" />
      ) : (
        <HugeiconsIcon icon={Robot01Icon} size={11} strokeWidth={1.9} />
      )}
      Assign
    </button>
  );
}
