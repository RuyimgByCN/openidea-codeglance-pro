import {
  buildRowMap,
  computeViewportLayout,
  expandTabColumns,
  extractRegions,
  sliceHoverLens,
} from "./layout.mjs";

const editor = window.openidea && window.openidea.editor;
const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const emptyEl = document.getElementById("empty");
const lensEl = document.getElementById("lens");
const lensHeaderEl = document.getElementById("lens-header");
const lensLinesEl = document.getElementById("lens-lines");
const cleanBtn = document.getElementById("btn-clean");
const lensBtn = document.getElementById("btn-lens");

const CHUNK = 2000;
const HOVER_DELAY_MS = 110;
const PROBLEM_COLORS = {
  error: "--openidea-danger",
  warning: "--openidea-warning",
};
const PROBLEM_RANK = {
  error: 3,
  warning: 2,
  weakWarning: 1,
};

let config = {
  enabled: true,
  pixelsPerLine: 3,
  cleanMode: true,
  renderMode: "syntax",
  viewportStyle: "shaded",
  showHoverLens: true,
  hoverLensLines: 9,
  showVcsChanges: true,
  showProblems: true,
  showSelections: true,
  showRegionComments: true,
  autoHideShortFiles: 0,
  maxLines: 50000,
};

let target = null;
let lines = [];
let regions = [];
let colors = new Map();
let loadingHighlights = new Set();
let wrappedRows = null;
let loadingWrapped = false;
let folds = [];
let softWrap = false;
let problems = [];
let selections = [];
let changes = [];
let view = null;
let rowMap = buildRowMap(0, [], null);

let queued = false;
let drag = null;
let pointerY = null;
let hovering = false;
let lensTimer = 0;
let activeLensLine = null;
let pointerInBounds = false;

const cssVar = (name, fallback = "") =>
  (window.openidea && window.openidea.theme && window.openidea.theme.vars[name]) || fallback;

function isGrey(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  return !!m && Math.max(Number(m[1]), Number(m[2]), Number(m[3])) - Math.min(Number(m[1]), Number(m[2]), Number(m[3])) < 22;
}

function updateHudButtons() {
  cleanBtn.setAttribute("aria-pressed", String(!!config.cleanMode));
  lensBtn.setAttribute("aria-pressed", String(!!config.showHoverLens));
}

function rebuildRowMap() {
  const activeWrapped = softWrap ? wrappedRows : null;
  rowMap = buildRowMap(lines.length, folds, activeWrapped);
}

function currentLayout() {
  const H = canvas.clientHeight;
  if (!view || !lines.length) {
    return { H, L: 1, mapHeight: 0, offset: 0, top: 0, height: 0, range: 1, visibleRows: 0 };
  }
  const firstRow = rowMap.rowOf(view.firstLine);
  const lastRow = rowMap.rowOf(view.lastLine);
  return computeViewportLayout({
    canvasHeight: H,
    lineHeight: config.pixelsPerLine,
    totalRows: rowMap.totalRows,
    firstRow,
    lastRow,
    scrollTop: view.scrollTop,
    scrollHeight: view.scrollHeight,
    clientHeight: view.clientHeight,
  });
}

function redraw() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(draw);
}

function hideLens() {
  clearTimeout(lensTimer);
  lensTimer = 0;
  activeLensLine = null;
  lensEl.hidden = true;
}

function scheduleLens(y) {
  pointerY = y;
  if (!config.showHoverLens || drag || !view || !lines.length) {
    hideLens();
    return;
  }
  if (config.autoHideShortFiles > 0 && lines.length < config.autoHideShortFiles) {
    hideLens();
    return;
  }
  const line = hoveredDocumentLine(y);
  if (line === null) {
    hideLens();
    return;
  }
  if (!lensEl.hidden) {
    renderLens(line, y);
    return;
  }
  clearTimeout(lensTimer);
  lensTimer = setTimeout(() => {
    if (!pointerInBounds || drag || !config.showHoverLens || pointerY === null) return;
    const latest = hoveredDocumentLine(pointerY);
    if (latest !== null) renderLens(latest, pointerY);
  }, HOVER_DELAY_MS);
}

function hoveredDocumentLine(y) {
  if (!view || !lines.length) return null;
  const { offset } = currentLayout();
  const row = Math.max(0, Math.min(rowMap.totalRows - 0.01, (offset + y) / config.pixelsPerLine));
  return Math.max(0, Math.min(lines.length - 1, Math.floor(rowMap.lineOfRow(row))));
}

function renderLens(focusLine, y) {
  if (!config.showHoverLens || !lines.length) {
    hideLens();
    return;
  }
  const H = canvas.clientHeight;
  const dockTop = y > H * 0.45;
  lensEl.classList.toggle("dock-top", dockTop);
  lensEl.classList.toggle("dock-bottom", !dockTop);

  const slice = sliceHoverLens(lines, focusLine, config.hoverLensLines, config.showRegionComments ? regions : [], target?.tabSize || 4);
  if (!slice.items.length) {
    hideLens();
    return;
  }

  activeLensLine = slice.focusLine;
  lensHeaderEl.textContent = "";
  const lnBadge = document.createElement("span");
  lnBadge.textContent = `L${slice.focusLine + 1}`;
  lensHeaderEl.appendChild(lnBadge);
  if (slice.regionLabel) {
    const reg = document.createElement("span");
    reg.className = "lens-region";
    reg.textContent = slice.regionLabel;
    lensHeaderEl.appendChild(reg);
  }

  const missingHighlight = [];
  for (const item of slice.items) {
    if (!colors.has(item.line) && item.line < config.maxLines) missingHighlight.push(item.line);
  }
  if (missingHighlight.length) void loadHighlights(missingHighlight[0], missingHighlight[missingHighlight.length - 1] + 1);

  lensLinesEl.textContent = "";
  for (const item of slice.items) {
    const rowEl = document.createElement("div");
    rowEl.className = item.isFocus ? "lens-row is-focus" : "lens-row";

    const lnEl = document.createElement("span");
    lnEl.className = "lens-ln";
    lnEl.textContent = String(item.line + 1);
    rowEl.appendChild(lnEl);

    const codeEl = document.createElement("span");
    codeEl.className = "lens-code";
    const spans = colors.get(item.line);
    if (spans && spans.length && config.renderMode === "syntax") {
      appendColoredText(codeEl, item.text, item.trim, spans);
    } else {
      codeEl.textContent = item.text || " ";
    }
    rowEl.appendChild(codeEl);
    lensLinesEl.appendChild(rowEl);
  }

  lensEl.hidden = false;
  redraw();
}

function appendColoredText(container, dedented, trimOffset, spans) {
  if (!dedented) {
    container.textContent = " ";
    return;
  }
  let cursor = 0;
  const maxEnd = trimOffset + dedented.length;
  for (const span of spans) {
    const from = Math.max(trimOffset, span.from) - trimOffset;
    const to = Math.min(maxEnd, span.to) - trimOffset;
    if (to <= cursor || from >= dedented.length) continue;
    if (from > cursor) {
      container.appendChild(document.createTextNode(dedented.slice(cursor, from)));
    }
    const seg = document.createElement("span");
    seg.style.color = span.color;
    seg.textContent = dedented.slice(Math.max(cursor, from), to);
    container.appendChild(seg);
    cursor = Math.max(cursor, to);
  }
  if (cursor < dedented.length) {
    container.appendChild(document.createTextNode(dedented.slice(cursor)));
  }
}

function draw() {
  queued = false;
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (!view || !target) {
    emptyEl.hidden = true;
    return;
  }

  if (config.autoHideShortFiles > 0 && lines.length < config.autoHideShortFiles) {
    emptyEl.hidden = false;
    emptyEl.textContent = `${lines.length}L`;
    return;
  }
  emptyEl.hidden = true;

  const lineH = config.pixelsPerLine;
  const glyphH = Math.max(1.25, lineH === 2 ? 1.4 : lineH - 1);
  const layout = currentLayout();
  const { offset, top, height, L } = layout;

  const leftGutter = config.showVcsChanges ? 4 : 1;
  const rightGutter = config.showProblems ? 4 : 1;
  const codeLeft = leftGutter + 1;
  const maxCodeWidth = Math.max(12, W - codeLeft - rightGutter - 1);
  const xScale = Math.min(1.25, maxCodeWidth / 120);

  const firstRow = Math.max(0, Math.floor(offset / lineH));
  const lastRow = Math.min(L, Math.ceil((offset + H) / lineH));

  const accent = cssVar("--openidea-accent", "#3574f0");
  const muted = cssVar("--openidea-fg-muted", "#868a91");
  const fg = cssVar("--openidea-fg", "#bcbec4");
  const border = cssVar("--openidea-border", "rgba(128, 128, 128, 0.35)");

  // 1. Caret and selections behind code blocks.
  if (config.showSelections) {
    ctx.fillStyle = accent;
    for (const s of selections) {
      const isCaret = s.anchor.line === s.head.line && s.anchor.column === s.head.column;
      const fromLine = Math.min(s.anchor.line, s.head.line);
      const toLine = Math.max(s.anchor.line, s.head.line);
      const yFrom = Math.floor(rowMap.rowOf(fromLine)) * lineH - offset;
      const yTo = Math.floor(rowMap.rowOf(toLine)) * lineH - offset;
      ctx.globalAlpha = isCaret ? 0.32 : 0.18;
      ctx.fillRect(0, yFrom, W, Math.max(lineH, yTo - yFrom + lineH));
    }
    ctx.globalAlpha = 1;
  }

  // 2. Hovered focus line indicator while hover lens is active.
  if (activeLensLine !== null && !drag) {
    const hy = Math.floor(rowMap.rowOf(activeLensLine)) * lineH - offset;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.28;
    ctx.fillRect(0, hy, W, lineH);
    ctx.globalAlpha = 1;
  }

  // 3. Code blocks / glyph stripes (clamped cleanly for huge files).
  const missingHighlights = [];
  const canDrawTokens = lines.length <= config.maxLines;
  const tabSize = target.tabSize || 4;

  let prevLine = -1;
  for (let row = firstRow; row < lastRow; row++) {
    const docLine = Math.floor(rowMap.lineOfRow(row));
    if (docLine === prevLine) {
      // Continuation wrapped row: draw subtle continuation dash if soft wrap is active.
      if (softWrap && canDrawTokens) {
        const y = row * lineH - offset;
        ctx.fillStyle = muted;
        ctx.globalAlpha = 0.18;
        ctx.fillRect(codeLeft + 2, y + 0.25, Math.min(24, maxCodeWidth * 0.4), glyphH);
        ctx.globalAlpha = 1;
      }
      continue;
    }
    prevLine = docLine;

    if (!canDrawTokens) continue;
    const textLine = lines[docLine];
    if (!textLine) continue;

    const y = row * lineH - offset;
    const xMap = expandTabColumns(textLine, tabSize);
    const toPx = (col) => codeLeft + Math.min(maxCodeWidth, xMap(col) * xScale);

    const spans = colors.get(docLine);
    if (!spans) missingHighlights.push(docLine);

    if (config.cleanMode) {
      // Clean Mode: render crisp contiguous word chunks with syntax colors or selected palette.
      const baseColor = config.renderMode === "accent" ? accent : fg;
      ctx.fillStyle = baseColor;
      ctx.globalAlpha = config.renderMode === "monochrome" ? 0.28 : 0.22;
      for (const m of textLine.matchAll(/\S+/g)) {
        const x1 = toPx(m.index);
        const x2 = toPx(m.index + m[0].length);
        if (x2 > x1) ctx.fillRect(x1, y + 0.25, Math.max(1.5, x2 - x1), glyphH);
      }
      ctx.globalAlpha = 1;

      if (config.renderMode === "syntax" && spans) {
        for (const s of spans) {
          if (isGrey(s.color)) continue;
          const x1 = toPx(s.from);
          const x2 = toPx(s.to);
          if (x2 <= x1) continue;
          ctx.fillStyle = s.color;
          ctx.fillRect(x1, y + 0.25, Math.max(1.5, x2 - x1), glyphH);
        }
      }
    } else {
      // Glyph texture mode: finer per-character density modulation.
      ctx.fillStyle = config.renderMode === "accent" ? accent : muted;
      ctx.globalAlpha = 0.3;
      let start = -1;
      for (let i = 0; i <= textLine.length; i++) {
        const ch = i < textLine.length ? textLine[i] : " ";
        const blank = ch === " " || ch === "\t";
        if (!blank && start < 0) start = i;
        else if (blank && start >= 0) {
          const x1 = toPx(start);
          const x2 = toPx(i);
          if (x2 > x1) ctx.fillRect(x1, y + 0.4, Math.max(1, x2 - x1), Math.max(1, glyphH - 0.3));
          start = -1;
        }
      }
      ctx.globalAlpha = 1;
      if (config.renderMode === "syntax" && spans) {
        for (const s of spans) {
          if (isGrey(s.color)) continue;
          const x1 = toPx(s.from);
          const x2 = toPx(s.to);
          if (x2 <= x1) continue;
          ctx.fillStyle = s.color;
          ctx.fillRect(x1, y + 0.4, Math.max(1, x2 - x1), Math.max(1, glyphH - 0.3));
        }
      }
    }
  }

  // 4. Region comment section markers (`// region`, `// MARK:`).
  if (config.showRegionComments && regions.length) {
    ctx.font = `600 8px ${cssVar("--openidea-font-ui", "system-ui, sans-serif")}`;
    ctx.textBaseline = "middle";
    for (const reg of regions) {
      const y = Math.floor(rowMap.rowOf(reg.line)) * lineH - offset;
      if (y < -12 || y > H + 12) continue;
      ctx.fillStyle = border;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(codeLeft, y, W - codeLeft - rightGutter, 1);
      const pillW = Math.min(maxCodeWidth, ctx.measureText(reg.label).width + 6);
      ctx.fillStyle = cssVar("--openidea-bg-elevated", "#2b2d30");
      ctx.globalAlpha = 0.9;
      ctx.fillRect(codeLeft, y + 1, pillW, 9);
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.95;
      ctx.fillText(reg.label, codeLeft + 3, y + 5.5, pillW - 5);
    }
    ctx.globalAlpha = 1;
  }

  // 5. VCS change gutter (left edge).
  if (config.showVcsChanges && changes.length) {
    for (const c of changes) {
      ctx.fillStyle = cssVar(`--openidea-change-${c.kind}`, accent);
      const yStart = Math.floor(rowMap.rowOf(c.line)) * lineH - offset;
      if (c.kind === "deleted") {
        ctx.fillRect(0, yStart - 1, 5, 2);
      } else {
        const yEnd = Math.floor(rowMap.rowOf(c.lastLine)) * lineH - offset;
        ctx.fillRect(0, yStart, 3, Math.max(lineH, yEnd - yStart + lineH));
      }
    }
  }

  // 6. Problem markers (right edge, highest severity on top).
  if (config.showProblems && problems.length) {
    const ranked = [...problems].sort((a, b) => (PROBLEM_RANK[a.severity] || 0) - (PROBLEM_RANK[b.severity] || 0));
    for (const p of ranked) {
      ctx.fillStyle = cssVar(PROBLEM_COLORS[p.severity] || "--openidea-fg-muted", muted);
      const yStart = Math.floor(rowMap.rowOf(p.line)) * lineH - offset;
      const yEnd = Math.floor(rowMap.rowOf(p.lastLine)) * lineH - offset;
      ctx.fillRect(W - 3, yStart, 3, Math.max(lineH, yEnd - yStart + lineH));
    }
  }

  // 7. Viewport frame indicator.
  const activeAlpha = drag ? 0.2 : hovering ? 0.12 : 0.07;
  const strokeAlpha = drag ? 0.92 : hovering ? 0.65 : 0.42;
  if (config.viewportStyle === "shaded") {
    ctx.fillStyle = accent;
    ctx.globalAlpha = activeAlpha;
    ctx.fillRect(0, top, W, height);
    ctx.strokeStyle = accent;
    ctx.globalAlpha = strokeAlpha;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, top + 0.5, W - 1, height - 1);
  } else if (config.viewportStyle === "outline") {
    ctx.strokeStyle = accent;
    ctx.globalAlpha = strokeAlpha;
    ctx.lineWidth = 1.25;
    ctx.strokeRect(0.625, top + 0.625, W - 1.25, height - 1.25);
  } else {
    // Minimal: crisp edge rails only.
    ctx.fillStyle = accent;
    ctx.globalAlpha = strokeAlpha;
    ctx.fillRect(0, top, 2, height);
    ctx.fillRect(W - 2, top, 2, height);
  }
  ctx.globalAlpha = 1;

  if (canDrawTokens && missingHighlights.length) {
    void loadHighlights(missingHighlights[0], missingHighlights[missingHighlights.length - 1] + 1);
  }
  if (softWrap && !wrappedRows && !loadingWrapped && lines.length <= config.maxLines) {
    void loadWrapped();
  }
}

async function loadHighlights(fromLine, toLine) {
  if (!editor) return;
  const key = `${fromLine}:${toLine}`;
  if (loadingHighlights.has(key)) return;
  loadingHighlights.add(key);
  const version = target && target.version;
  try {
    for (let at = fromLine; at < toLine; at += CHUNK) {
      const batch = await editor.highlights(at, Math.min(toLine, at + CHUNK));
      if (!target || target.version !== version) return;
      batch.forEach((spans, idx) => colors.set(at + idx, spans));
    }
  } catch {
    // Ignore stale target errors mid-switch.
  } finally {
    loadingHighlights.delete(key);
  }
  if (target && target.version === version) {
    redraw();
    if (!lensEl.hidden && activeLensLine !== null && pointerY !== null) {
      renderLens(activeLensLine, pointerY);
    }
  }
}

async function loadWrapped() {
  if (!editor || typeof editor.wrapped !== "function" || loadingWrapped || !softWrap) return;
  loadingWrapped = true;
  const version = target && target.version;
  try {
    const out = new Array(lines.length);
    for (let at = 0; at < lines.length; at += CHUNK) {
      const counts = await editor.wrapped(at, Math.min(lines.length, at + CHUNK));
      if (!counts || !target || target.version !== version) return;
      for (let i = 0; i < counts.length; i++) out[at + i] = counts[i];
    }
    if (target && target.version === version) {
      wrappedRows = out;
      rebuildRowMap();
      redraw();
    }
  } catch {
    // Ignore if target changed mid-request.
  } finally {
    loadingWrapped = false;
  }
}

async function reload() {
  if (!editor) return;
  const current = await editor.get();
  target = current;
  colors = new Map();
  loadingHighlights.clear();
  wrappedRows = null;
  hideLens();
  if (!current) {
    lines = [];
    regions = [];
    folds = [];
    softWrap = false;
    problems = [];
    selections = [];
    changes = [];
    view = null;
    rebuildRowMap();
    redraw();
    return;
  }
  try {
    const [doc, vp, probs, foldedList, wrapProbe, sels, diffs] = await Promise.all([
      editor.document.get(),
      editor.viewport(),
      editor.problems ? editor.problems() : Promise.resolve([]),
      editor.folded ? editor.folded() : Promise.resolve([]),
      typeof editor.wrapped === "function" ? editor.wrapped(0, 1) : Promise.resolve(null),
      editor.selections ? editor.selections() : Promise.resolve([]),
      editor.changes ? editor.changes() : Promise.resolve([]),
    ]);
    if (!target || target.version !== current.version) return;
    lines = doc.text.split("\n");
    regions = extractRegions(lines);
    view = vp;
    problems = probs || [];
    folds = foldedList || [];
    softWrap = wrapProbe !== null;
    selections = sels || [];
    changes = diffs || [];
    rebuildRowMap();
    redraw();
  } catch {
    // Ignore aborted load on rapid tab switch.
  }
}

function scrollToFrameTop(frameTop) {
  if (!editor || !view) return;
  const { range, visibleRows, L } = currentLayout();
  const p = Math.min(1, Math.max(0, frameTop / range));
  const targetRow = p * Math.max(0, L - visibleRows);
  void editor.scrollTo(rowMap.lineOfRow(targetRow));
}

function wireEvents() {
  if (!editor) return;
  editor.onTarget(() => void reload());
  editor.document.onChange((doc) => {
    if (target) target = { ...target, version: doc.version };
    lines = doc.text.split("\n");
    regions = extractRegions(lines);
    wrappedRows = null;
    rebuildRowMap();
    redraw();
    if (!lensEl.hidden && pointerY !== null) scheduleLens(pointerY);
  });
  editor.onViewport((v) => {
    view = v;
    redraw();
  });
  editor.onHighlights(({ fromLine, toLine }) => {
    for (const key of colors.keys()) {
      if (key >= fromLine && key < toLine) colors.delete(key);
    }
    redraw();
  });
  if (editor.onProblems) {
    editor.onProblems((p) => {
      problems = p || [];
      redraw();
    });
  }
  if (editor.onLayout) {
    editor.onLayout((l) => {
      folds = (l && l.folded) || [];
      softWrap = !!(l && l.softWrap);
      wrappedRows = null;
      rebuildRowMap();
      redraw();
    });
  }
  if (editor.onSelections) {
    editor.onSelections((s) => {
      selections = s || [];
      redraw();
    });
  }
  if (editor.onChanges) {
    editor.onChanges((c) => {
      changes = c || [];
      redraw();
    });
  }
  if (window.openidea && window.openidea.onThemeChange) {
    window.openidea.onThemeChange(redraw);
  }
  if (window.openidea && window.openidea.onMessage) {
    window.openidea.onMessage((raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg && msg.op === "config" && msg.config) {
          config = { ...config, ...msg.config };
          updateHudButtons();
          if (!config.showHoverLens) hideLens();
          redraw();
        }
      } catch {
        // Ignore unrelated plugin messages.
      }
    });
  }

  new ResizeObserver(() => {
    redraw();
    if (!lensEl.hidden && pointerY !== null) scheduleLens(pointerY);
  }).observe(canvas);

  canvas.addEventListener("pointerdown", (e) => {
    if (!view || e.button !== 0) return;
    hideLens();
    const { top, height } = currentLayout();
    const grab = e.offsetY >= top && e.offsetY <= top + height ? e.offsetY - top : height / 2;
    drag = { grab };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointer capture.
    }
    scrollToFrameTop(e.offsetY - grab);
    redraw();
  });

  canvas.addEventListener("pointermove", (e) => {
    pointerInBounds = true;
    hovering = true;
    if (drag) {
      scrollToFrameTop(e.offsetY - drag.grab);
      return;
    }
    scheduleLens(e.offsetY);
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    redraw();
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    pointerInBounds = false;
    hovering = false;
    hideLens();
    redraw();
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      hideLens();
      void editor.scrollBy(e.deltaY);
    },
    { passive: false },
  );

  cleanBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.openidea.postMessage(JSON.stringify({ op: "toggle-clean" }));
  });
  lensBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.openidea.postMessage(JSON.stringify({ op: "toggle-hover-lens" }));
  });
}

updateHudButtons();
wireEvents();
if (window.openidea && window.openidea.postMessage) {
  window.openidea.postMessage(JSON.stringify({ op: "ready" }));
}
void reload();
