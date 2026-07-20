import {
  DEFAULT_AUTOCOMPLETE_MODEL,
  DEFAULT_MODEL_ID,
  LMSTUDIO_DEFAULT_BASE_URL,
  MLX_DEFAULT_BASE_URL,
  OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  type AutocompleteProviderId,
  type ModelId,
} from "@/modules/ai/config";
import type { KeyBinding, ShortcutId } from "@/modules/shortcuts/shortcuts";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

export type ThemePref = "system" | "light" | "dark";

/** Canonical, ordered list of permission modes. The single source of truth —
 *  the `PermissionMode` union, the `Record<PermissionMode,…>` label/desc maps,
 *  and the zod schema in `github/lib/assignments.ts` all derive from this so
 *  a new mode lands in every site at once instead of being hand-copied. */
export const PERMISSION_MODES = [
  "ask",
  "auto-edit",
  "plan",
  "bypass",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The permission mode actually in effect for read-side consumers: a stale `"bypass"` selection
 * falls back to `"ask"` when bypass is not enabled in Settings, so it can never silently disable
 * the gate. Single source of truth for this safety invariant — used by the switcher label and the
 * send-flow runtime wiring so the rule can't drift between them.
 */
export function effectivePermissionMode(
  mode: PermissionMode,
  bypassEnabled: boolean,
): PermissionMode {
  return mode === "bypass" && !bypassEnabled ? "ask" : mode;
}

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  ask: "Ask before edit",
  "auto-edit": "Edit automatically",
  plan: "Plan mode",
  bypass: "Bypass permissions",
};

/** Override for the OS `prefers-reduced-motion` query. */
export type ReduceMotionPref = "system" | "always" | "never";

export const REDUCE_MOTION_LABELS: Record<ReduceMotionPref, string> = {
  system: "Follow system",
  always: "Always reduce",
  never: "Never reduce",
};

/** Stronger UI focus rings for keyboard users. */
export type FocusRingPref = "default" | "strong";

export const FOCUS_RING_LABELS: Record<FocusRingPref, string> = {
  default: "Default (2 px)",
  strong: "Strong (4 px, high contrast)",
};

/** Screen reader announcement policy for streaming chat messages. */
export type ChatAnnouncePref = "off" | "polite" | "assertive";

export const CHAT_ANNOUNCE_LABELS: Record<ChatAnnouncePref, string> = {
  off: "Off",
  polite: "Polite (default)",
  assertive: "Assertive",
};

export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  ask: "Approve every file edit, write, and shell command before it runs.",
  "auto-edit":
    "Auto-approve file edits and writes. Shell commands still require approval.",
  plan: "Read-only: the agent can explore, search, and plan, but cannot edit files. Shell commands still require approval.",
  bypass:
    "Auto-approve everything, including shell commands. Use only in sandboxed environments.",
};

/**
 * Context-condensing (compaction) preferences. Maps to the isanagent
 * engine's knobs where possible; the prune recency window is TS-side only.
 * Mirrors https://kilo.ai/docs/customize/context/context-condensing.
 */
export type CompactionPrefs = {
  /** Master switch for the auto-compaction engine. */
  compactionAuto: boolean;
  /** Optional auto-compact threshold as a % of the model's context window.
   *  When set, takes precedence over `compactionThresholdTokens`. */
  compactionThresholdPercent: number | null;
  /** Auto-compact threshold in tokens (used when percent is unset). */
  compactionThresholdTokens: number;
  /** Number of most-recent turns kept verbatim after a compaction
   *  (isanagent's `max_recent_summaries`). */
  compactionTailTurns: number;
  /** Gate the TS-side prune pass that collapses old tool outputs in the
   *  displayed/persisted transcript (display-only; doesn't touch the
   *  model's own context). */
  compactionPrune: boolean;
  /** Recency window (tokens) the TS-side prune keeps verbatim. */
  compactionPruneRecencyTokens: number;
};

export type Preferences = {
  theme: ThemePref;
  defaultModelId: ModelId;
  customInstructions: string;
  autostart: boolean;
  restoreWindowState: boolean;
  autocompleteEnabled: boolean;
  autocompleteProvider: AutocompleteProviderId;
  autocompleteModelId: string;
  /** Model the agent falls back to when the primary provider is exhausted.
   *  Empty = no failover. Activated once the isanagent crate ships re-settable
   *  fallback providers (PR altaidevorg/isanagent#57). */
  fallbackModelId: string;
  lmstudioBaseURL: string;
  lmstudioModelId: string;
  mlxBaseURL: string;
  mlxModelId: string;
  openaiCompatibleBaseURL: string;
  openaiCompatibleModelId: string;
  openaiCompatibleContextLimit: number;
  favoriteModelIds: string[];
  recentModelIds: string[];
  hiddenModelIds: string[];
  vimMode: boolean;
  minimapEnabled: boolean;
  /** User template the AI follows when generating commit messages. Empty = Conventional Commits. */
  commitMessageTemplate: string;
  showHidden: boolean;
  terminalWebglEnabled: boolean;
  terminalFontFamily: string;
  terminalLetterSpacing: number;
  terminalFontSize: number;
  terminalScrollback: number;
  lastWslDistro: string | null;
  zoomLevel: number;
  shortcuts: Record<ShortcutId, KeyBinding[]>;
  permissionMode: PermissionMode;
  bypassPermissionsEnabled: boolean;
  agentPickerEnabled: boolean;
  // Accessibility
  reduceMotion: ReduceMotionPref;
  highContrast: boolean;
  largerText: boolean;
  underlineLinks: boolean;
  focusRing: FocusRingPref;
  chatAnnounce: ChatAnnouncePref;
  approvalAnnounceAssertive: boolean;
  terminalScreenReader: boolean;
  showSkipLinks: boolean;
  // Context condensing (compaction)
  compactionAuto: boolean;
  compactionThresholdPercent: number | null;
  compactionThresholdTokens: number;
  compactionTailTurns: number;
  compactionPrune: boolean;
  compactionPruneRecencyTokens: number;
};

const STORE_PATH = "altai-settings.json";
const KEY_THEME = "theme";
const KEY_DEFAULT_MODEL = "defaultModelId";
const KEY_CUSTOM_INSTRUCTIONS = "customInstructions";
const KEY_AUTOSTART = "autostart";
const KEY_RESTORE_WINDOW = "restoreWindowState";
const KEY_AUTOCOMPLETE_ENABLED = "autocompleteEnabled";
const KEY_AUTOCOMPLETE_PROVIDER = "autocompleteProvider";
const KEY_AUTOCOMPLETE_MODEL = "autocompleteModelId";
const KEY_FALLBACK_MODEL = "fallbackModelId";
const KEY_LMSTUDIO_BASE_URL = "lmstudioBaseURL";
const KEY_LMSTUDIO_MODEL_ID = "lmstudioModelId";
const KEY_MLX_BASE_URL = "mlxBaseURL";
const KEY_MLX_MODEL_ID = "mlxModelId";
const KEY_OPENAI_COMPAT_BASE_URL = "openaiCompatibleBaseURL";
const KEY_OPENAI_COMPAT_MODEL_ID = "openaiCompatibleModelId";
const KEY_OPENAI_COMPAT_CONTEXT_LIMIT = "openaiCompatibleContextLimit";
const KEY_FAVORITE_MODELS = "favoriteModelIds";
const KEY_RECENT_MODELS = "recentModelIds";
const KEY_HIDDEN_MODELS = "hiddenModelIds";
const KEY_VIM_MODE = "vimMode";
const KEY_MINIMAP = "minimapEnabled";
const KEY_COMMIT_TEMPLATE = "commitMessageTemplate";
const KEY_SHOW_HIDDEN = "showHidden";
const LEGACY_KEY_SHOW_HIDDEN_DIRS = "showHiddenDirectories";
const KEY_TERMINAL_WEBGL_ENABLED = "terminalWebglEnabled";
const KEY_TERMINAL_FONT_FAMILY = "terminalFontFamily";
const KEY_TERMINAL_LETTER_SPACING = "terminalLetterSpacing";
const KEY_TERMINAL_FONT_SIZE = "terminalFontSize";
const KEY_TERMINAL_SCROLLBACK = "terminalScrollback";
const KEY_LAST_WSL_DISTRO = "lastWslDistro";
const KEY_ZOOM_LEVEL = "zoomLevel";
const KEY_SHORTCUTS = "shortcuts";
const KEY_PERMISSION_MODE = "permissionMode";
const KEY_BYPASS_PERMISSIONS_ENABLED = "bypassPermissionsEnabled";
const KEY_AGENT_PICKER_ENABLED = "agentPickerEnabled";
const KEY_A11Y_REDUCE_MOTION = "a11yReduceMotion";
const KEY_A11Y_HIGH_CONTRAST = "a11yHighContrast";
const KEY_A11Y_LARGER_TEXT = "a11yLargerText";
const KEY_A11Y_UNDERLINE_LINKS = "a11yUnderlineLinks";
const KEY_A11Y_FOCUS_RING = "a11yFocusRing";
const KEY_A11Y_CHAT_ANNOUNCE = "a11yChatAnnounce";
const KEY_A11Y_APPROVAL_ASSERTIVE = "a11yApprovalAnnounceAssertive";
const KEY_A11Y_TERMINAL_SR = "a11yTerminalScreenReader";
const KEY_A11Y_SKIP_LINKS = "a11yShowSkipLinks";
const KEY_COMPACTION_AUTO = "compactionAuto";
const KEY_COMPACTION_THRESHOLD_PERCENT = "compactionThresholdPercent";
const KEY_COMPACTION_THRESHOLD_TOKENS = "compactionThresholdTokens";
const KEY_COMPACTION_TAIL_TURNS = "compactionTailTurns";
const KEY_COMPACTION_PRUNE = "compactionPrune";
const KEY_COMPACTION_PRUNE_RECENCY_TOKENS = "compactionPruneRecencyTokens";

export const TERMINAL_FONT_SIZE_DEFAULT = 14;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

export const TERMINAL_FONT_SIZES = [
  10, 12, 13, 14, 15, 16, 18, 20, 22, 24,
] as const;

export const TERMINAL_SCROLLBACK_DEFAULT = 2000;
export const TERMINAL_SCROLLBACK_MIN = 200;
export const TERMINAL_SCROLLBACK_MAX = 50_000;
export const TERMINAL_SCROLLBACK_PRESETS = [
  500, 1000, 2000, 5000, 10_000, 25_000,
] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  defaultModelId: DEFAULT_MODEL_ID,
  customInstructions: "",
  autostart: false,
  restoreWindowState: true,
  autocompleteEnabled: false,
  autocompleteProvider: "cerebras",
  autocompleteModelId: DEFAULT_AUTOCOMPLETE_MODEL.cerebras ?? "",
  fallbackModelId: "",
  lmstudioBaseURL: LMSTUDIO_DEFAULT_BASE_URL,
  lmstudioModelId: "",
  mlxBaseURL: MLX_DEFAULT_BASE_URL,
  mlxModelId: "",
  openaiCompatibleBaseURL: OPENAI_COMPATIBLE_DEFAULT_BASE_URL,
  openaiCompatibleModelId: "",
  openaiCompatibleContextLimit: 128_000,
  favoriteModelIds: [],
  recentModelIds: [],
  hiddenModelIds: [],
  vimMode: false,
  minimapEnabled: true,
  commitMessageTemplate: "",
  showHidden: true,
  terminalWebglEnabled: true,
  terminalFontFamily: "",
  terminalLetterSpacing: 0,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,
  lastWslDistro: null,
  zoomLevel: 1.0,
  shortcuts: {} as Record<ShortcutId, KeyBinding[]>,
  permissionMode: "ask",
  bypassPermissionsEnabled: false,
  agentPickerEnabled: true,
  // Accessibility defaults.
  reduceMotion: "system",
  highContrast: false,
  largerText: false,
  underlineLinks: false,
  focusRing: "default",
  chatAnnounce: "polite",
  approvalAnnounceAssertive: true,
  terminalScreenReader: true,
  showSkipLinks: false,
  // Context-condensing defaults (mirror the isanagent crate's built-ins).
  compactionAuto: true,
  compactionThresholdPercent: null,
  compactionThresholdTokens: 100_000,
  compactionTailTurns: 5,
  compactionPrune: true,
  compactionPruneRecencyTokens: 40_000,
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

// LazyStore.onChange only fires within the writing process. The settings
// page lives in a separate webview, so writes there never reach the main
// window's subscribers. Mirror every setter through a Tauri event so any
// window can listen.
const PREFS_CHANGED_EVENT = "altai://prefs-changed";

async function writePref<T>(key: string, value: T): Promise<void> {
  await store.set(key, value);
  await store.save();
  await emit(PREFS_CHANGED_EVENT, { key, value });
}

/** Read an env-var boolean flag from the Rust process. Best-effort: returns
 *  `false` when the IPC layer is unavailable (e.g. outside Tauri / unit
 *  tests) so callers can treat env overrides as opt-in only. */
async function readEnvFlag(name: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("env_get_flag", { name });
  } catch {
    return false;
  }
}

export async function loadPreferences(): Promise<Preferences> {
  // Single IPC roundtrip — fetching keys individually fans out to one
  // `plugin:store|get` per setting and is the dominant boot cost.
  const entries = await store.entries();
  const map = new Map<string, unknown>(entries);
  const get = <T>(k: string): T | undefined => map.get(k) as T | undefined;

  // Env overrides (Kilo parity). Read once at boot; the user's saved pref is
  // ignored when the corresponding env var forces a value.
  const [disableAutoCompact, disablePrune] = await Promise.all([
    readEnvFlag("ALTAI_DISABLE_AUTOCOMPACT"),
    readEnvFlag("ALTAI_DISABLE_PRUNE"),
  ]);

  return {
    theme: get<ThemePref>(KEY_THEME) ?? DEFAULT_PREFERENCES.theme,
    defaultModelId:
      get<ModelId>(KEY_DEFAULT_MODEL) ?? DEFAULT_PREFERENCES.defaultModelId,
    customInstructions:
      get<string>(KEY_CUSTOM_INSTRUCTIONS) ??
      DEFAULT_PREFERENCES.customInstructions,
    autostart: get<boolean>(KEY_AUTOSTART) ?? DEFAULT_PREFERENCES.autostart,
    restoreWindowState:
      get<boolean>(KEY_RESTORE_WINDOW) ??
      DEFAULT_PREFERENCES.restoreWindowState,
    autocompleteEnabled:
      get<boolean>(KEY_AUTOCOMPLETE_ENABLED) ??
      DEFAULT_PREFERENCES.autocompleteEnabled,
    autocompleteProvider:
      get<AutocompleteProviderId>(KEY_AUTOCOMPLETE_PROVIDER) ??
      DEFAULT_PREFERENCES.autocompleteProvider,
    autocompleteModelId:
      get<string>(KEY_AUTOCOMPLETE_MODEL) ??
      DEFAULT_PREFERENCES.autocompleteModelId,
    fallbackModelId:
      get<string>(KEY_FALLBACK_MODEL) ?? DEFAULT_PREFERENCES.fallbackModelId,
    lmstudioBaseURL:
      get<string>(KEY_LMSTUDIO_BASE_URL) ?? DEFAULT_PREFERENCES.lmstudioBaseURL,
    lmstudioModelId:
      get<string>(KEY_LMSTUDIO_MODEL_ID) ?? DEFAULT_PREFERENCES.lmstudioModelId,
    mlxBaseURL:
      get<string>(KEY_MLX_BASE_URL) ?? DEFAULT_PREFERENCES.mlxBaseURL,
    mlxModelId:
      get<string>(KEY_MLX_MODEL_ID) ?? DEFAULT_PREFERENCES.mlxModelId,
    openaiCompatibleBaseURL:
      get<string>(KEY_OPENAI_COMPAT_BASE_URL) ??
      DEFAULT_PREFERENCES.openaiCompatibleBaseURL,
    openaiCompatibleModelId:
      get<string>(KEY_OPENAI_COMPAT_MODEL_ID) ??
      DEFAULT_PREFERENCES.openaiCompatibleModelId,
    openaiCompatibleContextLimit:
      get<number>(KEY_OPENAI_COMPAT_CONTEXT_LIMIT) ??
      DEFAULT_PREFERENCES.openaiCompatibleContextLimit,
    favoriteModelIds:
      get<string[]>(KEY_FAVORITE_MODELS) ??
      DEFAULT_PREFERENCES.favoriteModelIds,
    recentModelIds:
      get<string[]>(KEY_RECENT_MODELS) ?? DEFAULT_PREFERENCES.recentModelIds,
    hiddenModelIds:
      get<string[]>(KEY_HIDDEN_MODELS) ?? DEFAULT_PREFERENCES.hiddenModelIds,
    vimMode: get<boolean>(KEY_VIM_MODE) ?? DEFAULT_PREFERENCES.vimMode,
    minimapEnabled:
      get<boolean>(KEY_MINIMAP) ?? DEFAULT_PREFERENCES.minimapEnabled,
    commitMessageTemplate:
      get<string>(KEY_COMMIT_TEMPLATE) ??
      DEFAULT_PREFERENCES.commitMessageTemplate,
    showHidden:
      get<boolean>(KEY_SHOW_HIDDEN) ??
      get<boolean>(LEGACY_KEY_SHOW_HIDDEN_DIRS) ??
      DEFAULT_PREFERENCES.showHidden,
    terminalWebglEnabled:
      get<boolean>(KEY_TERMINAL_WEBGL_ENABLED) ??
      DEFAULT_PREFERENCES.terminalWebglEnabled,
    terminalFontFamily:
      get<string>(KEY_TERMINAL_FONT_FAMILY) ??
      DEFAULT_PREFERENCES.terminalFontFamily,
    terminalLetterSpacing:
      get<number>(KEY_TERMINAL_LETTER_SPACING) ??
      DEFAULT_PREFERENCES.terminalLetterSpacing,
    terminalFontSize:
      get<number>(KEY_TERMINAL_FONT_SIZE) ??
      DEFAULT_PREFERENCES.terminalFontSize,
    terminalScrollback: clampScrollback(
      get<number>(KEY_TERMINAL_SCROLLBACK) ??
        DEFAULT_PREFERENCES.terminalScrollback,
    ),
    lastWslDistro:
      get<string | null>(KEY_LAST_WSL_DISTRO) ??
      DEFAULT_PREFERENCES.lastWslDistro,
    zoomLevel: get<number>(KEY_ZOOM_LEVEL) ?? DEFAULT_PREFERENCES.zoomLevel,
    shortcuts:
      get<Record<ShortcutId, KeyBinding[]>>(KEY_SHORTCUTS) ??
      DEFAULT_PREFERENCES.shortcuts,
    permissionMode:
      get<PermissionMode>(KEY_PERMISSION_MODE) ??
      DEFAULT_PREFERENCES.permissionMode,
    bypassPermissionsEnabled:
      get<boolean>(KEY_BYPASS_PERMISSIONS_ENABLED) ??
      DEFAULT_PREFERENCES.bypassPermissionsEnabled,
    agentPickerEnabled:
      get<boolean>(KEY_AGENT_PICKER_ENABLED) ??
      DEFAULT_PREFERENCES.agentPickerEnabled,
    reduceMotion:
      get<ReduceMotionPref>(KEY_A11Y_REDUCE_MOTION) ??
      DEFAULT_PREFERENCES.reduceMotion,
    highContrast:
      get<boolean>(KEY_A11Y_HIGH_CONTRAST) ??
      DEFAULT_PREFERENCES.highContrast,
    largerText:
      get<boolean>(KEY_A11Y_LARGER_TEXT) ?? DEFAULT_PREFERENCES.largerText,
    underlineLinks:
      get<boolean>(KEY_A11Y_UNDERLINE_LINKS) ??
      DEFAULT_PREFERENCES.underlineLinks,
    focusRing:
      get<FocusRingPref>(KEY_A11Y_FOCUS_RING) ??
      DEFAULT_PREFERENCES.focusRing,
    chatAnnounce:
      get<ChatAnnouncePref>(KEY_A11Y_CHAT_ANNOUNCE) ??
      DEFAULT_PREFERENCES.chatAnnounce,
    approvalAnnounceAssertive:
      get<boolean>(KEY_A11Y_APPROVAL_ASSERTIVE) ??
      DEFAULT_PREFERENCES.approvalAnnounceAssertive,
    terminalScreenReader:
      get<boolean>(KEY_A11Y_TERMINAL_SR) ??
      DEFAULT_PREFERENCES.terminalScreenReader,
    showSkipLinks:
      get<boolean>(KEY_A11Y_SKIP_LINKS) ??
      DEFAULT_PREFERENCES.showSkipLinks,
    compactionAuto: disableAutoCompact
      ? false
      : (get<boolean>(KEY_COMPACTION_AUTO) ?? DEFAULT_PREFERENCES.compactionAuto),
    compactionThresholdPercent:
      get<number | null>(KEY_COMPACTION_THRESHOLD_PERCENT) ??
      DEFAULT_PREFERENCES.compactionThresholdPercent,
    compactionThresholdTokens:
      get<number>(KEY_COMPACTION_THRESHOLD_TOKENS) ??
      DEFAULT_PREFERENCES.compactionThresholdTokens,
    compactionTailTurns:
      get<number>(KEY_COMPACTION_TAIL_TURNS) ??
      DEFAULT_PREFERENCES.compactionTailTurns,
    compactionPrune: disablePrune
      ? false
      : (get<boolean>(KEY_COMPACTION_PRUNE) ?? DEFAULT_PREFERENCES.compactionPrune),
    compactionPruneRecencyTokens:
      get<number>(KEY_COMPACTION_PRUNE_RECENCY_TOKENS) ??
      DEFAULT_PREFERENCES.compactionPruneRecencyTokens,
  };
}

export async function setTheme(value: ThemePref): Promise<void> {
  await writePref(KEY_THEME, value);
}

export async function setDefaultModel(value: ModelId): Promise<void> {
  await writePref(KEY_DEFAULT_MODEL, value);
}

export async function setCustomInstructions(value: string): Promise<void> {
  await writePref(KEY_CUSTOM_INSTRUCTIONS, value);
}

export async function setAutostart(value: boolean): Promise<void> {
  await writePref(KEY_AUTOSTART, value);
}

export async function setRestoreWindowState(value: boolean): Promise<void> {
  await writePref(KEY_RESTORE_WINDOW, value);
}

export async function setAutocompleteEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_ENABLED, value);
}

export async function setAutocompleteProvider(
  value: AutocompleteProviderId,
): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_PROVIDER, value);
}

export async function setAutocompleteModelId(value: string): Promise<void> {
  await writePref(KEY_AUTOCOMPLETE_MODEL, value);
}

export async function setFallbackModelId(value: string): Promise<void> {
  await writePref(KEY_FALLBACK_MODEL, value);
}

export async function setLmstudioBaseURL(value: string): Promise<void> {
  await writePref(KEY_LMSTUDIO_BASE_URL, value);
}

export async function setLmstudioModelId(value: string): Promise<void> {
  await writePref(KEY_LMSTUDIO_MODEL_ID, value);
}

export async function setMlxBaseURL(value: string): Promise<void> {
  await writePref(KEY_MLX_BASE_URL, value);
}

export async function setMlxModelId(value: string): Promise<void> {
  await writePref(KEY_MLX_MODEL_ID, value);
}

export async function setOpenaiCompatibleBaseURL(value: string): Promise<void> {
  await writePref(KEY_OPENAI_COMPAT_BASE_URL, value);
}

export async function setOpenaiCompatibleModelId(value: string): Promise<void> {
  await writePref(KEY_OPENAI_COMPAT_MODEL_ID, value);
}

export async function setOpenaiCompatibleContextLimit(
  value: number,
): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(1_000, Math.round(value))
    : DEFAULT_PREFERENCES.openaiCompatibleContextLimit;
  await writePref(KEY_OPENAI_COMPAT_CONTEXT_LIMIT, clamped);
}

export async function setFavoriteModelIds(value: string[]): Promise<void> {
  await writePref(KEY_FAVORITE_MODELS, value);
}

export async function setRecentModelIds(value: string[]): Promise<void> {
  await writePref(KEY_RECENT_MODELS, value);
}

export async function setHiddenModelIds(value: string[]): Promise<void> {
  await writePref(KEY_HIDDEN_MODELS, value);
}

export async function setVimMode(value: boolean): Promise<void> {
  await writePref(KEY_VIM_MODE, value);
}

export async function setMinimapEnabled(value: boolean): Promise<void> {
  await writePref(KEY_MINIMAP, value);
}

export async function setCommitMessageTemplate(value: string): Promise<void> {
  await writePref(KEY_COMMIT_TEMPLATE, value);
}

export async function setShowHidden(value: boolean): Promise<void> {
  await writePref(KEY_SHOW_HIDDEN, value);
}

export async function setTerminalWebglEnabled(value: boolean): Promise<void> {
  await writePref(KEY_TERMINAL_WEBGL_ENABLED, value);
}

export async function setTerminalFontFamily(value: string): Promise<void> {
  await writePref(KEY_TERMINAL_FONT_FAMILY, value.trim());
}

export async function setTerminalLetterSpacing(value: number): Promise<void> {
  const clamped = Number.isFinite(value) ? Math.max(-10, Math.min(10, Math.round(value))) : 0;
  await writePref(KEY_TERMINAL_LETTER_SPACING, clamped);
}

export async function setTerminalFontSize(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)),
      )
    : TERMINAL_FONT_SIZE_DEFAULT;
  await writePref(KEY_TERMINAL_FONT_SIZE, clamped);
}

function clampScrollback(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(value)),
  );
}

export async function setTerminalScrollback(value: number): Promise<void> {
  await writePref(KEY_TERMINAL_SCROLLBACK, clampScrollback(value));
}

export async function setLastWslDistro(value: string | null): Promise<void> {
  await writePref(KEY_LAST_WSL_DISTRO, value);
}

export async function setZoomLevel(value: number): Promise<void> {
  await writePref(KEY_ZOOM_LEVEL, value);
}

export async function setShortcuts(
  value: Record<ShortcutId, KeyBinding[]> | {},
): Promise<void> {
  await store.set(KEY_SHORTCUTS, value);
  await store.save();
}

export async function resetShortcuts(): Promise<void> {
  await store.set(KEY_SHORTCUTS, DEFAULT_PREFERENCES.shortcuts);
  await store.save();
}

export async function setPermissionMode(value: PermissionMode): Promise<void> {
  await writePref(KEY_PERMISSION_MODE, value);
}

/**
 * Cascading setter: turning the gate off also downgrades the active
 * `permissionMode` from "bypass" → "ask". The other setters in this file are
 * straight write-throughs; do not copy this pattern unless your pref has a
 * similar safety-critical dependency.
 */
export async function setBypassPermissionsEnabled(
  value: boolean,
): Promise<void> {
  await writePref(KEY_BYPASS_PERMISSIONS_ENABLED, value);
  if (!value) {
    const current = await store.get<PermissionMode>(KEY_PERMISSION_MODE);
    if (current === "bypass") {
      await writePref(KEY_PERMISSION_MODE, "ask");
    }
  }
}

export async function setAgentPickerEnabled(value: boolean): Promise<void> {
  await writePref(KEY_AGENT_PICKER_ENABLED, value);
}

// --- Accessibility setters ---

export async function setReduceMotion(value: ReduceMotionPref): Promise<void> {
  await writePref(KEY_A11Y_REDUCE_MOTION, value);
}

export async function setHighContrast(value: boolean): Promise<void> {
  await writePref(KEY_A11Y_HIGH_CONTRAST, value);
}

export async function setLargerText(value: boolean): Promise<void> {
  await writePref(KEY_A11Y_LARGER_TEXT, value);
}

export async function setUnderlineLinks(value: boolean): Promise<void> {
  await writePref(KEY_A11Y_UNDERLINE_LINKS, value);
}

export async function setFocusRing(value: FocusRingPref): Promise<void> {
  await writePref(KEY_A11Y_FOCUS_RING, value);
}

export async function setChatAnnounce(value: ChatAnnouncePref): Promise<void> {
  await writePref(KEY_A11Y_CHAT_ANNOUNCE, value);
}

export async function setApprovalAnnounceAssertive(
  value: boolean,
): Promise<void> {
  await writePref(KEY_A11Y_APPROVAL_ASSERTIVE, value);
}

export async function setTerminalScreenReader(value: boolean): Promise<void> {
  await writePref(KEY_A11Y_TERMINAL_SR, value);
}

export async function setShowSkipLinks(value: boolean): Promise<void> {
  await writePref(KEY_A11Y_SKIP_LINKS, value);
}

// --- Context-condensing (compaction) setters ---

export async function setCompactionAuto(value: boolean): Promise<void> {
  await writePref(KEY_COMPACTION_AUTO, value);
}

export async function setCompactionThresholdPercent(
  value: number | null,
): Promise<void> {
  const sanitized =
    value == null || !Number.isFinite(value)
      ? null
      : Math.max(1, Math.min(100, Math.round(value)));
  await writePref(KEY_COMPACTION_THRESHOLD_PERCENT, sanitized);
}

export async function setCompactionThresholdTokens(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(1_000, Math.round(value))
    : DEFAULT_PREFERENCES.compactionThresholdTokens;
  await writePref(KEY_COMPACTION_THRESHOLD_TOKENS, clamped);
}

export async function setCompactionTailTurns(value: number): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(0, Math.min(50, Math.round(value)))
    : DEFAULT_PREFERENCES.compactionTailTurns;
  await writePref(KEY_COMPACTION_TAIL_TURNS, clamped);
}

export async function setCompactionPrune(value: boolean): Promise<void> {
  await writePref(KEY_COMPACTION_PRUNE, value);
}

export async function setCompactionPruneRecencyTokens(
  value: number,
): Promise<void> {
  const clamped = Number.isFinite(value)
    ? Math.max(1_000, Math.round(value))
    : DEFAULT_PREFERENCES.compactionPruneRecencyTokens;
  await writePref(KEY_COMPACTION_PRUNE_RECENCY_TOKENS, clamped);
}

/** Reset all accessibility prefs to defaults.
 *  Writes every key in memory first, then saves once and broadcasts each
 *  change — avoids the 9× serialized write that calling each setter would
 *  produce. */
export async function resetAccessibility(): Promise<void> {
  const updates: Array<[string, unknown]> = [
    [KEY_A11Y_REDUCE_MOTION, DEFAULT_PREFERENCES.reduceMotion],
    [KEY_A11Y_HIGH_CONTRAST, DEFAULT_PREFERENCES.highContrast],
    [KEY_A11Y_LARGER_TEXT, DEFAULT_PREFERENCES.largerText],
    [KEY_A11Y_UNDERLINE_LINKS, DEFAULT_PREFERENCES.underlineLinks],
    [KEY_A11Y_FOCUS_RING, DEFAULT_PREFERENCES.focusRing],
    [KEY_A11Y_CHAT_ANNOUNCE, DEFAULT_PREFERENCES.chatAnnounce],
    [KEY_A11Y_APPROVAL_ASSERTIVE, DEFAULT_PREFERENCES.approvalAnnounceAssertive],
    [KEY_A11Y_TERMINAL_SR, DEFAULT_PREFERENCES.terminalScreenReader],
    [KEY_A11Y_SKIP_LINKS, DEFAULT_PREFERENCES.showSkipLinks],
  ];
  await Promise.all(updates.map(([key, value]) => store.set(key, value)));
  await store.save();
  await Promise.all(
    updates.map(([key, value]) =>
      emit(PREFS_CHANGED_EVENT, { key, value }),
    ),
  );
}

export type PrefKey = keyof Preferences;

/** Subscribe to changes from any window (settings → main). */
export async function onPreferencesChange(
  cb: (key: PrefKey, value: unknown) => void,
): Promise<UnlistenFn> {
  const map: Record<string, PrefKey> = {
    [KEY_THEME]: "theme",
    [KEY_DEFAULT_MODEL]: "defaultModelId",
    [KEY_CUSTOM_INSTRUCTIONS]: "customInstructions",
    [KEY_AUTOSTART]: "autostart",
    [KEY_RESTORE_WINDOW]: "restoreWindowState",
    [KEY_AUTOCOMPLETE_ENABLED]: "autocompleteEnabled",
    [KEY_AUTOCOMPLETE_PROVIDER]: "autocompleteProvider",
    [KEY_AUTOCOMPLETE_MODEL]: "autocompleteModelId",
    [KEY_FALLBACK_MODEL]: "fallbackModelId",
    [KEY_LMSTUDIO_BASE_URL]: "lmstudioBaseURL",
    [KEY_LMSTUDIO_MODEL_ID]: "lmstudioModelId",
    [KEY_MLX_BASE_URL]: "mlxBaseURL",
    [KEY_MLX_MODEL_ID]: "mlxModelId",
    [KEY_OPENAI_COMPAT_BASE_URL]: "openaiCompatibleBaseURL",
    [KEY_OPENAI_COMPAT_MODEL_ID]: "openaiCompatibleModelId",
    [KEY_OPENAI_COMPAT_CONTEXT_LIMIT]: "openaiCompatibleContextLimit",
    [KEY_FAVORITE_MODELS]: "favoriteModelIds",
    [KEY_RECENT_MODELS]: "recentModelIds",
    [KEY_HIDDEN_MODELS]: "hiddenModelIds",
    [KEY_VIM_MODE]: "vimMode",
    [KEY_MINIMAP]: "minimapEnabled",
    [KEY_COMMIT_TEMPLATE]: "commitMessageTemplate",
    [KEY_SHOW_HIDDEN]: "showHidden",
    [KEY_TERMINAL_WEBGL_ENABLED]: "terminalWebglEnabled",
    [KEY_TERMINAL_FONT_FAMILY]: "terminalFontFamily",
    [KEY_TERMINAL_LETTER_SPACING]: "terminalLetterSpacing",
    [KEY_TERMINAL_FONT_SIZE]: "terminalFontSize",
    [KEY_TERMINAL_SCROLLBACK]: "terminalScrollback",
    [KEY_LAST_WSL_DISTRO]: "lastWslDistro",
    [KEY_ZOOM_LEVEL]: "zoomLevel",
    [KEY_SHORTCUTS]: "shortcuts",
    [KEY_PERMISSION_MODE]: "permissionMode",
    [KEY_BYPASS_PERMISSIONS_ENABLED]: "bypassPermissionsEnabled",
    [KEY_AGENT_PICKER_ENABLED]: "agentPickerEnabled",
    [KEY_A11Y_REDUCE_MOTION]: "reduceMotion",
    [KEY_A11Y_HIGH_CONTRAST]: "highContrast",
    [KEY_A11Y_LARGER_TEXT]: "largerText",
    [KEY_A11Y_UNDERLINE_LINKS]: "underlineLinks",
    [KEY_A11Y_FOCUS_RING]: "focusRing",
    [KEY_A11Y_CHAT_ANNOUNCE]: "chatAnnounce",
    [KEY_A11Y_APPROVAL_ASSERTIVE]: "approvalAnnounceAssertive",
    [KEY_A11Y_TERMINAL_SR]: "terminalScreenReader",
    [KEY_A11Y_SKIP_LINKS]: "showSkipLinks",
    [KEY_COMPACTION_AUTO]: "compactionAuto",
    [KEY_COMPACTION_THRESHOLD_PERCENT]: "compactionThresholdPercent",
    [KEY_COMPACTION_THRESHOLD_TOKENS]: "compactionThresholdTokens",
    [KEY_COMPACTION_TAIL_TURNS]: "compactionTailTurns",
    [KEY_COMPACTION_PRUNE]: "compactionPrune",
    [KEY_COMPACTION_PRUNE_RECENCY_TOKENS]: "compactionPruneRecencyTokens",
  };
  // Same-process writes still fire onChange immediately; cross-window writes
  // arrive via the Tauri event emitted by writePref().
  const unsubLocal = await store.onChange<unknown>((key, value) => {
    const mapped = map[key];
    if (mapped) cb(mapped, value);
  });
  const unsubEvent = await listen<{ key: string; value: unknown }>(
    PREFS_CHANGED_EVENT,
    (e) => {
      const mapped = map[e.payload.key];
      if (mapped) cb(mapped, e.payload.value);
    },
  );
  return () => {
    unsubLocal();
    unsubEvent();
  };
}

// API key changes are stored in OS keychain (not the prefs store),
// so we broadcast via a Tauri event for cross-window listeners.
const KEYS_CHANGED_EVENT = "altai://ai-keys-changed";

export async function emitKeysChanged(): Promise<void> {
  await emit(KEYS_CHANGED_EVENT);
}

export function onKeysChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(KEYS_CHANGED_EVENT, () => cb());
}
