import { describe, expect, it } from "vitest";
import { parseChangedLines } from "./minimapMarkers";

const arr = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("parseChangedLines", () => {
  it("marks a pure insertion as added", () => {
    const diff = ["@@ -2,2 +2,3 @@", " line2", "+inserted", " line3"].join(
      "\n",
    );
    const r = parseChangedLines(diff);
    expect(arr(r.added)).toEqual([3]);
    expect(arr(r.modified)).toEqual([]);
    expect(arr(r.deleted)).toEqual([]);
  });

  it("marks a 1:1 replacement as modified", () => {
    const diff = ["@@ -3,1 +3,1 @@", "-old", "+new"].join("\n");
    const r = parseChangedLines(diff);
    expect(arr(r.modified)).toEqual([3]);
    expect(arr(r.added)).toEqual([]);
  });

  it("marks a pure deletion at the following line", () => {
    const diff = ["@@ -3,2 +3,1 @@", " keep", "-gone"].join("\n");
    const r = parseChangedLines(diff);
    expect(arr(r.deleted)).toEqual([4]);
    expect(arr(r.added)).toEqual([]);
    expect(arr(r.modified)).toEqual([]);
  });

  it("pairs removals with additions (modified) then extras (added)", () => {
    const diff = ["@@ -3,2 +3,3 @@", "-a", "-b", "+x", "+y", "+z"].join("\n");
    const r = parseChangedLines(diff);
    expect(arr(r.modified)).toEqual([3, 4]);
    expect(arr(r.added)).toEqual([5]);
  });

  it("handles a new file (--- /dev/null) without miscounting the header", () => {
    const diff = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
    ].join("\n");
    const r = parseChangedLines(diff);
    expect(arr(r.added)).toEqual([1, 2]);
  });

  it("ignores the '\\ No newline at end of file' marker", () => {
    const diff = [
      "@@ -1 +1 @@",
      "-hello",
      "+world",
      "\\ No newline at end of file",
    ].join("\n");
    const r = parseChangedLines(diff);
    expect(arr(r.modified)).toEqual([1]);
    expect(arr(r.deleted)).toEqual([]);
    expect(arr(r.added)).toEqual([]);
  });

  it("does not mistake hunk-body content starting with '++' for a header", () => {
    const diff = ["@@ -1,1 +1,2 @@", " base", "+++weird"].join("\n");
    const r = parseChangedLines(diff);
    expect(arr(r.added)).toEqual([2]);
  });

  it("returns empty sets for empty input", () => {
    const r = parseChangedLines("");
    expect(arr(r.added)).toEqual([]);
    expect(arr(r.modified)).toEqual([]);
    expect(arr(r.deleted)).toEqual([]);
  });

  it("keeps line numbers correct across multiple hunks", () => {
    const diff = [
      "@@ -1,1 +1,2 @@",
      " a",
      "+b",
      "@@ -10,1 +11,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const r = parseChangedLines(diff);
    expect(arr(r.added)).toEqual([2]);
    expect(arr(r.modified)).toEqual([11]);
  });
});
