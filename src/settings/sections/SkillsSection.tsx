import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { native } from "@/modules/ai/lib/native";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Download01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/**
 * Outcome of the most recent install attempt. `idle` keeps the form clean
 * before the first click; `success` / `error` drive the result banner.
 */
type InstallResult =
  | { kind: "idle" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

export function SkillsSection() {
  const [repo, setRepo] = useState("");
  const [skill, setSkill] = useState("");
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<InstallResult>({ kind: "idle" });

  const repoTrimmed = repo.trim();
  const canInstall = !installing && repoTrimmed.length > 0;

  async function install() {
    if (!canInstall) return;
    setInstalling(true);
    setResult({ kind: "idle" });
    // The workspace dir tells the backend where the `skills/` folder lives.
    // If we can't resolve it (e.g. running standalone vite without tauri),
    // pass undefined and let the backend fall back to its own default.
    let workspace: string | undefined;
    try {
      workspace = await native.workspaceCurrentDir();
    } catch {
      workspace = undefined;
    }
    try {
      const names = await native.agentInstallSkill(
        repoTrimmed,
        workspace,
        skill.trim() || undefined,
      );
      setResult(
        names.length > 0
          ? { kind: "success", message: `Installed: ${names.join(", ")}` }
          : { kind: "error", message: "No skills found in that repository." },
      );
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Skills"
        description="Install agent skills from a GitHub repository into the current workspace's skills/ folder. Accepts owner/repo shorthand or a full GitHub URL. A running agent picks up new skills automatically — no restart needed."
      />

      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/60 p-5">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="skills-repo"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Repository
          </label>
          <Input
            id="skills-repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/repo or GitHub URL"
            disabled={installing}
            className="text-[12.5px]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="skills-name"
            className="text-[11px] font-medium text-muted-foreground"
          >
            Skill name (optional)
          </label>
          <Input
            id="skills-name"
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
            placeholder="all skills"
            disabled={installing}
            className="text-[12.5px]"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => void install()}
            disabled={!canInstall}
            className="gap-1.5"
          >
            <HugeiconsIcon icon={Download01Icon} size={12} strokeWidth={1.75} />
            {installing ? "Installing…" : "Install"}
          </Button>
        </div>

        {result.kind === "success" ? (
          <div className="flex items-start gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1.5">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              size={12}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
            <span className="text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-300">
              {result.message}
            </span>
          </div>
        ) : null}

        {result.kind === "error" ? (
          <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
            <HugeiconsIcon
              icon={Alert02Icon}
              size={12}
              strokeWidth={1.75}
              className="mt-0.5 shrink-0 text-destructive"
            />
            <span className="text-[11px] leading-relaxed text-destructive">
              {result.message}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
