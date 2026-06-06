import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

export type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

export type GlobHit = { path: string; rel: string };
export type GlobResponse = { hits: GlobHit[]; truncated: boolean };

export type GitRepoInfo = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  isDetached: boolean;
};

export type GitChangedFile = {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  statusLabel: string;
};

export type GitBranch = {
  name: string;
  current: boolean;
  upstream: string | null;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  truncated: boolean;
  changedFiles: GitChangedFile[];
};

export type GitDiffResult = {
  diffText: string;
  truncated: boolean;
};

export type GitDiffContentResult = {
  originalContent: string;
  modifiedContent: string;
  isBinary: boolean;
  fallbackPatch: string;
  truncated: boolean;
};

export type GitCommitResult = {
  commitSha: string;
  summary: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

export type GitLogEntry = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  timestampSecs: number;
  parents: string[];
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
};

export type GitCommitFileChange = {
  path: string;
  originalPath: string | null;
  status: string;
  statusLabel: string;
  added: number;
  removed: number;
  isBinary: boolean;
};

export type GitPanelSnapshot = {
  repo: GitRepoInfo | null;
  status: GitStatusSnapshot | null;
};

export type GitDiscardEntry = {
  path: string;
  untracked: boolean;
};

export type GitHubUser = {
  login: string;
  name: string | null;
  avatarUrl: string;
};

export type GitHubDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
};

export type GitHubCreatedRepo = {
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  htmlUrl: string;
  defaultBranch: string;
};

export type GitHubRawHttpResponse = {
  status: number;
  headers: Record<string, string>;
  body: number[];
};

/** A pre-edit checkpoint of a file the agent mutated, for one-step undo. */
export type CheckpointInfo = {
  id: string;
  /** Absolute path of the file that was (or would be) mutated. */
  path: string;
  /** The tool that triggered the snapshot (e.g. `edit_file`). */
  label: string;
  /** Unix ms when the snapshot was taken. */
  createdMs: number;
  /** False when the file did not exist pre-edit — restoring removes it. */
  existed: boolean;
};

export const native = {
  workspaceCurrentDir: () => invoke<string>("workspace_current_dir"),
  /** Mirror the recent-folders list into the OS taskbar/Dock menu. */
  setRecentFolders: (folders: string[]) =>
    invoke<void>("set_recent_folders", { folders }),
  workspaceAuthorize: (path: string) =>
    invoke<string>("workspace_authorize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  readFile: (path: string) =>
    invoke<ReadResult>("fs_read_file", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  writeFile: (path: string, content: string) =>
    invoke<void>("fs_write_file", {
      path,
      content,
      workspace: currentWorkspaceEnv(),
    }),
  canonicalize: (path: string) =>
    invoke<string>("fs_canonicalize", {
      path,
      workspace: currentWorkspaceEnv(),
    }),
  createFile: (path: string) =>
    invoke<void>("fs_create_file", { path, workspace: currentWorkspaceEnv() }),
  createDir: (path: string) =>
    invoke<void>("fs_create_dir", { path, workspace: currentWorkspaceEnv() }),
  // AI tooling never sees dot-prefixed entries regardless of the user's
  // explorer preference — keeps .git / .env / .ssh out of agent context.
  readDir: (path: string) =>
    invoke<DirEntry[]>("fs_read_dir", {
      path,
      showHidden: false,
      workspace: currentWorkspaceEnv(),
    }),
  grep: (params: {
    pattern: string;
    root: string;
    glob?: string[];
    caseInsensitive?: boolean;
    maxResults?: number;
  }) =>
    invoke<GrepResponse>("fs_grep", {
      pattern: params.pattern,
      root: params.root,
      glob: params.glob ?? null,
      caseInsensitive: params.caseInsensitive ?? null,
      maxResults: params.maxResults ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  glob: (params: { pattern: string; root: string; maxResults?: number }) =>
    invoke<GlobResponse>("fs_glob", {
      pattern: params.pattern,
      root: params.root,
      maxResults: params.maxResults ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  runCommand: (
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<CommandOutput>("shell_run_command", {
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),

  shellSessionOpen: (cwd?: string | null) =>
    invoke<number>("shell_session_open", {
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionRun: (
    id: number,
    command: string,
    cwd?: string | null,
    timeoutSecs?: number,
  ) =>
    invoke<{
      stdout: string;
      stderr: string;
      exit_code: number | null;
      timed_out: boolean;
      truncated: boolean;
      cwd_after: string;
    }>("shell_session_run", {
      id,
      command,
      cwd: cwd ?? null,
      timeoutSecs: timeoutSecs ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellSessionClose: (id: number) =>
    invoke<void>("shell_session_close", { id }),
  shellBgSpawn: (command: string, cwd?: string | null) =>
    invoke<number>("shell_bg_spawn", {
      command,
      cwd: cwd ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  shellBgLogs: (handle: number, sinceOffset?: number) =>
    invoke<{
      bytes: string;
      next_offset: number;
      dropped: number;
      exited: boolean;
      exit_code: number | null;
    }>("shell_bg_logs", { handle, sinceOffset: sinceOffset ?? null }),
  shellBgKill: (handle: number) => invoke<void>("shell_bg_kill", { handle }),
  shellBgList: () =>
    invoke<
      {
        handle: number;
        command: string;
        cwd: string | null;
        started_at_ms: number;
        exited: boolean;
        exit_code: number | null;
      }[]
    >("shell_bg_list"),
  gitResolveRepo: (cwd: string) =>
    invoke<GitRepoInfo | null>("git_resolve_repo", {
      cwd,
      workspace: currentWorkspaceEnv(),
    }),
  gitPanelSnapshot: (cwd: string) =>
    invoke<GitPanelSnapshot>("git_panel_snapshot", {
      cwd,
      workspace: currentWorkspaceEnv(),
    }),
  gitStatus: (repoRoot: string) =>
    invoke<GitStatusSnapshot>("git_status", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiff: (repoRoot: string, path: string | null, staged: boolean) =>
    invoke<GitDiffResult>("git_diff", {
      repoRoot,
      path,
      staged,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiffContent: (
    repoRoot: string,
    path: string,
    staged: boolean,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_diff_content", {
      repoRoot,
      path,
      staged,
      originalPath: originalPath ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitStage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_stage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitUnstage: (repoRoot: string, paths: string[]) =>
    invoke<void>("git_unstage", {
      repoRoot,
      paths,
      workspace: currentWorkspaceEnv(),
    }),
  gitDiscard: (repoRoot: string, entries: GitDiscardEntry[]) =>
    invoke<void>("git_discard", {
      repoRoot,
      entries,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommit: (repoRoot: string, message: string) =>
    invoke<GitCommitResult>("git_commit", {
      repoRoot,
      message,
      workspace: currentWorkspaceEnv(),
    }),
  gitFetch: (repoRoot: string) =>
    invoke<void>("git_fetch", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitPullFfOnly: (repoRoot: string) =>
    invoke<void>("git_pull_ff_only", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitBranches: (repoRoot: string) =>
    invoke<GitBranch[]>("git_branches", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitCheckoutBranch: (repoRoot: string, name: string) =>
    invoke<void>("git_checkout_branch", {
      repoRoot,
      name,
      workspace: currentWorkspaceEnv(),
    }),
  gitCreateBranch: (repoRoot: string, name: string) =>
    invoke<void>("git_create_branch", {
      repoRoot,
      name,
      workspace: currentWorkspaceEnv(),
    }),
  gitPush: (repoRoot: string) =>
    invoke<GitPushResult>("git_push", {
      repoRoot,
      workspace: currentWorkspaceEnv(),
    }),
  gitLog: (repoRoot: string, options?: { limit?: number; beforeSha?: string }) =>
    invoke<GitLogEntry[]>("git_log", {
      repoRoot,
      limit: options?.limit ?? null,
      beforeSha: options?.beforeSha ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitShowCommit: (repoRoot: string, sha: string) =>
    invoke<GitDiffResult>("git_show_commit", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitFiles: (repoRoot: string, sha: string) =>
    invoke<GitCommitFileChange[]>("git_commit_files", {
      repoRoot,
      sha,
      workspace: currentWorkspaceEnv(),
    }),
  gitCommitFileDiff: (
    repoRoot: string,
    sha: string,
    path: string,
    originalPath?: string | null,
  ) =>
    invoke<GitDiffContentResult>("git_commit_file_diff", {
      repoRoot,
      sha,
      path,
      originalPath: originalPath ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  gitRemoteUrl: (repoRoot: string, name?: string) =>
    invoke<string | null>("git_remote_url", {
      repoRoot,
      name: name ?? null,
      workspace: currentWorkspaceEnv(),
    }),
  agentStart: (params: {
    providerName: string;
    apiKey: string;
    modelName: string;
    instructions?: string;
    baseUrl?: string;
    workspacePath?: string;
    /// "ask" | "auto-edit" | "bypass" — gates code-exec/destructive-shell in the runtime.
    permissionMode?: string;
  }) => invoke<void>("agent_start", params),
  agentSend: (
    message: string,
    images: string[] | undefined,
    chatId: string | undefined,
    // Picks/creates the runtime instance that owns this chat, so different
    // models / personas / permission-modes run concurrently without tearing
    // each other down — the Rust side keys instances by this config.
    config: {
      providerName: string;
      apiKey: string;
      modelName: string;
      instructions?: string;
      baseUrl?: string;
      workspacePath?: string;
      /// "ask" | "auto-edit" | "bypass" — gates code-exec/destructive-shell.
      permissionMode?: string;
      // Failover provider. The Rust side refreshes the process-global fallback
      // list per send (via `set_fallback_providers`) so the agent retries on
      // this model when the primary provider is exhausted. Null = failover off.
      fallback?: {
        providerName: string;
        baseUrl: string;
        apiKey: string;
        modelName: string;
      } | null;
    },
  ) =>
    invoke<void>("agent_send", {
      message,
      images,
      chatId,
      providerName: config.providerName,
      apiKey: config.apiKey,
      modelName: config.modelName,
      instructions: config.instructions,
      baseUrl: config.baseUrl,
      workspacePath: config.workspacePath,
      permissionMode: config.permissionMode,
      fallback: config.fallback ?? null,
    }),
  agentCancel: (chatId?: string) => invoke<void>("agent_cancel", { chatId }),
  agentApprove: (approvalId: string, approved: boolean) =>
    invoke<void>("agent_approve", { approvalId, approved }),
  /** List pre-edit checkpoints (newest first) for one-step undo of agent edits. */
  checkpointList: () => invoke<CheckpointInfo[]>("checkpoint_list"),
  /** Restore the file recorded by checkpoint `id` to its pre-edit state. */
  checkpointRestore: (id: string) => invoke<string>("checkpoint_restore", { id }),
  /**
   * Install agent skill(s) from a GitHub repo (`owner/repo` or full URL) into
   * the workspace's skills dir. `skill` installs just one skill from the repo.
   * Returns the installed skill names.
   */
  agentInstallSkill: (repoUrl: string, workspacePath?: string, skill?: string) =>
    invoke<string[]>("agent_install_skill", { workspacePath, repoUrl, skill }),
  gitClone: (url: string, destParent: string) =>
    invoke<string>("git_clone", { url, destParent }),
  githubDeviceStart: () => invoke<GitHubDeviceCode>("github_device_start"),
  githubPollToken: (deviceCode: string, interval: number, expiresIn: number) =>
    invoke<GitHubUser>("github_poll_token", { deviceCode, interval, expiresIn }),
  githubStatus: () => invoke<GitHubUser | null>("github_status"),
  githubDisconnect: () => invoke<void>("github_disconnect"),
  githubCreateRepo: (args: {
    name: string;
    private: boolean;
    org?: string | null;
    description?: string | null;
  }) =>
    invoke<GitHubCreatedRepo>("github_create_repo", {
      name: args.name,
      private: args.private,
      org: args.org ?? null,
      description: args.description ?? null,
    }),
  gitPublish: (repoRoot: string, remoteUrl: string) =>
    invoke<GitPushResult>("git_publish", {
      repoRoot,
      remoteUrl,
      workspace: currentWorkspaceEnv(),
    }),
  githubApiRequest: (method: string, path: string, body: number[] | null) =>
    invoke<GitHubRawHttpResponse>("github_api_request", {
      method,
      path,
      body,
    }),
};
