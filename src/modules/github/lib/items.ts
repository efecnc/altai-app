import { github } from "./github";

/** A GitHub user as returned on issues, PRs, and comments. */
export type GHUser = { login: string; avatar_url: string };

export type GHLabel = { id: number; name: string; color: string };

export type ItemKind = "pulls" | "issues";
export type ItemStateFilter = "open" | "closed" | "all";

/** Shared shape for a pull request or issue list row. */
export type GHItem = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  user: GHUser | null;
  labels: GHLabel[];
  comments: number;
  created_at: string;
  updated_at: string;
  /** Set once the item is closed (merged or rejected/resolved). */
  closed_at?: string | null;
  /** Why an issue was closed: "completed" (resolved) vs "not_planned". */
  state_reason?: "completed" | "reopened" | "not_planned" | null;
  draft?: boolean;
  /** Top-level on /pulls list rows (null until merged). */
  merged_at?: string | null;
  /** Present (truthy) on issues that are actually PRs; PR detail adds fields. */
  pull_request?: { merged_at: string | null } | null;
};

/** Extra fields returned by the pulls detail endpoint. */
export type GHPullDetail = GHItem & {
  merged: boolean;
  mergeable: boolean | null;
  head: { ref: string };
  base: { ref: string };
};

export type GHComment = {
  id: number;
  body: string;
  user: GHUser | null;
  created_at: string;
};

export type RepoSlug = { owner: string; repo: string };

function base(slug: RepoSlug): string {
  return `/repos/${slug.owner}/${slug.repo}`;
}

/** List open/closed/all PRs or issues. Issues endpoint includes PRs, so we
 *  drop those to keep the Issues list clean. */
export async function listItems(
  slug: RepoSlug,
  kind: ItemKind,
  state: ItemStateFilter,
): Promise<GHItem[]> {
  if (kind === "pulls") {
    return github.api<GHItem[]>(
      "GET",
      `${base(slug)}/pulls?state=${state}&per_page=50&sort=updated&direction=desc`,
    );
  }
  const list = await github.api<GHItem[]>(
    "GET",
    `${base(slug)}/issues?state=${state}&per_page=50&sort=updated&direction=desc`,
  );
  return list.filter((i) => !i.pull_request);
}

export function getIssue(slug: RepoSlug, number: number): Promise<GHItem> {
  return github.api<GHItem>("GET", `${base(slug)}/issues/${number}`);
}

export function getPull(slug: RepoSlug, number: number): Promise<GHPullDetail> {
  return github.api<GHPullDetail>("GET", `${base(slug)}/pulls/${number}`);
}

export function listComments(
  slug: RepoSlug,
  number: number,
): Promise<GHComment[]> {
  return github.api<GHComment[]>(
    "GET",
    `${base(slug)}/issues/${number}/comments?per_page=100`,
  );
}

export function addComment(
  slug: RepoSlug,
  number: number,
  body: string,
): Promise<GHComment> {
  return github.api<GHComment>("POST", `${base(slug)}/issues/${number}/comments`, {
    body,
  });
}

export function setIssueState(
  slug: RepoSlug,
  number: number,
  state: "open" | "closed",
): Promise<unknown> {
  return github.api("PATCH", `${base(slug)}/issues/${number}`, { state });
}

export function mergePull(slug: RepoSlug, number: number): Promise<unknown> {
  return github.api("PUT", `${base(slug)}/pulls/${number}/merge`, {});
}

export function createIssue(
  slug: RepoSlug,
  input: { title: string; body: string; labels: string[] },
): Promise<GHItem> {
  return github.api<GHItem>("POST", `${base(slug)}/issues`, {
    title: input.title,
    body: input.body,
    labels: input.labels,
  });
}

export function createPull(
  slug: RepoSlug,
  input: { title: string; body: string; base: string; head: string },
): Promise<GHItem> {
  return github.api<GHItem>("POST", `${base(slug)}/pulls`, {
    title: input.title,
    body: input.body,
    base: input.base,
    head: input.head,
  });
}

export async function listBranches(slug: RepoSlug): Promise<string[]> {
  const list = await github.api<{ name: string }[]>(
    "GET",
    `${base(slug)}/branches?per_page=100`,
  );
  return list.map((b) => b.name);
}

export function listLabels(slug: RepoSlug): Promise<GHLabel[]> {
  return github.api<GHLabel[]>("GET", `${base(slug)}/labels?per_page=100`);
}

/** Compact "3d ago" relative time for an ISO timestamp. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return "just now";
  const units: [number, string][] = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
    [604800, "w"],
    [2592000, "mo"],
    [31536000, "y"],
  ];
  let value = diffSec;
  let label = "y";
  for (let i = units.length - 1; i >= 0; i--) {
    if (diffSec >= units[i][0]) {
      value = Math.floor(diffSec / units[i][0]);
      label = units[i][1];
      break;
    }
  }
  return `${value}${label} ago`;
}
