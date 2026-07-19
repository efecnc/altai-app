import { native } from "./native";

export const PROJECT_INSTRUCTIONS_FILE = "ALTAI.md";
const MAX_PROJECT_INSTRUCTIONS = 16_000;

export function projectInstructionsPath(workspacePath: string): string {
  return `${workspacePath.replace(/[\\/]+$/, "")}/${PROJECT_INSTRUCTIONS_FILE}`;
}

/** Read the workspace contract without making an absent file an agent error. */
export async function readProjectInstructions(
  workspacePath: string | undefined,
): Promise<string | undefined> {
  if (!workspacePath) return undefined;
  try {
    const result = await native.readFile(projectInstructionsPath(workspacePath));
    if (result.kind !== "text") return undefined;
    const text = result.content.trim();
    return text ? text.slice(0, MAX_PROJECT_INSTRUCTIONS) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * IsanAgent receives one persona string at runtime creation. Put project
 * rules ahead of the selected persona so both survive per-session isolation.
 */
export function combineAgentInstructions(
  agentInstructions: string | undefined,
  projectInstructions: string | undefined,
): string | undefined {
  const sections = [
    projectInstructions
      ? `<project-instructions source="${PROJECT_INSTRUCTIONS_FILE}">\n${projectInstructions}\n</project-instructions>`
      : "",
    agentInstructions ?? "",
  ].filter(Boolean);
  return sections.length ? sections.join("\n\n") : undefined;
}
