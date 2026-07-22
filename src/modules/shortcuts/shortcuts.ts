import { IS_MAC, MOD_PROP } from "@/lib/platform";

/**
 * Single source of truth for keyboard shortcuts.
 */

export type ShortcutId =
  | "tab.new"
  | "tab.newPrivate"
  | "tab.newPreview"
  | "tab.newEditor"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.selectByIndex"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.focusNext"
  | "pane.focusPrev"
  | "pane.source"
  | "terminal.toggle"
  | "search.focus"
  | "explorer.search"
  | "explorer.focus"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "ai.toggle"
  | "ai.askSelection"
  | "shortcuts.open"
  | "settings.open"
  | "sidebar.toggle"
  | "editor.undo"
  | "editor.redo"
  | "editor.save"
  | "editor.toggleComment"
  | "editor.moveLineUp"
  | "editor.moveLineDown"
  | "editor.copyLineUp"
  | "editor.copyLineDown"
  | "editor.deleteLine";

export type ShortcutGroup =
  | "General"
  | "Tabs"
  | "Panes"
  | "Search"
  | "AI"
  | "View"
  | "Editor";

export type KeyBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBindings: KeyBinding[];
  allowRepeat?: boolean;
  /**
   * Handled natively by CodeMirror (not via an App-level handler), so the
   * binding is fixed and shown for reference only — not rebindable in the
   * customization UI.
   */
  readOnly?: boolean;
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: "settings.open",
    label: "Open settings",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "," }],
  },
  {
    id: "shortcuts.open",
    label: "Show keyboard shortcuts",
    group: "General",
    defaultBindings: [{ [MOD_PROP]: true, key: "k" }],
  },
  {
    id: "tab.new",
    label: "New tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "t" }],
  },
  {
    id: "tab.newPrivate",
    label: "New private terminal",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "r" }],
  },
  {
    id: "tab.newPreview",
    label: "New preview tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "p" }],
  },
  {
    id: "tab.newEditor",
    label: "New editor tab",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "e" }],
  },
  {
    id: "tab.close",
    label: "Close tab or pane",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "w" }],
  },
  {
    id: "terminal.toggle",
    label: "Toggle terminal",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "j" }],
  },
  {
    id: "pane.splitRight",
    label: "Split pane right",
    group: "Panes",
    // VSCode "Split Editor" is ⌘\ / Ctrl+\. Leaving ⌘D free lets it fall
    // through to CodeMirror's native select-next-occurrence in the editor.
    defaultBindings: [{ [MOD_PROP]: true, key: "\\" }],
  },
  {
    id: "pane.splitDown",
    label: "Split pane down",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "d" }],
  },
  {
    id: "pane.focusNext",
    label: "Focus next pane",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "]" }],
  },
  {
    id: "pane.focusPrev",
    label: "Focus previous pane",
    group: "Panes",
    defaultBindings: [{ [MOD_PROP]: true, key: "[" }],
  },  
  {
    id: "pane.source",
    label: "Toggle source panel",
    group: "Panes",
    // VSCode "Show Source Control" is ⌘⇧G / Ctrl+Shift+G.
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "g" }],
  },
  {
    id: "tab.next",
    label: "Next tab",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, key: "Tab" }],
  },
  {
    id: "tab.prev",
    label: "Previous tab",
    group: "Tabs",
    defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
  },
  {
    id: "tab.selectByIndex",
    label: "Jump to tab 1–9",
    group: "Tabs",
    defaultBindings: [{ [MOD_PROP]: true, key: "1" }],
  },
  {
    id: "explorer.search",
    label: "Search files",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "f" }],
  },
  {
    id: "search.focus",
    label: "Find in terminal",
    group: "Search",
    defaultBindings: [{ [MOD_PROP]: true, key: "f" }],
  },
  {
    id: "ai.toggle",
    label: "Toggle AI agent",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, key: "i" }],
  },
  {
    id: "ai.askSelection",
    label: "Ask AI about selection",
    group: "AI",
    defaultBindings: [{ [MOD_PROP]: true, key: "l" }],
  },
  {
    id: "sidebar.toggle",
    label: "Toggle file explorer",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "b" }],
  },
  {
    id: "explorer.focus",
    label: "Toggle file explorer focus",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "e" }],
  },
  {
    id: "view.zoomIn",
    label: "Zoom in",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "=" },
      { [MOD_PROP]: true, shift: true, key: "+" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomOut",
    label: "Zoom out",
    group: "View",
    defaultBindings: [
      { [MOD_PROP]: true, key: "-" },
      { [MOD_PROP]: true, shift: true, key: "_" },
    ],
    allowRepeat: true,
  },
  {
    id: "view.zoomReset",
    label: "Reset zoom",
    group: "View",
    defaultBindings: [{ [MOD_PROP]: true, key: "0" }],
  },
  // Editor entries are reference-only: CodeMirror's defaultKeymap/historyKeymap
  // bind these keys natively. We register them here so the shortcuts dialog can
  // surface them — those flagged `readOnly` have no App-level handler, so
  // `useGlobalShortcuts` falls through without `preventDefault`, leaving
  // CodeMirror to handle the event. They mirror VSCode's editor defaults.
  {
    id: "editor.undo",
    label: "Undo",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "z" }],
  },
  {
    id: "editor.redo",
    label: "Redo",
    group: "Editor",
    // VSCode redo: ⌘⇧Z on macOS, Ctrl+Y on Windows/Linux. This also matches
    // CodeMirror's native historyKeymap ({ key: "Mod-y", mac: "Mod-Shift-z" }),
    // so the displayed binding stays accurate per platform.
    defaultBindings: IS_MAC
      ? [{ meta: true, shift: true, key: "z" }]
      : [{ ctrl: true, key: "y" }],
  },
  {
    id: "editor.save",
    label: "Save file",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "s" }],
    readOnly: true,
  },
  {
    id: "editor.toggleComment",
    label: "Toggle line comment",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, key: "/" }],
    readOnly: true,
  },
  {
    id: "editor.moveLineUp",
    label: "Move line up",
    group: "Editor",
    defaultBindings: [{ alt: true, key: "ArrowUp" }],
    allowRepeat: true,
    readOnly: true,
  },
  {
    id: "editor.moveLineDown",
    label: "Move line down",
    group: "Editor",
    defaultBindings: [{ alt: true, key: "ArrowDown" }],
    allowRepeat: true,
    readOnly: true,
  },
  {
    id: "editor.copyLineUp",
    label: "Copy line up",
    group: "Editor",
    defaultBindings: [{ alt: true, shift: true, key: "ArrowUp" }],
    allowRepeat: true,
    readOnly: true,
  },
  {
    id: "editor.copyLineDown",
    label: "Copy line down",
    group: "Editor",
    defaultBindings: [{ alt: true, shift: true, key: "ArrowDown" }],
    allowRepeat: true,
    readOnly: true,
  },
  {
    id: "editor.deleteLine",
    label: "Delete line",
    group: "Editor",
    defaultBindings: [{ [MOD_PROP]: true, shift: true, key: "k" }],
    allowRepeat: true,
    readOnly: true,
  },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Panes",
  "View",
  "Search",
  "AI",
  "Editor",
];

/**
 * Matching logic: checks if a KeyboardEvent matches a KeyBinding.
 */
export function matchBinding(
  e: KeyboardEvent,
  binding: KeyBinding,
  id?: ShortcutId
): boolean {
  const eventKey = e.key.toLowerCase();
  const bindingKey = binding.key.toLowerCase();
  // KeyboardEvent.key follows the active keyboard layout. On a Turkish (and
  // several other non-English) layout, pressing the physical I key can yield
  // `ı` rather than `i`, making Cmd/Ctrl+I appear broken. Built-in letter
  // shortcuts are intended to follow their physical key, like VS Code does;
  // retain `key` as the primary match and use the layout-independent code as
  // a fallback only for single Latin-letter bindings.
  const matchesLetterCode =
    bindingKey.length === 1 &&
    /^[a-z]$/.test(bindingKey) &&
    e.code === `Key${bindingKey.toUpperCase()}`;

  // Special case for Jump to Tab 1-9
  if (id === "tab.selectByIndex") {
    if (!/^[1-9]$/.test(e.key)) return false;
  } else if (eventKey !== bindingKey && !matchesLetterCode) {
    return false;
  }

  return (
    !!e.ctrlKey === !!binding.ctrl &&
    !!e.shiftKey === !!binding.shift &&
    !!e.altKey === !!binding.alt &&
    !!e.metaKey === !!binding.meta
  );
}

/**
 * Display helpers
 */
export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return [];
  const tokens: string[] = [];
  if (IS_MAC) {
    if (binding.ctrl) tokens.push("⌃");
    if (binding.alt) tokens.push("⌥");
    if (binding.shift) tokens.push("⇧");
    if (binding.meta) tokens.push("⌘");
  } else {
    if (binding.ctrl) tokens.push("Ctrl");
    if (binding.alt) tokens.push("Alt");
    if (binding.shift) tokens.push("Shift");
    if (binding.meta) tokens.push("Win");
  }

  let keyLabel = binding.key;
  if (keyLabel === " ") keyLabel = "Space";
  else if (keyLabel === "ArrowUp") keyLabel = "↑";
  else if (keyLabel === "ArrowDown") keyLabel = "↓";
  else if (keyLabel === "ArrowLeft") keyLabel = "←";
  else if (keyLabel === "ArrowRight") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}
