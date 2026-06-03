import { Spinner } from "@/components/ui/spinner";
import { cn, plural } from "@/lib/utils";
import {
  AlertCircleIcon,
  ShieldUserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import { toolLabel } from "@/components/ai-elements/tool";
import { useChatStore, type AgentMeta } from "../store/chatStore";

type Props = {
  // When provided the pill is a button (opens the AI log). Omit it to render
  // a non-interactive status chip — used inline in the chat transcript.
  onClick?: () => void;
  // Show a "Thinking…" fallback even before the first agent event lands, so
  // the chat reflects the transport's submitted/streaming window too.
  busy?: boolean;
  // Suppress the error state — the chat renders its own dismissible error
  // block, so the inline pill shouldn't duplicate it.
  hideError?: boolean;
  // Render the sr-only live region. The pill is mounted in more than one
  // place (inline transcript + log opener); only one instance should own
  // the announcement or screen readers double-announce every status change.
  announce?: boolean;
};

export function AgentStatusPill({
  onClick,
  busy = false,
  hideError = false,
  announce = true,
}: Props) {
  const meta = useChatStore((s) => s.agentMeta);

  const subCount = meta.activeSubagents.length;
  const active =
    busy || meta.status !== "idle" || Boolean(meta.error) || subCount > 0;
  if (!active) return null;
  if (hideError && meta.status === "error") return null;

  const { tone, icon, label } = describe(meta, subCount);
  const subLabel = subCount > 0 ? `${plural(subCount, "subagent")} running` : "";
  const subSuffix = subLabel ? `, ${subLabel}` : "";
  const className = cn(
    "flex h-6 items-center gap-1.5 rounded-md border px-1.5 text-[11px] transition-colors",
    tone,
  );
  const anim = {
    initial: { opacity: 0, y: 2 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -2 },
    transition: { duration: 0.12, ease: "easeOut" as const },
  };
  const inner = (
    <>
      {icon}
      <span className="max-w-[180px] truncate">{label}</span>
      {subCount > 0 ? (
        <span
          aria-hidden="true"
          className="ml-0.5 rounded bg-muted px-1 text-[10px] font-medium tabular-nums text-foreground/80"
          title={subLabel}
        >
          {subCount} sub
        </span>
      ) : null}
    </>
  );

  return (
    <>
      {/* Stable live region — sits outside AnimatePresence so the key change
          on the element below doesn't tear down the announcement. Only the
          announcing instance renders it so a second mounted pill doesn't
          double-announce. */}
      {announce ? (
        <span role="status" aria-live="polite" className="sr-only">
          Agent status: {label}
          {subSuffix}
        </span>
      ) : null}
      <AnimatePresence mode="wait">
        {onClick ? (
          <motion.button
            key={`${meta.status}:${label}`}
            type="button"
            onClick={onClick}
            {...anim}
            className={cn(className, "hover:bg-muted/40")}
            aria-label={`Open AI log — ${label}`}
          >
            {inner}
          </motion.button>
        ) : (
          <motion.div key={`${meta.status}:${label}`} {...anim} className={className}>
            {inner}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function describe(meta: AgentMeta, subCount: number): {
  tone: string;
  icon: React.ReactNode;
  label: string;
} {
  if (meta.status === "awaiting-approval") {
    return {
      tone:
        "border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/15",
      icon: (
        <HugeiconsIcon icon={ShieldUserIcon} size={12} strokeWidth={1.75} />
      ),
      label:
        meta.approvalsPending > 1
          ? `${meta.approvalsPending} approvals needed`
          : "Approval needed",
    };
  }
  if (meta.status === "error") {
    return {
      tone:
        "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15",
      icon: (
        <HugeiconsIcon icon={AlertCircleIcon} size={12} strokeWidth={1.75} />
      ),
      label: meta.error ?? "Error",
    };
  }
  // thinking | streaming. `step` is the raw tool name during a tool call —
  // run it through `toolLabel` so the pill reads "Run", not "exec".
  // When the main turn has gone idle but subagents are still running (e.g. a
  // fire-and-forget `subagent_spawn`), there's no step — fall back to a
  // subagent-aware label instead of a misleading "Thinking…".
  const fallback =
    meta.status === "idle" && subCount > 0 ? "Subagents running" : "Thinking…";
  return {
    tone:
      "border-border/60 bg-card text-muted-foreground hover:text-foreground",
    icon: <Spinner className="size-3" />,
    label: meta.step ? toolLabel(meta.step) : fallback,
  };
}
