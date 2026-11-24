import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRowMap,
  computeViewportLayout,
  dedentLines,
  expandTabColumns,
  extractRegions,
  sliceHoverLens,
} from "../web/layout.mjs";

test("expandTabColumns aligns tab stops accurately", () => {
  const xOf = expandTabColumns("\tfoo\tbar", 4);
  assert.equal(xOf(0), 0);
  assert.equal(xOf(1), 4);
  assert.equal(xOf(4), 7);
  assert.equal(xOf(5), 8);
  assert.equal(xOf(8), 11);
});

test("extractRegions detects common region and MARK markers", () => {
  const lines = [
    "package demo;",
    "// region Public API",
    "public class Foo {",
    "  // MARK: - Helpers",
    "  void run() {}",
    "  /* region Internal */",
    "  # region Python style",
    "}",
  ];
  assert.deepEqual(extractRegions(lines), [
    { line: 1, label: "Public API" },
    { line: 3, label: "Helpers" },
    { line: 5, label: "Internal" },
    { line: 6, label: "Python style" },
  ]);
});

test("buildRowMap skips folded lines and accounts for soft-wrapped rows", () => {
  const folds = [{ fromLine: 2, toLine: 5 }]; // lines 3,4,5 hidden
  const wrapped = [1, 2, 1, 1, 1, 1, 3]; // line 1 wraps 2 rows, line 6 wraps 3 rows
  const map = buildRowMap(7, folds, wrapped);

  assert.equal(map.totalRows, 7); // 1 + 2 + 1(fold head) + 0 + 0 + 0 + 3
  assert.equal(map.rowOf(0), 0);
  assert.equal(map.rowOf(1), 1);
  assert.equal(map.rowOf(2), 3);
  assert.equal(map.rowOf(6), 4);
  assert.equal(Math.round(map.lineOfRow(4)), 6);
  assert.equal(Math.round(map.lineOfRow(3.5)), 4);
});

test("computeViewportLayout computes scroll offset and proportional indicator", () => {
  const layout = computeViewportLayout({
    canvasHeight: 150,
    lineHeight: 3,
    totalRows: 100,
    firstRow: 50,
    lastRow: 70,
    scrollTop: 500,
    scrollHeight: 1000,
    clientHeight: 200,
  });
  // mapHeight = 300, max offset = 150, p = 500/800 = 0.625 => offset = 93.75
  assert.equal(layout.mapHeight, 300);
  assert.equal(layout.offset, 93.75);
  assert.equal(layout.top, 50 * 3 - 93.75);
  assert.equal(layout.height, 20 * 3);
});

test("dedentLines and sliceHoverLens trim common indentation and track active region", () => {
  const lines = [
    "class Service {",
    "    // region Queries",
    "    List<String> find() {",
    "        return list();",
    "    }",
    "}",
  ];
  const regions = extractRegions(lines);
  const { lines: trimmed, trimmedColumns } = dedentLines(lines.slice(2, 5), 4);
  assert.deepEqual(trimmed, ["List<String> find() {", "    return list();", "}"]);
  assert.deepEqual(trimmedColumns, [4, 4, 4]);

  const lens = sliceHoverLens(lines, 3, 3, regions, 4);
  assert.equal(lens.focusLine, 3);
  assert.equal(lens.regionLabel, "Queries");
  assert.equal(lens.items[1].isFocus, true);
  assert.equal(lens.items[1].text, "    return list();");
});
