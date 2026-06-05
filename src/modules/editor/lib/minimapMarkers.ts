import { getSearchQuery } from "@codemirror/search";
import { StateEffect, StateField, type EditorState } from "@codemirror/state";

// Minimap gutter is a map of 1-based line number -> CSS color.
type Gutter = Record<number, string>;

const COLOR_ADDED = "#22c55e"; // green — new lines
const COLOR_MODIFIED = "#f59e0b"; // amber — modified lines
const COLOR_DELETED = "#ef4444"; // red — line(s) removed here
const COLOR_MATCH = "#3b82f6"; // blue — selection / search matches

const MAX_MATCH_SCAN = 2000; // cap match count on a single scan
const MAX_MATCH_SCAN_CHARS = 2_000_000; // skip match scans on very large docs

export type GitChangedLines = {
  added: Set<number>;
  modified: Set<number>;
  /** New-file line numbers adjacent to a pure deletion. */
  deleted: Set<number>;
};

const EMPTY_GIT_CHANGES: GitChangedLines = {
  added: new Set(),
  modified: new Set(),
  deleted: new Set(),
};

/** Effect to push freshly-parsed git changes into the editor state. */
export const setGitChanges = StateEffect.define<GitChangedLines>();

/** Holds the current file's working-tree changes for the minimap git gutter. */
export const gitChangesField = StateField.define<GitChangedLines>({
  create: () => EMPTY_GIT_CHANGES,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGitChanges)) return e.value;
    }
    return value;
  },
});

/**
 * Parse a unified diff for a single file into changed new-file line numbers.
 * Uses the standard gutter heuristic: additions paired with removals are
 * "modified", unpaired additions are "added", and leftover removals mark the
 * following line as a deletion point.
 */
export function parseChangedLines(diffText: string): GitChangedLines {
  const added = new Set<number>();
  const modified = new Set<number>();
  const deleted = new Set<number>();
  if (!diffText) return { added, modified, deleted };

  let newLine = 0; // 1-based line in the new file
  let pendingRemovals = 0;
  let inHunk = false;

  const flushRemovals = (atLine: number) => {
    if (pendingRemovals > 0) {
      deleted.add(Math.max(1, atLine));
      pendingRemovals = 0;
    }
  };

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("@@")) {
      // @@ -oldStart,oldCount +newStart,newCount @@
      const m = /\+(\d+)/.exec(raw.split("@@")[1] ?? "");
      flushRemovals(newLine);
      newLine = m ? parseInt(m[1], 10) : newLine;
      inHunk = true;
      continue;
    }
    // Everything before the first hunk is file header/preamble. Gating on this
    // (instead of matching "+++"/"---") avoids miscounting hunk-body lines whose
    // content happens to start with "++" / "--", which would shift every later
    // marker by one.
    if (!inHunk) continue;
    // "\ No newline at end of file" is diff metadata, not a document line.
    if (raw.startsWith("\\")) continue;
    const marker = raw[0];
    if (marker === "+") {
      if (pendingRemovals > 0) {
        modified.add(newLine);
        pendingRemovals--;
      } else {
        added.add(newLine);
      }
      newLine++;
    } else if (marker === "-") {
      pendingRemovals++;
    } else {
      // context line
      flushRemovals(newLine);
      newLine++;
    }
  }
  flushRemovals(newLine);
  return { added, modified, deleted };
}

function gitGutter(state: EditorState): Gutter {
  const changes = state.field(gitChangesField, false);
  if (!changes) return {};
  const total = state.doc.lines;
  const gutter: Gutter = {};
  for (const ln of changes.added) if (ln >= 1 && ln <= total) gutter[ln] = COLOR_ADDED;
  for (const ln of changes.modified) if (ln >= 1 && ln <= total) gutter[ln] = COLOR_MODIFIED;
  for (const ln of changes.deleted) if (ln >= 1 && ln <= total) gutter[ln] = COLOR_DELETED;
  return gutter;
}

/** Collect 1-based line numbers containing a literal occurrence of `needle`. */
function lineNumbersForLiteral(
  state: EditorState,
  needle: string,
  caseSensitive: boolean,
): Set<number> {
  const lines = new Set<number>();
  if (needle.length < 2) return lines;
  // Skip whole-doc materialization on very large files — these scans run
  // synchronously in the minimap facet on every doc/selection change.
  if (state.doc.length > MAX_MATCH_SCAN_CHARS) return lines;
  const docText = state.doc.toString();
  const hay = caseSensitive ? docText : docText.toLowerCase();
  const find = caseSensitive ? needle : needle.toLowerCase();
  let from = 0;
  let count = 0;
  for (;;) {
    const idx = hay.indexOf(find, from);
    if (idx === -1 || count >= MAX_MATCH_SCAN) break;
    lines.add(state.doc.lineAt(idx).number);
    from = idx + find.length;
    count++;
  }
  return lines;
}

function matchGutter(state: EditorState): Gutter {
  const gutter: Gutter = {};
  const mark = (lines: Set<number>) => {
    for (const ln of lines) gutter[ln] = COLOR_MATCH;
  };

  // Active search query (Ctrl+F). Literal queries only; regexp is skipped.
  const query = getSearchQuery(state);
  if (query.search && !query.regexp) {
    mark(lineNumbersForLiteral(state, query.search, query.caseSensitive));
  }

  // Current selection word — highlight all other occurrences.
  const sel = state.selection.main;
  if (!sel.empty) {
    const text = state.sliceDoc(sel.from, sel.to);
    if (!text.includes("\n") && text.trim().length >= 2) {
      mark(lineNumbersForLiteral(state, text, false));
    }
  }
  return gutter;
}

/** Build the minimap gutters (git changes + selection/search) for #82. */
export function computeMinimapGutters(state: EditorState): Array<Gutter> {
  const git = gitGutter(state);
  const matches = matchGutter(state);
  const gutters: Array<Gutter> = [];
  if (Object.keys(git).length) gutters.push(git);
  if (Object.keys(matches).length) gutters.push(matches);
  return gutters;
}
