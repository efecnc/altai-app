import { native } from "@/modules/ai/lib/native";
import { parseRemoteWebUrl } from "@/modules/git-history/lib/remoteWebUrl";
import { useEffect, useState } from "react";
import type { RepoSlug } from "./items";

export type SlugState =
  | { status: "loading" }
  | { status: "ready"; slug: RepoSlug }
  | { status: "none" };

/** Resolve the GitHub owner/repo for a local repo root via its origin remote. */
export function useRepoSlug(repoRoot: string): SlugState {
  const [state, setState] = useState<SlugState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    native
      .gitRemoteUrl(repoRoot)
      .then((url) => {
        if (!alive) return;
        const info = parseRemoteWebUrl(url);
        setState(
          info && info.host === "github"
            ? { status: "ready", slug: { owner: info.owner, repo: info.repo } }
            : { status: "none" },
        );
      })
      .catch(() => {
        if (alive) setState({ status: "none" });
      });
    return () => {
      alive = false;
    };
  }, [repoRoot]);

  return state;
}
