import { native } from "@/modules/ai/lib/native";

export type GitHubUser = {
  login: string;
  name: string | null;
  avatarUrl: string;
};

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
};

export type CreatedRepo = {
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  htmlUrl: string;
  defaultBranch: string;
};

export type GitPushResult = {
  remote: string | null;
  branch: string | null;
  pushed: boolean;
};

function decodeBody(body: number[]): string {
  return new TextDecoder().decode(new Uint8Array(body));
}

/**
 * Backend facade for GitHub. The OAuth token never crosses into JS — it is
 * stored and used entirely on the Rust side. The frontend only ever sees the
 * connected identity and parsed API responses.
 */
export const github = {
  /** Step 1 of connect — request a device + user code. */
  deviceStart: (): Promise<DeviceCode> => native.githubDeviceStart(),

  /** Step 2 — block until the user authorizes, then persist token + identity. */
  pollToken: (
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ): Promise<GitHubUser> =>
    native.githubPollToken(deviceCode, interval, expiresIn),

  /** Connected identity, or null if not connected / token invalid. */
  status: (): Promise<GitHubUser | null> => native.githubStatus(),

  /** Forget the stored token. */
  disconnect: (): Promise<void> => native.githubDisconnect(),

  /** Create a repo under the user (or an org). */
  createRepo: (args: {
    name: string;
    private: boolean;
    org?: string | null;
    description?: string | null;
  }): Promise<CreatedRepo> => native.githubCreateRepo(args),

  /** Wire up origin and push the current branch (Publish to GitHub). */
  publish: (repoRoot: string, remoteUrl: string): Promise<GitPushResult> =>
    native.gitPublish(repoRoot, remoteUrl),

  /**
   * Authenticated GitHub REST call. `path` begins with `/` (appended to
   * https://api.github.com). Parses JSON and throws on non-2xx responses.
   */
  api: async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const encoded =
      body === undefined
        ? null
        : Array.from(new TextEncoder().encode(JSON.stringify(body)));
    const resp = await native.githubApiRequest(method, path, encoded);
    const text = decodeBody(resp.body);
    if (resp.status < 200 || resp.status >= 300) {
      let message = `GitHub API error (HTTP ${resp.status})`;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // non-JSON error body — keep the generic message
      }
      throw new Error(message);
    }
    return (text ? JSON.parse(text) : null) as T;
  },

  /**
   * GitHub GraphQL v4 call (POST /graphql) for APIs with no REST surface, e.g.
   * Projects v2. GraphQL returns HTTP 200 even on query errors, so the `errors`
   * array is checked explicitly. Throws on transport or query errors.
   */
  graphql: async <T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => {
    const resp = await github.api<{ data?: T; errors?: { message: string }[] }>(
      "POST",
      "/graphql",
      { query, variables: variables ?? {} },
    );
    if (resp.errors && resp.errors.length > 0) {
      throw new Error(resp.errors.map((e) => e.message).join("; "));
    }
    if (!resp.data) throw new Error("GitHub GraphQL returned no data.");
    return resp.data;
  },
};
