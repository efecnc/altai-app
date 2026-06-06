import type { GitChangedFile, GitStatusSnapshot } from "@/modules/ai/lib/native";

/** A file's Git change category, mirroring VS Code's source control decorations. */
export type GitStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflict"
  | "ignored";

export type GitDecorationMap = {
  /** Absolute file path → its own status. */
  files: Map<string, GitStatusKind>;
  /** Absolute directory path → the most significant status it contains. */
  dirs: Map<string, GitStatusKind>;
};

export const EMPTY_GIT_DECORATIONS: GitDecorationMap = {
  files: new Map(),
  dirs: new Map(),
};

// When a folder holds files of several kinds, the highest-priority one wins.
const KIND_PRIORITY: Record<GitStatusKind, number> = {
  conflict: 6,
  deleted: 5,
  modified: 4,
  renamed: 3,
  added: 2,
  untracked: 1,
  ignored: 0,
};

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function classifyFile(file: GitChangedFile): GitStatusKind {
  const index = file.indexStatus.trim().toUpperCase();
  const worktree = file.worktreeStatus.trim().toUpperCase();
  if (CONFLICT_CODES.has(`${index}${worktree}`)) return "conflict";
  if (file.untracked) return "untracked";
  // Prefer the worktree change, falling back to the staged (index) change.
  const code = worktree !== "" ? worktree : index;
  switch (code) {
    case "?":
      return "untracked";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "!":
      return "ignored";
    default:
      return "modified";
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function buildGitDecorations(
  status: GitStatusSnapshot | null,
): GitDecorationMap {
  if (!status || status.changedFiles.length === 0) return EMPTY_GIT_DECORATIONS;

  const repoRoot = normalize(status.repoRoot);
  const files = new Map<string, GitStatusKind>();
  const dirs = new Map<string, GitStatusKind>();

  const bumpDir = (dir: string, kind: GitStatusKind) => {
    const current = dirs.get(dir);
    if (!current || KIND_PRIORITY[kind] > KIND_PRIORITY[current]) {
      dirs.set(dir, kind);
    }
  };

  for (const file of status.changedFiles) {
    const kind = classifyFile(file);
    const absolute = normalize(`${repoRoot}/${file.path}`);
    files.set(absolute, kind);

    // Propagate up to every ancestor so collapsed folders still surface
    // the most significant change they contain.
    let parent = absolute.slice(0, absolute.lastIndexOf("/"));
    while (parent.length >= repoRoot.length && parent.includes("/")) {
      bumpDir(parent, kind);
      if (parent === repoRoot) break;
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }

  return { files, dirs };
}

const KIND_CLASS: Record<GitStatusKind, string> = {
  modified: "text-amber-600 dark:text-amber-400",
  added: "text-emerald-600 dark:text-emerald-400",
  untracked: "text-emerald-600 dark:text-emerald-400",
  renamed: "text-sky-600 dark:text-sky-400",
  deleted: "text-rose-600 dark:text-rose-400",
  conflict: "text-rose-600 dark:text-rose-400",
  ignored: "text-muted-foreground/50",
};

export function gitStatusClass(kind: GitStatusKind): string {
  return KIND_CLASS[kind];
}

export function lookupGitDecoration(
  map: GitDecorationMap,
  path: string,
  isDir: boolean,
): GitStatusKind | undefined {
  const key = normalize(path);
  return isDir ? map.dirs.get(key) : map.files.get(key);
}
