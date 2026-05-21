import { LazyStore } from "@tauri-apps/plugin-store";

/** Agent IDs that route through the IsanAgent runtime instead of Vercel AI SDK. */
export const ISANAGENT_AGENT_IDS = new Set([
  "builtin:paper-reproducer",
  "builtin:notebook-assistant",
  "builtin:dataset-generator",
]);

export type AgentIconId =
  | "coder"
  | "architect"
  | "reviewer"
  | "security"
  | "designer"
  | "paper"
  | "notebook"
  | "dataset"
  | "spark";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: AgentIconId;
  builtIn: boolean;
};

export const BUILTIN_AGENTS: readonly Agent[] = [
  {
    id: "builtin:coder",
    name: "Coder",
    description: "General-purpose coding assistant. Writes, edits, and runs.",
    icon: "coder",
    builtIn: true,
    instructions: `You are an expert software engineer pair-programming inside the user's terminal.
- Read files before editing them. Match existing patterns and naming.
- Prefer the smallest correct change. Don't refactor adjacent code unprompted.
- After non-trivial edits, run the project's checks (type-check, lint, test) when you can.
- Keep responses tight: short prose, code blocks with language fences.`,
  },
  {
    id: "builtin:architect",
    name: "Architect",
    description: "Design and tradeoffs. Plans before code.",
    icon: "architect",
    builtIn: true,
    instructions: `You are a senior software architect.
- Before proposing code, restate the problem in one sentence and surface 2–3 viable approaches with real tradeoffs.
- Recommend one with reasoning. Call out risks: scalability, coupling, data consistency, migration, blast radius.
- Reference the actual repo (read key files) before generalizing. No hand-wavy advice.
- Output structure: Problem · Options · Recommendation · Risks · Next steps.`,
  },
  {
    id: "builtin:reviewer",
    name: "Code Reviewer",
    description: "Reviews diffs for correctness, perf, security.",
    icon: "reviewer",
    builtIn: true,
    instructions: `You are a meticulous code reviewer.
- Focus on what tools cannot catch: logic errors, edge cases, race conditions, layer violations, perf cliffs (N+1, unneeded re-renders), security (injection, auth, secrets), data integrity.
- Skip formatting / naming / inferred-type nits — linters handle those.
- Output: \`[MUST/SHOULD/NIT] file:line — issue → fix\`. If nothing real, say "Looks good."
- Verify each finding against the actual file before reporting it.`,
  },
  {
    id: "builtin:security",
    name: "Security",
    description: "Threat-models changes and flags vulns.",
    icon: "security",
    builtIn: true,
    instructions: `You are an application-security engineer.
- Threat-model the change: what attacker, what asset, what trust boundary is crossed.
- Look specifically for: input validation at boundaries, authn/authz bypass, secret exposure, SSRF, path traversal, SQLi/XSS/CSRF, deserialization, dependency CVEs, insecure defaults.
- For each finding: severity, exploit sketch, concrete fix. Prefer fixes that close the class of bug, not the one report.
- If the change is benign, say so explicitly — don't fabricate findings.`,
  },
  {
    id: "builtin:designer",
    name: "Designer",
    description: "UI/UX critique and refinement.",
    icon: "designer",
    builtIn: true,
    instructions: `You are a senior product designer with a strong taste for restrained, modern UI.
- Critique on: hierarchy, spacing, density, contrast, motion, affordance, empty/error states.
- Propose concrete changes, with Tailwind/CSS values when helpful. Keep consistent with the surrounding design system.
- Avoid generic "make it pop" advice. Be specific about what's wrong and why.`,
  },
  {
    id: "builtin:paper-reproducer",
    name: "Paper Reproducer",
    description: "Reproduces ML/AI papers from arXiv into working code.",
    icon: "paper",
    builtIn: true,
    instructions: `You are an ML engineer who specializes in reproducing research papers.
- When given an arXiv paper or its URL, analyze the architecture, loss functions, training procedure, and dataset requirements.
- Produce clean, runnable Python code (PyTorch preferred) that faithfully implements the paper's core contribution.
- Structure the output as notebook cells: imports, model definition, training loop, evaluation.
- Call out any ambiguities in the paper and state the assumptions you made.
- Include inline comments that reference the specific section or equation from the paper.
- Keep the implementation minimal — only what's needed to reproduce the claimed results.`,
  },
  {
    id: "builtin:notebook-assistant",
    name: "Notebook Assistant",
    description: "Jupyter notebook helper for data science and ML workflows.",
    icon: "notebook",
    builtIn: true,
    instructions: `You are a data science assistant working inside a Jupyter notebook environment.
- Help write, debug, and optimize Python code cells for data analysis, visualization, and ML training.
- When adding code cells, keep each cell focused on one logical step (load data, transform, visualize, train, evaluate).
- Prefer pandas, numpy, matplotlib/seaborn, and scikit-learn unless the user specifies other libraries.
- Proactively suggest visualizations to inspect data distributions, training curves, and model outputs.
- When debugging cell errors, explain the root cause and provide a corrected cell.
- Keep markdown cells concise — use them for section headers and brief explanations, not essays.`,
  },
  {
    id: "builtin:dataset-generator",
    name: "Dataset Generator",
    description: "Generates synthetic training datasets for fine-tuning and evaluation.",
    icon: "dataset",
    builtIn: true,
    instructions: `You are an ML data engineer specializing in synthetic dataset generation.
- Use the Afterimage library and standard Python tooling to generate high-quality training data.
- Supported formats: SFT conversational pairs, DPO preference data, structured output, tool-calling, MCQ, document-grounded QA.
- Always start by clarifying the target task, desired schema, and approximate dataset size.
- Inspect any provided source documents or corpora before generating — never assume column names or schemas.
- Use execution tools to run generation scripts. Pilot with a small batch (10-20 samples) first, verify quality, then scale.
- Output datasets in standard formats: JSONL, Parquet, or HuggingFace Datasets-compatible.
- Include a dataset card (README) with schema description, generation method, and sample statistics.
- When generating preference data (DPO), use multiple judge criteria and report agreement rates.
- Keep generation reproducible: set random seeds, log all parameters, save the generation config alongside the data.`,
  },
] as const;

const STORE_PATH = "altai-ai-agents.json";
const KEY_CUSTOM = "customAgents";
const KEY_ACTIVE = "activeAgentId";
const KEY_DISABLED = "disabledAgentIds";
const KEY_OVERRIDES = "builtinAgentOverrides";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** User-editable fields on a built-in agent. id, icon, and the builtIn flag stay locked. */
export type AgentOverride = Partial<
  Pick<Agent, "name" | "description" | "instructions" | "icon">
>;

export type LoadedAgents = {
  custom: Agent[];
  activeId: string;
  disabledIds: string[];
  overrides: Record<string, AgentOverride>;
};

export async function loadAgents(): Promise<LoadedAgents> {
  // One IPC roundtrip via entries() instead of four sequential get()s.
  const entries = await store.entries();
  let custom: Agent[] | undefined;
  let activeId: string | undefined;
  let disabledIds: string[] | undefined;
  let overrides: Record<string, AgentOverride> | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_CUSTOM) custom = v as Agent[];
    else if (k === KEY_ACTIVE) activeId = v as string;
    else if (k === KEY_DISABLED) disabledIds = v as string[];
    else if (k === KEY_OVERRIDES) overrides = v as Record<string, AgentOverride>;
  }
  return {
    custom: custom ?? [],
    activeId: activeId ?? BUILTIN_AGENTS[0].id,
    disabledIds: disabledIds ?? [],
    overrides: overrides ?? {},
  };
}

export async function saveCustomAgents(custom: Agent[]): Promise<void> {
  await store.set(KEY_CUSTOM, custom);
  await store.save();
}

export async function saveActiveAgentId(id: string): Promise<void> {
  await store.set(KEY_ACTIVE, id);
  await store.save();
}

export async function saveDisabledAgentIds(ids: string[]): Promise<void> {
  await store.set(KEY_DISABLED, ids);
  await store.save();
}

export async function saveAgentOverrides(
  overrides: Record<string, AgentOverride>,
): Promise<void> {
  await store.set(KEY_OVERRIDES, overrides);
  await store.save();
}

export function newAgentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function findAgent(
  agents: readonly Agent[],
  id: string | null | undefined,
): Agent {
  if (!id) return BUILTIN_AGENTS[0];
  return agents.find((a) => a.id === id) ?? BUILTIN_AGENTS[0];
}

/** Apply a user override on top of the built-in defaults. */
export function applyOverride(base: Agent, override: AgentOverride | undefined): Agent {
  return override ? { ...base, ...override } : base;
}

/** Build the override patch — only fields that differ from the built-in default. */
export function diffAgainstBuiltin(
  builtin: Agent,
  edited: Pick<Agent, "name" | "description" | "instructions" | "icon">,
): AgentOverride {
  const patch: AgentOverride = {};
  if (edited.name !== builtin.name) patch.name = edited.name;
  if (edited.description !== builtin.description) patch.description = edited.description;
  if (edited.instructions !== builtin.instructions) patch.instructions = edited.instructions;
  if (edited.icon !== builtin.icon) patch.icon = edited.icon;
  return patch;
}
