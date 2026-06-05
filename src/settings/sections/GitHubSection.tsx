import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useGitHubStore } from "@/modules/github";
import {
  CheckmarkCircle02Icon,
  GithubIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const VERIFICATION_FALLBACK = "https://github.com/login/device";

export function GitHubSection() {
  const {
    connection,
    state,
    userCode,
    verificationUri,
    error,
    refresh,
    connect,
    cancel,
    disconnect,
  } = useGitHubStore();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copyCode = async () => {
    if (!userCode) return;
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — the code is shown on screen anyway
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="GitHub"
        description="Connect your GitHub account to push and pull private repositories, publish new repos, and browse pull requests and issues — all from inside ALTAI."
      />

      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <HugeiconsIcon icon={GithubIcon} size={16} strokeWidth={1.75} />
          <span className="text-[12.5px] font-medium">GitHub Account</span>
          {connection ? (
            <Badge
              variant="outline"
              className="ml-1 h-4 gap-1 border-emerald-500/40 bg-emerald-500/10 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-300"
            >
              <HugeiconsIcon icon={CheckmarkCircle02Icon} size={9} strokeWidth={2} />
              Connected
            </Badge>
          ) : null}
        </div>

        {/* Connected */}
        {state === "connected" && connection ? (
          <div className="flex items-center gap-3 pt-1">
            <img
              src={connection.avatarUrl}
              alt=""
              className="h-9 w-9 rounded-full border border-border/60"
            />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium">
                {connection.name ?? connection.login}
              </span>
              <button
                type="button"
                onClick={() => void openUrl(`https://github.com/${connection.login}`)}
                className="truncate text-left text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
              >
                @{connection.login}
              </button>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 text-[11.5px]"
              onClick={() => void disconnect()}
            >
              Disconnect
            </Button>
          </div>
        ) : null}

        {/* Waiting for device authorization */}
        {state === "waiting" ? (
          <div className="flex flex-col gap-2 pt-1">
            <p className="text-[12px] text-muted-foreground">
              Enter this code at{" "}
              <button
                type="button"
                onClick={() => void openUrl(verificationUri ?? VERIFICATION_FALLBACK)}
                className="text-foreground underline underline-offset-2"
              >
                {(verificationUri ?? VERIFICATION_FALLBACK).replace("https://", "")}
              </button>{" "}
              to finish connecting.
            </p>
            <div className="flex items-center gap-2">
              <code className="select-all rounded-md border border-border/60 bg-muted/40 px-3 py-1.5 font-mono text-[16px] tracking-[0.2em]">
                {userCode}
              </code>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11.5px]"
                onClick={() => void copyCode()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <Spinner className="size-3.5" />
                <span className="text-[11.5px] text-muted-foreground">
                  Waiting for authorization…
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11.5px]"
                onClick={() => void openUrl(verificationUri ?? VERIFICATION_FALLBACK)}
              >
                Open GitHub
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[11.5px]"
                onClick={cancel}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {/* Disconnected / idle / error */}
        {state === "idle" || state === "loading" || state === "error" ? (
          <div className="flex flex-col gap-2 pt-1">
            <p className="text-[12px] text-muted-foreground">
              You are not connected. Connecting opens GitHub so you can authorize
              ALTAI with a short device code.
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 gap-1.5 text-[11.5px]"
                disabled={state === "loading"}
                onClick={() => void connect()}
              >
                {state === "loading" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <HugeiconsIcon icon={GithubIcon} size={13} strokeWidth={1.75} />
                )}
                {state === "loading" ? "Checking…" : "Connect to GitHub"}
              </Button>
            </div>
            {error ? (
              <p className="text-[11.5px] text-red-600 dark:text-red-400">{error}</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
