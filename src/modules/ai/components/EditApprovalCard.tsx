import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  CheckmarkCircle02Icon,
  CancelCircleIcon,
  File01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { sendMessage } from "../store/chatStore";

type EditDiff = {
  file: string;
  diff: string;
  truncated: boolean;
};

type Props = {
  diff: EditDiff;
};

/**
 * Inline diff-review card shown when the crate's edit gate requests approval
 * (permission mode "ask"). Renders the file path, a colorized unified-diff
 * preview, and Approve / Deny actions. The reply rides the existing
 * clarification channel — clicking a button sends `approve` / `deny` as a
 * normal message, which IsanAgent's `ClarificationHub` routes back to the
 * waiting `ask_user` tool.
 *
 * Deny is the fail-safe default in the crate (`shell_approval_reply_is_grant`
 * is deny-on-anything-but-an-explicit-yes), so this card cannot accidentally
 * approve by dismissing it.
 */
export function EditApprovalCard({ diff }: Props) {
  const [sent, setSent] = useState<"approve" | "deny" | null>(null);

  const reply = (choice: "approve" | "deny") => {
    if (sent) return;
    setSent(choice);
    void sendMessage(choice);
  };

  const lines = parseDiffLines(diff.diff);

  return (
    <div
      role="group"
      aria-label={`Edit approval for ${diff.file}`}
      className="flex shrink-0 flex-col gap-2 border-t border-border/40 bg-amber-500/[0.04] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 text-[11px] font-medium text-foreground">
          Edit approval
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {diff.file}
        </span>
        {diff.truncated ? (
          <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9.5px] font-medium text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>

      <ScrollArea className="max-h-56 min-h-0 rounded-md border border-border/40 bg-background/60">
        <pre className="m-0 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed">
          {lines.length > 0 ? (
            lines.map((ln, i) => (
              <span
                // eslint-disable-next-line react/no-array-index-key
                key={i}
                className={cn(
                  "block whitespace-pre",
                  ln.kind === "add" &&
                    "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                  ln.kind === "del" &&
                    "bg-destructive/10 text-destructive",
                  ln.kind === "hunk" && "text-sky-600 dark:text-sky-400",
                  ln.kind === "meta" && "text-muted-foreground/70",
                )}
              >
                <span className="select-none opacity-60">{ln.gutter}</span>
                {ln.text}
              </span>
            ))
          ) : (
            <span className="whitespace-pre-wrap text-muted-foreground">
              {diff.diff || " "}
            </span>
          )}
        </pre>
      </ScrollArea>

      <div className="flex items-center justify-end gap-1.5">
        {sent ? (
          <span className="text-[10.5px] text-muted-foreground">
            {sent === "approve" ? "Approved — sending…" : "Denied — sending…"}
          </span>
        ) : (
          <>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => reply("deny")}
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <HugeiconsIcon
                icon={CancelCircleIcon}
                size={12}
                strokeWidth={1.75}
              />
              Deny
            </Button>
            <Button
              type="button"
              size="xs"
              onClick={() => reply("approve")}
              className="h-7 gap-1 px-2.5 text-[11px] font-medium"
            >
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                size={12}
                strokeWidth={1.75}
              />
              Approve
            </Button>
          </>
        )}
      </div>
      <span aria-live="polite" className="sr-only">
        File edit approval requested for {diff.file}. Approve or deny.
      </span>
    </div>
  );
}

type DiffLine = {
  kind: "add" | "del" | "hunk" | "meta" | "ctx";
  gutter: string;
  text: string;
};

/** Parse a unified diff into per-line render hints. Lines that don't match the
 *  unified-diff grammar (e.g. a free-form preview) fall back to a single
 *  context block so the user still sees the raw text. */
function parseDiffLines(diff: string): DiffLine[] {
  if (!diff) return [];
  const out: DiffLine[] = [];
  let sawAny = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) {
      out.push({ kind: "meta", gutter: raw.slice(0, 1), text: raw.slice(1) });
      sawAny = true;
      continue;
    }
    if (raw.startsWith("@@")) {
      out.push({ kind: "hunk", gutter: "@", text: raw.slice(1) });
      sawAny = true;
      continue;
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", gutter: "+", text: raw.slice(1) });
      sawAny = true;
      continue;
    }
    if (raw.startsWith("-")) {
      out.push({ kind: "del", gutter: "-", text: raw.slice(1) });
      sawAny = true;
      continue;
    }
    if (raw.startsWith(" ")) {
      out.push({ kind: "ctx", gutter: " ", text: raw.slice(1) });
      sawAny = true;
      continue;
    }
    out.push({ kind: "ctx", gutter: " ", text: raw });
  }
  return sawAny ? out : [];
}
