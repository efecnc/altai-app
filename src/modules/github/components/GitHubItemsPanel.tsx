import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useGitHubStore } from "@/modules/github";
import type { GHItem, ItemKind } from "@/modules/github/lib/items";
import { useRepoSlug } from "@/modules/github/lib/useRepoSlug";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { CommitBox } from "./CommitBox";
import { CreateItemView } from "./CreateItemView";
import { ItemDetailView } from "./ItemDetailView";
import { ItemListView } from "./ItemListView";

type Props = {
  repoRoot: string;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalPath?: string | null;
  }) => void;
};

type View =
  | { mode: "list" }
  | { mode: "detail"; kind: ItemKind; number: number }
  | { mode: "create"; kind: ItemKind };

/**
 * Workspace tab that turns a repo's GitHub presence into a full hub: browse and
 * filter pull requests and issues, open them inline (body, comments, actions),
 * create new ones, and commit local changes — all without leaving ALTAI.
 */
export function GitHubItemsPanel({ repoRoot, onOpenDiff }: Props) {
  const connection = useGitHubStore((s) => s.connection);
  const slugState = useRepoSlug(repoRoot);
  const [view, setView] = useState<View>({ mode: "list" });
  const [kind, setKind] = useState<ItemKind>("pulls");
  // Bumped after a mutation (close/merge/comment/create) to refresh the list.
  const [reloadKey, setReloadKey] = useState(0);

  if (!connection) {
    return (
      <Centered>
        <Glyph />
        <p className="text-[13px] font-medium text-foreground">
          Connect your GitHub account
        </p>
        <p className="max-w-[22rem] text-center text-[12px] text-muted-foreground">
          Browse pull requests and issues, comment, and open or merge them
          without leaving ALTAI.
        </p>
        <Button onClick={() => openSettingsWindow("github")} className="gap-1.5">
          <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.75} />
          Connect to GitHub
        </Button>
      </Centered>
    );
  }

  if (slugState.status === "loading") {
    return (
      <Centered>
        <Spinner className="size-4" />
        <p className="text-[12px] text-muted-foreground">Resolving repository…</p>
      </Centered>
    );
  }

  if (slugState.status === "none") {
    return (
      <Centered>
        <Glyph />
        <p className="text-[12.5px] text-muted-foreground">
          This repository has no GitHub remote (origin).
        </p>
      </Centered>
    );
  }

  const slug = slugState.slug;

  if (view.mode === "detail") {
    return (
      <div className="flex h-full w-full flex-col">
        <ItemDetailView
          slug={slug}
          kind={view.kind}
          number={view.number}
          onBack={() => setView({ mode: "list" })}
          onMutated={() => setReloadKey((k) => k + 1)}
        />
      </div>
    );
  }

  if (view.mode === "create") {
    return (
      <div className="flex h-full w-full flex-col">
        <CreateItemView
          slug={slug}
          kind={view.kind}
          onBack={() => setView({ mode: "list" })}
          onCreated={(item: GHItem) => {
            setReloadKey((k) => k + 1);
            setView({ mode: "detail", kind: view.kind, number: item.number });
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-3 px-4 py-3">
      {/* Repo header */}
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={GithubIcon}
          size={16}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {slug.owner}/{slug.repo}
        </span>
      </div>

      <CommitBox repoRoot={repoRoot} onOpenDiff={onOpenDiff} />

      <ItemListView
        slug={slug}
        kind={kind}
        onKindChange={setKind}
        onOpenItem={(k, number) => setView({ mode: "detail", kind: k, number })}
        onCreate={(k) => setView({ mode: "create", kind: k })}
        reloadKey={reloadKey}
      />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
      {children}
    </div>
  );
}

function Glyph() {
  return (
    <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground/[0.04] text-muted-foreground">
      <HugeiconsIcon icon={GithubIcon} size={24} strokeWidth={1.6} />
    </span>
  );
}
