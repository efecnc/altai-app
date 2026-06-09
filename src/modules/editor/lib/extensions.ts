import { detectMonoFontFamily } from "@/lib/fonts";
import { indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";
import { computeMinimapGutters, gitChangesField } from "./minimapMarkers";

// Compartments allow runtime reconfiguration without rebuilding state.
export const languageCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const minimapCompartment = new Compartment();

/**
 * Right-side code minimap for navigating long files (#66), with git-diff and
 * selection/search markers in its gutter (#82). Gutters recompute on doc,
 * selection, and git-change updates.
 */
export function minimapExtension(): Extension {
  return [
    gitChangesField,
    showMinimap.compute(["doc", "selection", gitChangesField], (state: EditorState) => ({
      create: () => ({ dom: document.createElement("div") }),
      // Render actual (scaled-down) characters with syntax colors, like
      // VSCode's minimap — not abstract blocks. "always" keeps the viewport
      // box visible so the current position in the file is always obvious.
      displayText: "characters",
      showOverlay: "always",
      gutters: computeMinimapGutters(state),
    })),
    // The package's default viewport box is rgb(121,121,121) @ 0.2 — too faint
    // to read your position. Replace it with a theme-aware translucent slider
    // (brighter on hover/drag) plus a thin outline, like VSCode's minimap slider.
    EditorView.theme({
      ".cm-minimap-overlay-container .cm-minimap-overlay": {
        background:
          "color-mix(in srgb, var(--foreground) 15%, transparent) !important",
        opacity: "1 !important",
        outline:
          "1px solid color-mix(in srgb, var(--foreground) 22%, transparent)",
        outlineOffset: "-1px",
        borderRadius: "2px",
        transition: "background 120ms ease",
      },
      ".cm-minimap-overlay-container:hover .cm-minimap-overlay, .cm-minimap-overlay-container.cm-minimap-overlay-active .cm-minimap-overlay":
        {
          background:
            "color-mix(in srgb, var(--foreground) 24%, transparent) !important",
        },
    }),
  ];
}

// Only what basicSetup doesn't already cover, to avoid duplicate extensions.
// basicSetup gives us line numbers, fold gutter, history, indentOnInput,
// bracketMatching, closeBrackets, autocompletion, highlightActiveLine,
// highlightSelectionMatches and the search keymap.
export function buildSharedExtensions(): Extension[] {
  return [
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    search({ top: true }),
    lintGutter(),
    EditorView.theme({
      "&, &.cm-editor, &.cm-editor.cm-focused": {
        outline: "none",
        padding: "8px",
      },
      ".cm-scroller": {
        fontFamily: detectMonoFontFamily(),
        fontSize: "13px",
        lineHeight: "1.55",
        // Kill the elastic horizontal rubber-banding that let users scroll past
        // the left text margin into empty space, which felt buggy (#68).
        overscrollBehaviorX: "none",
      },
      ".cm-gutter-lint": {
        width: "0px",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        opacity: "0.55",
      },
      ".cm-foldGutter": { width: "10px" },
      ".cm-foldGutter .cm-gutterElement": {
        opacity: "0.5",
      },
      ".cm-activeLine": {
        borderTopRightRadius: "5px",
        borderBottomRightRadius: "5px",
      },
      ".cm-lineNumbers .cm-activeLineGutter": {
        borderTopLeftRadius: "5px",
        borderBottomLeftRadius: "5px",
        userSelect: "none",
      },
      // Vim normal-mode block cursor — translucent overlay, picks up the
      // active theme's foreground so it stays legible on any background.
      ".cm-fat-cursor": {
        background:
          "color-mix(in srgb, currentColor 35%, transparent) !important",
        outline:
          "1px solid color-mix(in srgb, currentColor 55%, transparent) !important",
      },
      "&:not(.cm-focused) .cm-fat-cursor": {
        background: "transparent !important",
        outline:
          "1px solid color-mix(in srgb, currentColor 35%, transparent) !important",
      },
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        borderColor: "var(--border)",
      },
    }),
  ];
}
