import { MergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getDefaultExtensions } from "@uiw/react-codemirror";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";
import { buildSharedExtensions } from "./lib/extensions";

type Props = {
  original: string;
  modified: string;
  theme: "light" | "dark";
  /** Extra CodeMirror theme/diff-color extension shared with the unified view. */
  diffTheme: Extension;
};

const SHARED_EXT = buildSharedExtensions();

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  searchKeymap: true,
} as const;

// MergeView (.cm-mergeView) is itself the vertical scroll container and keeps
// both columns synchronized, so the editors grow to content height. Wrap long
// lines so each column fits its box instead of overflowing horizontally (the
// column wrapper clips overflow), and the bounded MergeView height scrolls.
const READONLY: Extension[] = [
  EditorView.editable.of(false),
  EditorView.lineWrapping,
];

/**
 * Side-by-side diff using CodeMirror's MergeView: original on the left,
 * modified on the right, with change highlighting and synchronized scrolling.
 * The editor theme/chrome comes from the same source the unified view uses
 * (`getDefaultExtensions`), but no language parser is loaded on purpose — the
 * code stays a calm, uniform gray with no syntax colors so the red/green diff
 * highlights are what stand out, matching the inline diff.
 */
export function SplitDiffView({ original, modified, theme, diffTheme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const common: Extension[] = [
      ...getDefaultExtensions({
        theme,
        basicSetup: BASIC_SETUP,
        readOnly: true,
        editable: false,
      }),
      ...SHARED_EXT,
      ...READONLY,
      diffTheme,
    ];

    const view = new MergeView({
      a: { doc: original, extensions: common },
      b: { doc: modified, extensions: common },
      parent: host,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
    });

    return () => {
      view.destroy();
    };
  }, [original, modified, theme, diffTheme]);

  return (
    <div
      ref={hostRef}
      className={cn(
        "h-full min-h-0 overflow-hidden",
        // Bound the MergeView to the host so its built-in overflow-y scroller
        // engages (synchronized vertical scroll across both columns).
        "[&_.cm-mergeView]:h-full [&_.cm-mergeView]:min-h-0",
        "[&_.cm-mergeViewEditor]:min-w-0",
      )}
    />
  );
}
