import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { sendMessage } from "../store/chatStore";

type PaperMeta = {
  title: string;
  authors: string[];
  abstract: string;
  url: string;
};

const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/;

type PaperImportProps = {
  onClose: () => void;
};

export function PaperImport({ onClose }: PaperImportProps) {
  const [url, setUrl] = useState("");
  const [meta, setMeta] = useState<PaperMeta | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = ARXIV_RE.test(url.trim());

  const handleFetch = useCallback(async () => {
    const trimmed = url.trim();
    if (!ARXIV_RE.test(trimmed)) return;

    setFetching(true);
    setError(null);
    setMeta(null);

    try {
      const result = await invoke<PaperMeta>("agent_fetch_paper", { url: trimmed });
      setMeta(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }, [url]);

  const handleReproduce = useCallback(async () => {
    if (!meta) return;
    const match = url.trim().match(ARXIV_RE);
    const arxivId = match?.[1] ?? url.trim();

    await sendMessage(
      JSON.stringify({
        type: "paper_to_code",
        arxiv_id: arxivId,
        title: meta.title,
        url: meta.url,
      }),
    );

    onClose();
  }, [meta, url, onClose]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <div className="text-sm font-medium text-foreground">
        Paper-to-Code Pipeline
      </div>

      {/* URL input */}
      <div className="flex gap-2">
        <input
          type="text"
          aria-label="Paper URL"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setMeta(null);
            setError(null);
          }}
          placeholder="Paste arXiv URL (e.g. arxiv.org/abs/2301.12345)"
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onKeyDown={(e) => {
            if (e.key === "Enter" && isValid && !fetching) {
              handleFetch();
            }
          }}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!isValid || fetching}
          onClick={handleFetch}
        >
          {fetching ? "Fetching..." : "Fetch"}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Paper metadata card */}
      {meta && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
          <div className="text-sm font-semibold text-foreground leading-snug">
            {meta.title}
          </div>
          <div className="text-xs text-muted-foreground">
            {meta.authors.slice(0, 5).join(", ")}
            {meta.authors.length > 5 && ` +${meta.authors.length - 5} more`}
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed line-clamp-4">
            {meta.abstract}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {meta && (
          <Button
            size="sm"
            onClick={handleReproduce}
            className={cn(
              "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            Reproduce
          </Button>
        )}
      </div>
    </div>
  );
}
