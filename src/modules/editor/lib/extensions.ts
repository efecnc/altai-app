import { detectMonoFontFamily } from "@/lib/fonts";
import { indentUnit } from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { search } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { showMinimap } from "@replit/codemirror-minimap";

// Compartments allow runtime reconfiguration without rebuilding state.
export const languageCompartment = new Compartment();
export const readOnlyCompartment = new Compartment();
export const wrapCompartment = new Compartment();
export const vimCompartment = new Compartment();
export const minimapCompartment = new Compartment();

/** Right-side code minimap for navigating long files (#66). */
export function minimapExtension(): Extension {
  // Static config, so `.of` is the idiomatic form (no doc/state dependency).
  return showMinimap.of({
    create: () => ({ dom: document.createElement("div") }),
    displayText: "blocks",
    showOverlay: "mouse-over",
  });
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
