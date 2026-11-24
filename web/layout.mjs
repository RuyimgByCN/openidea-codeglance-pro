/** Pure minimap geometry, tab stops, region parsing, and hover lens helpers. */

const REGION_PATTERNS = [
  /^\s*\/\/\s*#?region\s+(.+?)\s*$/i,
  /^\s*\/\*\s*#?region\s+(.+?)\s*\*\/\s*$/i,
  /^\s*#\s*region\s+(.+?)\s*$/i,
  /^\s*<!--\s*#?region\s+(.+?)\s*-->\s*$/i,
  /^\s*\/\/\s*MARK:\s*-?\s*(.+?)\s*$/,
];

/**
 * Returns a mapper from UTF-16 column index to visual tab-expanded column.
 *
 * @param {string} line
 * @param {number} tabSize
 * @returns {(col: number) => number}
 */
export function expandTabColumns(line, tabSize = 4) {
  if (!line || !line.includes("\t")) return (col) => Math.max(0, Math.min(col, line.length));
  const step = Math.max(1, Math.trunc(tabSize) || 4);
  const cols = new Int32Array(line.length + 1);
  let visual = 0;
  for (let i = 0; i < line.length; i++) {
    visual += line.charCodeAt(i) === 9 ? step - (visual % step) : 1;
    cols[i + 1] = visual;
  }
  return (col) => cols[Math.max(0, Math.min(Math.trunc(col), line.length))];
}

/**
 * Extracts `// region ...`, `# region ...`, `<!-- region ... -->`, and `// MARK: ...` labels.
 *
 * @param {readonly string[]} lines
 * @returns {Array<{ line: number; label: string }>}
 */
export function extractRegions(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const pattern of REGION_PATTERNS) {
      const match = pattern.exec(line);
      if (match && match[1]) {
        const label = match[1].replace(/\s*\*\/\s*$/, "").trim();
        if (label) out.push({ line: i, label });
        break;
      }
    }
  }
  return out;
}

/**
 * Builds an O(N) prefix-row map honoring folded ranges and soft-wrapped line counts.
 * Document lines are 0-based; collapsed lines inside `[fromLine + 1, toLine]` take 0 visual rows.
 *
 * @param {number} lineCount
 * @param {readonly { fromLine: number; toLine: number }[]} folds
 * @param {readonly number[] | null} [wrappedRows]
 */
export function buildRowMap(lineCount, folds = [], wrappedRows = null) {
  const n = Math.max(0, Math.trunc(lineCount));
  const prefix = new Float64Array(n + 1);
  const foldSpans = new Int32Array(n); // > 0 at fold head line: total hidden+head span
  let fIdx = 0;
  while (fIdx < folds.length && folds[fIdx].toLine < 0) fIdx++;

  for (let line = 0; line < n; line++) {
    while (fIdx < folds.length && folds[fIdx].toLine < line) fIdx++;
    const fold = fIdx < folds.length ? folds[fIdx] : null;
    if (fold && line > fold.fromLine && line <= fold.toLine) {
      prefix[line + 1] = prefix[line];
      continue;
    }
    const isFoldHead = fold && line === fold.fromLine && fold.toLine > fold.fromLine;
    if (isFoldHead) foldSpans[line] = fold.toLine - fold.fromLine + 1;
    const rawWrap = !isFoldHead && wrappedRows && line < wrappedRows.length ? wrappedRows[line] : 1;
    const visualRows = Math.max(1, Number.isFinite(rawWrap) ? rawWrap : 1);
    prefix[line + 1] = prefix[line] + visualRows;
  }

  const totalRows = Math.max(1, prefix[n]);

  /** Converts a 0-based (possibly fractional) document line to a 0-based visual row. */
  const rowOf = (line) => {
    if (n === 0) return 0;
    const clamped = Math.max(0, Math.min(line, n));
    const idx = Math.floor(clamped);
    if (idx >= n) return prefix[n];
    const frac = clamped - idx;
    // Inside a collapsed fold, distribute fractional lines uniformly across its hidden span.
    const hiddenAnchor = findFoldAt(folds, idx);
    if (hiddenAnchor) {
      const span = Math.max(1, hiddenAnchor.toLine + 1 - hiddenAnchor.fromLine);
      const rowHeight = prefix[hiddenAnchor.fromLine + 1] - prefix[hiddenAnchor.fromLine];
      return prefix[hiddenAnchor.fromLine] + ((clamped - hiddenAnchor.fromLine) / span) * rowHeight;
    }
    const height = prefix[idx + 1] - prefix[idx];
    return prefix[idx] + frac * height;
  };

  /** Converts a 0-based visual row to the 0-based (possibly fractional) document line. */
  const lineOfRow = (row) => {
    if (n === 0) return 0;
    const clamped = Math.max(0, Math.min(row, prefix[n]));
    if (clamped >= prefix[n]) return n;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (prefix[mid] <= clamped) lo = mid;
      else hi = mid - 1;
    }
    // Step forward past 0-height folded lines until finding the visible line owning `lo`'s row.
    while (lo + 1 < n && prefix[lo + 1] === prefix[lo]) lo++;
    const rowHeight = Math.max(1, prefix[lo + 1] - prefix[lo]);
    const frac = (clamped - prefix[lo]) / rowHeight;
    const foldSpan = foldSpans[lo];
    if (foldSpan > 1) return lo + frac * foldSpan;
    return Math.min(n, lo + frac);
  };

  return { totalRows, prefix, rowOf, lineOfRow };
}

function findFoldAt(folds, line) {
  let lo = 0;
  let hi = folds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = folds[mid];
    if (line < f.fromLine) hi = mid - 1;
    else if (line > f.toLine) lo = mid + 1;
    else return f.toLine > f.fromLine ? f : null;
  }
  return null;
}

/**
 * Computes minimap vertical scroll offset and viewport indicator geometry.
 *
 * @param {{
 *   canvasHeight: number;
 *   lineHeight: number;
 *   totalRows: number;
 *   firstRow: number;
 *   lastRow: number;
 *   scrollTop: number;
 *   scrollHeight: number;
 *   clientHeight: number;
 * }} params
 */
export function computeViewportLayout({
  canvasHeight,
  lineHeight,
  totalRows,
  firstRow,
  lastRow,
  scrollTop,
  scrollHeight,
  clientHeight,
}) {
  const H = Math.max(1, canvasHeight || 0);
  const L = Math.max(1, totalRows || 1);
  const visibleRows = Math.max(1, (lastRow || 0) - (firstRow || 0));
  const mapHeight = L * lineHeight;
  const scrollable = Math.max(1, (scrollHeight || 0) - (clientHeight || 0));
  const p = scrollHeight > clientHeight ? Math.min(1, Math.max(0, (scrollTop || 0) / scrollable)) : 0;
  const offset = p * Math.max(0, mapHeight - H);
  const top = (firstRow || 0) * lineHeight - offset;
  const height = Math.max(6, visibleRows * lineHeight);
  const range = Math.max(1, Math.min(H, mapHeight) - visibleRows * lineHeight);
  return { H, L, mapHeight, offset, top, height, range, visibleRows };
}

/**
 * Trims common leading whitespace from non-empty lines so deeply nested blocks
 * remain readable inside a compact hover preview.
 *
 * @param {readonly string[]} lines
 * @param {number} tabSize
 * @returns {{ lines: string[]; trimmedColumns: number[] }}
 */
export function dedentLines(lines, tabSize = 4) {
  const expanded = lines.map((line) => expandTabString(line, tabSize));
  let minIndent = Infinity;
  for (const s of expanded) {
    if (!s.trim()) continue;
    let indent = 0;
    while (indent < s.length && s[indent] === " ") indent++;
    if (indent < minIndent) minIndent = indent;
  }
  if (!Number.isFinite(minIndent) || minIndent <= 0) {
    return { lines: expanded, trimmedColumns: expanded.map(() => 0) };
  }
  return {
    lines: expanded.map((s) => (s.length >= minIndent ? s.slice(minIndent) : s.trimStart())),
    trimmedColumns: expanded.map((s) => (s.length >= minIndent ? minIndent : s.length - s.trimStart().length)),
  };
}

function expandTabString(line, tabSize = 4) {
  if (!line || !line.includes("\t")) return line || "";
  const step = Math.max(1, Math.trunc(tabSize) || 4);
  let out = "";
  let visual = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\t") {
      const spaces = step - (visual % step);
      out += " ".repeat(spaces);
      visual += spaces;
    } else {
      out += line[i];
      visual += 1;
    }
  }
  return out;
}

/**
 * Builds the line slice and active region label for the Hover Code Lens card.
 *
 * @param {readonly string[]} lines
 * @param {number} hoverLine
 * @param {number} count
 * @param {readonly { line: number; label: string }[]} [regions]
 * @param {number} [tabSize]
 */
export function sliceHoverLens(lines, hoverLine, count = 9, regions = [], tabSize = 4) {
  if (!lines.length) {
    return { startLine: 0, endLine: 0, focusLine: 0, regionLabel: null, items: [] };
  }
  const n = lines.length;
  const clampedCount = Math.max(3, Math.min(n, Math.trunc(count) || 9));
  const focus = Math.max(0, Math.min(n - 1, Math.trunc(hoverLine) || 0));
  const half = Math.floor(clampedCount / 2);
  let start = Math.max(0, focus - half);
  const end = Math.min(n, start + clampedCount);
  start = Math.max(0, end - clampedCount);

  const rawSlice = lines.slice(start, end);
  const { lines: dedented, trimmedColumns } = dedentLines(rawSlice, tabSize);

  let regionLabel = null;
  for (let i = regions.length - 1; i >= 0; i--) {
    if (regions[i].line <= focus) {
      regionLabel = regions[i].label;
      break;
    }
  }

  return {
    startLine: start,
    endLine: end,
    focusLine: focus,
    regionLabel,
    items: dedented.map((text, idx) => ({
      line: start + idx,
      text,
      trim: trimmedColumns[idx],
      isFocus: start + idx === focus,
    })),
  };
}
