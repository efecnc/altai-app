import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  createIssue,
  createPull,
  type GHItem,
  type GHLabel,
  type ItemKind,
  listBranches,
  listLabels,
  type RepoSlug,
} from "@/modules/github/lib/items";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type Props = {
  slug: RepoSlug;
  kind: ItemKind;
  onBack: () => void;
  onCreated: (item: GHItem) => void;
};

function pickDefaultBase(branches: string[]): string {
  return (
    branches.find((b) => b === "main" || b === "master") ?? branches[0] ?? ""
  );
}

export function CreateItemView({ slug, kind, onBack, onCreated }: Props) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Issue: label options. PR: branch options.
  const [labels, setLabels] = useState<GHLabel[]>([]);
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [branches, setBranches] = useState<string[]>([]);
  const [baseRef, setBaseRef] = useState("");
  const [headRef, setHeadRef] = useState("");

  useEffect(() => {
    let alive = true;
    if (kind === "issues") {
      listLabels(slug)
        .then((l) => alive && setLabels(l))
        .catch(() => {});
    } else {
      listBranches(slug)
        .then((b) => {
          if (!alive) return;
          setBranches(b);
          const base = pickDefaultBase(b);
          setBaseRef(base);
          setHeadRef(b.find((x) => x !== base) ?? base);
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [slug, kind]);

  const valid =
    title.trim().length > 0 &&
    (kind === "issues" || (baseRef && headRef && baseRef !== headRef));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const item =
        kind === "issues"
          ? await createIssue(slug, {
              title: title.trim(),
              body: body.trim(),
              labels: [...selectedLabels],
            })
          : await createPull(slug, {
              title: title.trim(),
              body: body.trim(),
              base: baseRef,
              head: headRef,
            });
      onCreated(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleLabel = (name: string) =>
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const selectClass =
    "h-8 rounded-lg border border-border/60 bg-background/60 px-2 text-[12px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-3 overflow-y-auto px-4 py-3">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={13} strokeWidth={2} />
        Back to list
      </button>

      <h2 className="text-[14px] font-semibold text-foreground">
        {kind === "pulls" ? "New pull request" : "New issue"}
      </h2>

      {kind === "pulls" ? (
        <div className="flex items-center gap-2">
          <select
            value={baseRef}
            onChange={(e) => setBaseRef(e.target.value)}
            aria-label="Base branch"
            className={cn(selectClass, "min-w-0 flex-1")}
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                base: {b}
              </option>
            ))}
          </select>
          <span className="text-muted-foreground">←</span>
          <select
            value={headRef}
            onChange={(e) => setHeadRef(e.target.value)}
            aria-label="Compare branch"
            className={cn(selectClass, "min-w-0 flex-1")}
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                compare: {b}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title"
        aria-label="Title"
        className="text-[13px]"
      />

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Leave a description… (Markdown supported)"
        aria-label="Description"
        rows={8}
        className="resize-none text-[12px]"
      />

      {kind === "issues" && labels.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            Labels
          </p>
          <div className="flex flex-wrap gap-1.5">
            {labels.map((l) => {
              const on = selectedLabels.has(l.name);
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => toggleLabel(l.name)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                    on
                      ? "border-transparent text-foreground"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                  style={
                    on ? { backgroundColor: `#${l.color}33` } : undefined
                  }
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: `#${l.color}` }}
                  />
                  {l.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {error ? <p className="text-[11.5px] text-destructive">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="ml-auto h-8 text-[12px]"
          onClick={() => void submit()}
          disabled={!valid || busy}
        >
          {busy ? (
            <Spinner className="size-3.5" />
          ) : kind === "pulls" ? (
            "Create pull request"
          ) : (
            "Create issue"
          )}
        </Button>
      </div>
    </div>
  );
}
