import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  addComment,
  getIssue,
  getPull,
  type GHComment,
  type GHItem,
  type GHPullDetail,
  type ItemKind,
  listComments,
  mergePull,
  relativeTime,
  type RepoSlug,
  setIssueState,
} from "@/modules/github/lib/items";
import {
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  GitMergeIcon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { AssignAgentButton } from "./AssignAgentButton";
import { Avatar, ItemStateIcon, itemState, Labels, StateBadge } from "./itemBits";

type Props = {
  slug: RepoSlug;
  kind: ItemKind;
  number: number;
  onBack: () => void;
  onMutated: () => void;
};

const MD = { code: MarkdownCode };

export function ItemDetailView({ slug, kind, number, onBack, onMutated }: Props) {
  const [item, setItem] = useState<GHItem | GHPullDetail | null>(null);
  const [comments, setComments] = useState<GHComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "state" | "merge" | "comment">(null);
  const [draft, setDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail =
        kind === "pulls"
          ? await getPull(slug, number)
          : await getIssue(slug, number);
      const cs = await listComments(slug, number);
      setItem(detail);
      setComments(cs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [slug, kind, number]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleState = async () => {
    if (!item || busy) return;
    setBusy("state");
    setError(null);
    try {
      await setIssueState(slug, number, item.state === "open" ? "closed" : "open");
      await load();
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const doMerge = async () => {
    if (busy) return;
    setBusy("merge");
    setError(null);
    try {
      await mergePull(slug, number);
      await load();
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submitComment = async () => {
    if (!draft.trim() || busy) return;
    setBusy("comment");
    setError(null);
    try {
      const c = await addComment(slug, number, draft.trim());
      setComments((cs) => [...cs, c]);
      setDraft("");
      onMutated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const pull = item && "merged" in item ? (item as GHPullDetail) : null;
  const canMerge =
    pull && pull.state === "open" && !pull.merged && pull.mergeable === true;
  const st = item ? itemState(item) : "open";
  const resolution =
    item && st === "merged"
      ? `merged ${relativeTime(
          item.merged_at ?? item.pull_request?.merged_at ?? item.updated_at,
        )}`
      : item && (st === "closed" || st === "not_planned")
        ? `${
            st === "not_planned" ? "closed as not planned" : "closed"
          } ${relativeTime(item.closed_at ?? item.updated_at)}`
        : null;

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-4 py-3">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 -ml-1.5 flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} size={13} strokeWidth={2} />
        Back to list
      </button>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading…
        </div>
      ) : !item ? (
        <p className="py-6 text-[12px] text-destructive">{error ?? "Not found."}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {/* Title + state */}
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5">
                <ItemStateIcon state={st} kind={kind} size={18} />
              </span>
              <h2 className="flex-1 text-[15px] font-semibold leading-snug text-foreground">
                {item.title}{" "}
                <span className="font-normal text-muted-foreground/60">
                  #{item.number}
                </span>
              </h2>
              <StateBadge state={st} kind={kind} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <Avatar url={item.user?.avatar_url} size={16} />
              <span className="font-medium text-foreground/80">
                {item.user?.login ?? "unknown"}
              </span>
              <span>· opened {relativeTime(item.created_at)}</span>
              {resolution ? (
                <span className="text-muted-foreground/80">· {resolution}</span>
              ) : null}
              {pull ? (
                <span className="font-mono text-[10.5px]">
                  {pull.head.ref} → {pull.base.ref}
                </span>
              ) : null}
            </div>
            <Labels labels={item.labels} />
          </div>

          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2 border-y border-border/50 py-2">
            {canMerge ? (
              <Button
                size="xs"
                className="h-7 gap-1.5 text-[11px]"
                onClick={() => void doMerge()}
                disabled={!!busy}
              >
                {busy === "merge" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <HugeiconsIcon icon={GitMergeIcon} size={12} strokeWidth={1.9} />
                )}
                Merge
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              className="h-7 gap-1.5 text-[11px]"
              onClick={() => void toggleState()}
              disabled={!!busy}
            >
              {busy === "state" ? (
                <Spinner className="size-3.5" />
              ) : (
                <HugeiconsIcon
                  icon={CheckmarkCircle02Icon}
                  size={12}
                  strokeWidth={1.9}
                />
              )}
              {item.state === "open"
                ? kind === "pulls"
                  ? "Close PR"
                  : "Close issue"
                : "Reopen"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="h-7 text-[11px]"
              onClick={() => void openUrl(item.html_url)}
            >
              Open on GitHub ↗
            </Button>
            <div className="ml-auto">
              <AssignAgentButton
                kind={kind === "pulls" ? "pr" : "issue"}
                slug={slug}
                number={number}
                title={item.title}
                body={item.body}
                url={item.html_url}
                variant="button"
              />
            </div>
          </div>

          {/* Body */}
          <div className="rounded-lg border border-border/50 bg-card/30 px-3 py-2">
            {item.body?.trim() ? (
              <Streamdown
                className="prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                components={MD}
              >
                {item.body}
              </Streamdown>
            ) : (
              <p className="text-[11.5px] italic text-muted-foreground/60">
                No description provided.
              </p>
            )}
          </div>

          {/* Comments */}
          {comments.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                {comments.length} comment{comments.length === 1 ? "" : "s"}
              </p>
              {comments.map((c) => (
                <div
                  key={c.id}
                  className="rounded-lg border border-border/50 bg-card/30 px-3 py-2"
                >
                  <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Avatar url={c.user?.avatar_url} size={16} />
                    <span className="font-medium text-foreground/80">
                      {c.user?.login ?? "unknown"}
                    </span>
                    <span>· {relativeTime(c.created_at)}</span>
                  </div>
                  <Streamdown
                    className="prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
                    components={MD}
                  >
                    {c.body}
                  </Streamdown>
                </div>
              ))}
            </div>
          ) : null}

          {/* Comment composer */}
          <div className="flex flex-col gap-2 rounded-xl border border-border/50 bg-card/30 p-2 pb-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Leave a comment…"
              aria-label="New comment"
              rows={3}
              className="resize-none border-0 bg-transparent px-1 text-[12px] shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2">
              <span className="pl-1 text-[10.5px] text-muted-foreground/50">
                Markdown supported
              </span>
              <Button
                size="xs"
                className="h-7 gap-1.5 text-[11px]"
                onClick={() => void submitComment()}
                disabled={!draft.trim() || !!busy}
              >
                {busy === "comment" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <HugeiconsIcon icon={SentIcon} size={12} strokeWidth={1.9} />
                )}
                Comment
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
