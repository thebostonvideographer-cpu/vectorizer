import { removeBackground } from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";
import {
  openFullEditor,
  base64ToBlob,
  getAdobeConfig,
} from "./adobe-express.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const sampleBtn = document.getElementById("sample-btn");
const workspace = document.getElementById("workspace");
const fileNameEl = document.getElementById("file-name");
const fileSizeEl = document.getElementById("file-size");
const sourcePreview = document.getElementById("source-preview");
const resultPreview = document.getElementById("result-preview");
const downloadBtn = document.getElementById("download-btn");
const replaceBtn = document.getElementById("replace-btn");
const processBtn = document.getElementById("process-btn");
const adobeBtn = document.getElementById("adobe-btn");
const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const toleranceEl = document.getElementById("tolerance");
const toleranceVal = document.getElementById("tolerance-val");
const toleranceField = document.getElementById("tolerance-field");
const scaleField = document.getElementById("scale-field");
const supersampleEl = document.getElementById("supersample");
const guideTools = document.getElementById("guide-tools");
const markCanvas = document.getElementById("mark-canvas");
const sourceFrame = document.getElementById("source-frame");
const brushSizeEl = document.getElementById("brush-size");
const brushSizeVal = document.getElementById("brush-size-val");
const clearMarksBtn = document.getElementById("clear-marks-btn");
const keepColorsEl = document.getElementById("keep-colors");
const keepColorInput = document.getElementById("keep-color-input");
const addKeepColorBtn = document.getElementById("add-keep-color-btn");
const pickKeepColorBtn = document.getElementById("pick-keep-color-btn");
const clearKeepColorsBtn = document.getElementById("clear-keep-colors-btn");
const keepSwatchesEl = document.getElementById("keep-swatches");

const MARK_KEEP = 1;
const MARK_CUT = 2;
const KEEP_COLOR_TOL = 34;
const MAX_LABELS = 40000;

let currentFile = null;
let sourceUrl = null;
let resultUrl = null;
let resultBlob = null;
let baseName = "trace";
let busy = false;

/** @type {HTMLImageElement | null} */
let sourceImageEl = null;
/** Natural-resolution mark map: 0 none, 1 keep, 2 cut */
let markMap = null;
let markW = 0;
let markH = 0;
let brushMode = "keep";
let painting = false;
/** @type {{ r: number, g: number, b: number }[]} */
let keepColors = [];
let pickingKeepColor = false;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showWorkspace() {
  dropzone.classList.add("hidden");
  workspace.classList.remove("hidden");
}

function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

function syncModeUi() {
  const logo = modeEl.value === "logo";
  toleranceField.style.display = logo ? "" : "none";
  if (scaleField) scaleField.style.display = logo ? "" : "none";
  if (guideTools) guideTools.style.display = logo ? "" : "none";
  if (keepColorsEl) keepColorsEl.style.display = logo ? "" : "none";
  toleranceVal.textContent = toleranceEl.value;
  if (markCanvas) {
    markCanvas.style.pointerEvents = logo ? "auto" : "none";
    markCanvas.classList.toggle("picking", logo && pickingKeepColor);
  }
  if (!logo && pickingKeepColor) setPickingKeepColor(false);
}

function rgbCss({ r, g, b }) {
  return `rgb(${r}, ${g}, ${b})`;
}

function colorsNearlyEqual(a, b, tol = 8) {
  return colorDist(a.r, a.g, a.b, b.r, b.g, b.b) <= tol;
}

function renderKeepSwatches() {
  if (!keepSwatchesEl) return;
  keepSwatchesEl.replaceChildren();
  keepColors.forEach((c, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "keep-swatch";
    btn.style.background = rgbCss(c);
    btn.title = `Remove ${rgbCss(c)}`;
    btn.setAttribute("aria-label", `Remove keep color ${rgbCss(c)}`);
    btn.addEventListener("click", () => {
      keepColors.splice(i, 1);
      renderKeepSwatches();
    });
    keepSwatchesEl.appendChild(btn);
  });
}

function addKeepColor(color) {
  const c = {
    r: Math.round(color.r),
    g: Math.round(color.g),
    b: Math.round(color.b),
  };
  if (keepColors.some((k) => colorsNearlyEqual(k, c))) return;
  keepColors.push(c);
  renderKeepSwatches();
}

function clearKeepColors() {
  keepColors = [];
  renderKeepSwatches();
  setStatus("Keep colors cleared.");
}

function setPickingKeepColor(on) {
  pickingKeepColor = !!on;
  pickKeepColorBtn?.classList.toggle("active", pickingKeepColor);
  if (markCanvas) markCanvas.classList.toggle("picking", pickingKeepColor && modeEl.value === "logo");
  if (pickingKeepColor) {
    setStatus("Click the original image to sample a keep color.");
  }
}

function sampleColorAt(naturalX, naturalY) {
  const img = sourceImageEl || sourcePreview;
  if (!img?.naturalWidth) return null;
  const sx = Math.min(img.naturalWidth - 1, Math.max(0, Math.floor(naturalX)));
  const sy = Math.min(img.naturalHeight - 1, Math.max(0, Math.floor(naturalY)));
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, sx, sy, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * Plan working resolution. Prefer keeping the requested supersample (2/4/6×);
 * for huge photos, shrink the base first so 6× still runs (old code silently
 * dropped 6→2→1, so Edge quality looked identical).
 */
function planWorkSize(naturalW, naturalH, requested) {
  const scale = Math.max(1, Math.min(6, Number(requested) || 2));
  const maxWorkPixels = 18_000_000;
  let baseW = naturalW;
  let baseH = naturalH;
  let baseShrunk = false;
  if (baseW * baseH * scale * scale > maxWorkPixels) {
    const maxBase = Math.max(1, Math.floor(maxWorkPixels / (scale * scale)));
    const t = Math.sqrt(maxBase / (baseW * baseH));
    baseW = Math.max(1, Math.round(naturalW * t));
    baseH = Math.max(1, Math.round(naturalH * t));
    baseShrunk = true;
  }
  return {
    baseW,
    baseH,
    scale,
    workW: baseW * scale,
    workH: baseH * scale,
    outW: naturalW,
    outH: naturalH,
    baseShrunk,
  };
}

/** Dilate a binary mask by `radius` pixels (chessboard / square kernel). */
function dilateMask(src, width, height, radius) {
  if (radius <= 0) return src;
  let cur = src;
  for (let pass = 0; pass < radius; pass++) {
    const out = new Uint8Array(cur.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (cur[idx]) {
          out[idx] = 1;
          continue;
        }
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            if (cur[ny * width + nx]) {
              hit = true;
              break;
            }
          }
        }
        if (hit) out[idx] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

function initMarkMap(w, h) {
  markW = w;
  markH = h;
  markMap = new Uint8Array(w * h);
  syncMarkCanvasSize();
  redrawMarkOverlay();
}

function clearMarks() {
  if (!markMap) return;
  markMap.fill(0);
  redrawMarkOverlay();
  setStatus("Marks cleared.");
}

function syncMarkCanvasSize() {
  if (!markCanvas || !sourcePreview) return;
  // Match the displayed image box exactly (not the taller letterboxed frame).
  const rect = sourcePreview.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(1, Math.round(rect.width));
  const cssH = Math.max(1, Math.round(rect.height));
  markCanvas.style.left = "0";
  markCanvas.style.top = "0";
  markCanvas.style.width = "100%";
  markCanvas.style.height = "100%";
  markCanvas.width = Math.max(1, Math.round(cssW * dpr));
  markCanvas.height = Math.max(1, Math.round(cssH * dpr));
}

function redrawMarkOverlay() {
  if (!markCanvas || !markMap || !markW) return;
  syncMarkCanvasSize();
  const ctx = markCanvas.getContext("2d");
  const { width: cw, height: ch } = markCanvas;
  ctx.clearRect(0, 0, cw, ch);

  // Draw marks into an offscreen buffer at natural size, then scale up
  const off = document.createElement("canvas");
  off.width = markW;
  off.height = markH;
  const octx = off.getContext("2d");
  const imgData = octx.createImageData(markW, markH);
  const px = imgData.data;
  for (let i = 0; i < markMap.length; i++) {
    const m = markMap[i];
    if (!m) continue;
    const p = i * 4;
    if (m === MARK_KEEP) {
      px[p] = 40;
      px[p + 1] = 200;
      px[p + 2] = 100;
      px[p + 3] = 150;
    } else if (m === MARK_CUT) {
      px[p] = 220;
      px[p + 1] = 50;
      px[p + 2] = 50;
      px[p + 3] = 150;
    }
  }
  octx.putImageData(imgData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, cw, ch);
}

function pointerToImageCoords(e) {
  // Map against the image element — same box the canvas is overlaid on.
  const rect = sourcePreview.getBoundingClientRect();
  if (!rect.width || !rect.height || !markW || !markH) return { x: 0, y: 0 };
  const x = ((e.clientX - rect.left) / rect.width) * markW;
  const y = ((e.clientY - rect.top) / rect.height) * markH;
  return {
    x: Math.min(markW, Math.max(0, x)),
    y: Math.min(markH, Math.max(0, y)),
  };
}

function stampMark(cx, cy, mode, radius) {
  if (!markMap) return;
  const r = Math.max(1, radius);
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(markW - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(markH - 1, Math.ceil(cy + r));
  const value = mode === "keep" ? MARK_KEEP : mode === "cut" ? MARK_CUT : 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      markMap[y * markW + x] = value;
    }
  }
}

function setBrushMode(mode) {
  brushMode = mode;
  document.querySelectorAll(".btn.brush").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.brush === mode);
  });
}

/** Map natural-resolution marks → working canvas (nearest neighbor). */
function upsampleMarks(workW, workH) {
  const keep = new Uint8Array(workW * workH);
  const cut = new Uint8Array(workW * workH);
  if (!markMap || !markW || !markH) return { keep, cut };
  for (let y = 0; y < workH; y++) {
    const sy = Math.min(markH - 1, Math.floor((y / workH) * markH));
    for (let x = 0; x < workW; x++) {
      const sx = Math.min(markW - 1, Math.floor((x / workW) * markW));
      const m = markMap[sy * markW + sx];
      const idx = y * workW + x;
      if (m === MARK_KEEP) keep[idx] = 1;
      else if (m === MARK_CUT) cut[idx] = 1;
    }
  }
  return { keep, cut };
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image."));
    img.src = src;
  });
}

function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function neighbors4(idx, width, height) {
  const x = idx % width;
  const y = (idx / width) | 0;
  const out = [];
  if (x + 1 < width) out.push(idx + 1);
  if (x > 0) out.push(idx - 1);
  if (y + 1 < height) out.push(idx + width);
  if (y > 0) out.push(idx - width);
  return out;
}

function morphMax3(src, width, height) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          m = Math.max(m, src[ny * width + nx]);
        }
      }
      out[y * width + x] = m;
    }
  }
  return out;
}

function morphMin3(src, width, height) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let m = 255;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          m = Math.min(m, src[ny * width + nx]);
        }
      }
      out[y * width + x] = m;
    }
  }
  return out;
}

/**
 * Logo cutout with optional Keep/Cut guide marks + supersample.
 * @param {File|Blob} file
 * @param {{ tolerance: number, scale?: number }} opts
 */
async function removeSolidBackground(file, opts) {
  const tolerance = Math.max(1, Math.min(90, Number(opts.tolerance) || 42));
  const requestedScale = opts.scale ?? 2;
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    sourceImageEl = img;
    if (!markMap || markW !== img.naturalWidth || markH !== img.naturalHeight) {
      initMarkMap(img.naturalWidth, img.naturalHeight);
    }

    const plan = planWorkSize(img.naturalWidth, img.naturalHeight, requestedScale);
    const { scale, workW: width, workH: height, baseShrunk } = plan;
    let { keep: keepMask, cut: cutMask } = upsampleMarks(width, height);
    // Grow Keep strokes so a scribble fills more of the face; Cut stays tight
    keepMask = dilateMask(keepMask, width, height, Math.max(2, Math.round(scale * 2)));
    cutMask = dilateMask(cutMask, width, height, Math.max(1, Math.round(scale * 0.5)));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Could not create canvas for cutout.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch {
      throw new Error("Image too large for this browser — try 2× edge quality.");
    }
    const { data } = imageData;
    const total = width * height;

    const corners = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ];
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (const [x, y] of corners) {
      const i = (y * width + x) * 4;
      sr += data[i];
      sg += data[i + 1];
      sb += data[i + 2];
    }
    const br = sr / 4;
    const bgc = sg / 4;
    const bb = sb / 4;

    const dist = new Float32Array(total);
    const lum = new Float32Array(total);
    const sat = new Float32Array(total);
    let ink = new Uint8Array(total);
    for (let idx = 0; idx < total; idx++) {
      const i = idx * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const d = colorDist(r, g, b, br, bgc, bb);
      dist[idx] = d;
      lum[idx] = (r + g + b) / 3;
      sat[idx] = Math.max(r, g, b) - Math.min(r, g, b);
      // Dark/saturated = ink barrier. Do NOT mark Keep as ink (that blocked face fills).
      ink[idx] = d > tolerance ? 255 : 0;
    }

    ink = morphMax3(ink, width, height);
    ink = morphMax3(ink, width, height);
    ink = morphMin3(ink, width, height);
    ink = morphMin3(ink, width, height);

    // Hard ink = dark enough to stop Keep/Cut floods (face outlines, letter strokes)
    const hardInk = new Uint8Array(total);
    for (let idx = 0; idx < total; idx++) {
      hardInk[idx] = ink[idx] && lum[idx] < 170 ? 1 : 0;
      // Cut must never punch holes in letter ink / outlines
      if (hardInk[idx]) cutMask[idx] = 0;
    }

    // Low tolerance + noise → huge component counts. Cap to avoid OOM / hang.
    const MAX_LABELS = 50000;
    const labels = new Int32Array(total);
    const sizes = [0];
    let nextLabel = 1;
    let labelOverflow = false;
    for (let idx = 0; idx < total; idx++) {
      if (ink[idx] || labels[idx]) continue;
      if (nextLabel > MAX_LABELS) {
        labelOverflow = true;
        const overflowLab = nextLabel++;
        sizes[overflowLab] = 0;
        for (let j = idx; j < total; j++) {
          if (!ink[j] && !labels[j]) {
            labels[j] = overflowLab;
            sizes[overflowLab]++;
          }
        }
        break;
      }
      const lab = nextLabel++;
      sizes[lab] = 0;
      const stack = [idx];
      labels[idx] = lab;
      while (stack.length) {
        const cur = stack.pop();
        sizes[lab]++;
        for (const nidx of neighbors4(cur, width, height)) {
          if (labels[nidx] || ink[nidx]) continue;
          labels[nidx] = lab;
          stack.push(nidx);
        }
      }
    }

    const border = new Set();
    for (let x = 0; x < width; x++) {
      if (labels[x]) border.add(labels[x]);
      if (labels[(height - 1) * width + x]) border.add(labels[(height - 1) * width + x]);
    }
    for (let y = 0; y < height; y++) {
      if (labels[y * width]) border.add(labels[y * width]);
      if (labels[y * width + width - 1]) border.add(labels[y * width + width - 1]);
    }
    // Overflow bucket is treated as background so cutout still completes
    if (labelOverflow && nextLabel > 1) border.add(nextLabel - 1);

    const cutLabs = new Set();
    for (let idx = 0; idx < total; idx++) {
      if (cutMask[idx] && labels[idx] && !keepMask[idx]) cutLabs.add(labels[idx]);
    }

    const interior = [];
    for (let lab = 1; lab < nextLabel; lab++) {
      if (!border.has(lab) && !cutLabs.has(lab)) interior.push({ lab, size: sizes[lab] });
    }
    interior.sort((a, b) => b.size - a.size);

    const faceLabs = new Set(
      interior.filter((c) => c.size >= 1200 * scale * scale).slice(0, 3).map((c) => c.lab)
    );

    // KEEP FLOOD: from Keep brush, fill light areas until hard ink (faces / white text)
    const protectedKeep = new Uint8Array(total);
    {
      const stack = [];
      for (let idx = 0; idx < total; idx++) {
        if (!keepMask[idx]) continue;
        protectedKeep[idx] = 1;
        stack.push(idx);
      }
      while (stack.length) {
        const cur = stack.pop();
        for (const nidx of neighbors4(cur, width, height)) {
          if (protectedKeep[nidx] || cutMask[nidx] || hardInk[nidx]) continue;
          // Spread through pale / near-bg (face fills, white letter bodies)
          if (lum[nidx] < 185 && dist[nidx] > tolerance * 1.1) continue;
          protectedKeep[nidx] = 1;
          stack.push(nidx);
        }
      }
    }

    // AUTO letter-fill in O(pixels) — old per-label full scans hung at low tolerance.
    if (!labelOverflow && nextLabel < 40000) {
      const maxCounter = Math.floor(total * 0.003);
      const maxFill = 8000 * scale * scale;
      const minFill = 40 * scale * scale;
      const paleN = new Uint32Array(nextLabel);
      const inkN = new Uint32Array(nextLabel);
      const sampleN = new Uint32Array(nextLabel);

      for (let idx = 0; idx < total; idx++) {
        const lab = labels[idx];
        if (!lab || border.has(lab) || cutLabs.has(lab)) continue;
        const size = sizes[lab];
        if (size <= 0 || size > maxFill) continue;
        if (sampleN[lab] >= 6000) continue;
        sampleN[lab]++;
        if (lum[idx] >= 190 || dist[idx] <= tolerance * 1.15) paleN[lab]++;
        for (const nidx of neighbors4(idx, width, height)) {
          if (hardInk[nidx]) {
            inkN[lab]++;
            break;
          }
        }
      }

      const keepLabs = new Set();
      for (let lab = 1; lab < nextLabel; lab++) {
        const counted = sampleN[lab];
        if (!counted) continue;
        const size = sizes[lab];
        if (size <= maxCounter) continue;
        const paleRatio = paleN[lab] / counted;
        const inkRatio = inkN[lab] / counted;
        if (paleRatio > 0.65 && inkRatio > 0.35 && size >= minFill) keepLabs.add(lab);
      }
      if (keepLabs.size) {
        for (let idx = 0; idx < total; idx++) {
          if (keepLabs.has(labels[idx]) && !cutMask[idx]) protectedKeep[idx] = 1;
        }
      }
    }

    const face = new Uint8Array(total);
    for (let idx = 0; idx < total; idx++) {
      if (faceLabs.has(labels[idx]) || protectedKeep[idx]) face[idx] = 1;
    }

    const alpha = new Uint8Array(total);
    for (let idx = 0; idx < total; idx++) {
      if (protectedKeep[idx] || hardInk[idx]) {
        alpha[idx] = 1;
        continue;
      }
      if (cutMask[idx]) {
        alpha[idx] = 0;
        continue;
      }
      const lab = labels[idx];
      if (!lab) {
        alpha[idx] = 1;
        continue;
      }
      if (border.has(lab) || cutLabs.has(lab)) {
        alpha[idx] = 0;
        continue;
      }
      alpha[idx] = faceLabs.has(lab) ? 1 : 0;
    }

    // CUT FLOOD through light pixels — never into protected Keep
    {
      const stack = [];
      const seen = new Uint8Array(total);
      for (let idx = 0; idx < total; idx++) {
        if (!cutMask[idx] || protectedKeep[idx]) continue;
        stack.push(idx);
        seen[idx] = 1;
        alpha[idx] = 0;
      }
      while (stack.length) {
        const cur = stack.pop();
        for (const nidx of neighbors4(cur, width, height)) {
          if (seen[nidx] || protectedKeep[nidx] || hardInk[nidx]) continue;
          if (dist[nidx] > tolerance * 1.35 && lum[nidx] < 195) continue;
          seen[nidx] = 1;
          alpha[nidx] = 0;
          stack.push(nidx);
        }
      }
    }

    // Force keep after cut flood
    for (let idx = 0; idx < total; idx++) {
      if (protectedKeep[idx]) alpha[idx] = 1;
    }

    const touchesClear = (idx) => {
      for (const nidx of neighbors4(idx, width, height)) {
        if (!alpha[nidx]) return true;
      }
      return false;
    };

    // Aggressive pale-fringe choke — kills the white halo around the seal
    for (let pass = 0; pass < 18; pass++) {
      const doomed = [];
      for (let idx = 0; idx < total; idx++) {
        if (!alpha[idx] || protectedKeep[idx] || face[idx] || !touchesClear(idx)) continue;
        const light =
          (lum[idx] >= 100 && sat[idx] <= 85) ||
          (dist[idx] <= tolerance * 1.8 && lum[idx] >= 95) ||
          (dist[idx] <= tolerance * 1.15 && sat[idx] <= 100);
        if (light) doomed.push(idx);
      }
      for (const idx of doomed) alpha[idx] = 0;
    }

    // Extra erode on near-bg edge pixels (AA fringe), skip faces/keep
    for (let pass = 0; pass < 2; pass++) {
      const eroded = new Uint8Array(alpha);
      for (let idx = 0; idx < total; idx++) {
        if (!alpha[idx] || protectedKeep[idx] || face[idx]) continue;
        if (!touchesClear(idx)) continue;
        if (lum[idx] >= 90 || dist[idx] <= tolerance * 1.4) eroded[idx] = 0;
      }
      for (let idx = 0; idx < total; idx++) alpha[idx] = eroded[idx];
    }

    // Keep wins again after choke (interior only — do not dilate outward)
    for (let idx = 0; idx < total; idx++) {
      if (protectedKeep[idx]) alpha[idx] = 1;
    }

    // Hard alpha: soft fringe was the halo. Only tiny partial on true mid-tones.
    const soft = new Uint8ClampedArray(total);
    for (let idx = 0; idx < total; idx++) {
      if (!alpha[idx]) {
        soft[idx] = 0;
        continue;
      }
      if (protectedKeep[idx] || face[idx] || !touchesClear(idx)) {
        soft[idx] = 255;
        continue;
      }
      // Edge pixel: drop pale AA entirely; keep only darker ink edge
      if (lum[idx] >= 110 || dist[idx] <= tolerance * 1.25) {
        soft[idx] = 0;
        continue;
      }
      soft[idx] = 255;
    }

    // Despill remaining edge ink into nearby dark color (no pale ghost)
    for (let idx = 0; idx < total; idx++) {
      if (!soft[idx] || protectedKeep[idx] || face[idx] || !touchesClear(idx) || lum[idx] < 70) {
        continue;
      }
      const x = idx % width;
      const y = (idx / width) | 0;
      let bestR = 0;
      let bestG = 0;
      let bestB = 0;
      let found = false;
      for (const r of [1, 2, 3]) {
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let n = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const nidx = ny * width + nx;
            if (!soft[nidx] || lum[nidx] >= 80) continue;
            const ni = nidx * 4;
            sumR += data[ni];
            sumG += data[ni + 1];
            sumB += data[ni + 2];
            n++;
          }
        }
        if (n) {
          bestR = sumR / n;
          bestG = sumG / n;
          bestB = sumB / n;
          found = true;
          break;
        }
      }
      const i = idx * 4;
      if (found) {
        data[i] = bestR;
        data[i + 1] = bestG;
        data[i + 2] = bestB;
      } else if (lum[idx] >= 100) {
        soft[idx] = 0;
      }
    }

    for (let idx = 0; idx < total; idx++) {
      if (protectedKeep[idx]) soft[idx] = 255;
      data[idx * 4 + 3] = soft[idx];
    }
    ctx.putImageData(imageData, 0, 0);

    const out = document.createElement("canvas");
    out.width = img.naturalWidth;
    out.height = img.naturalHeight;
    const octx = out.getContext("2d");
    if (!octx) throw new Error("Could not create export canvas.");
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(canvas, 0, 0, out.width, out.height);

    const blob = await new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed"))), "image/png");
    });
    return { blob, scale, baseShrunk, labelOverflow };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Harden soft AI alpha so logo-like areas don't go ghostly. */
async function hardenAiAlpha(blob, cutoff = 128) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageElement(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;
    for (let i = 3; i < data.length; i += 4) {
      data[i] = data[i] >= cutoff ? 255 : 0;
    }
    ctx.putImageData(imageData, 0, 0);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function showResult(blob) {
  revoke(resultUrl);
  resultBlob = blob;
  resultUrl = URL.createObjectURL(blob);
  const img = document.createElement("img");
  img.src = resultUrl;
  img.alt = "Transparent cutout";
  img.style.maxWidth = "100%";
  img.style.maxHeight = "420px";
  img.style.display = "block";
  resultPreview.replaceChildren(img);
  downloadBtn.disabled = false;
  if (adobeBtn) adobeBtn.disabled = false;
}

async function openInAdobeExpress() {
  const source = resultBlob || currentFile;
  if (!source) {
    setStatus("Process or upload an image first.", "error");
    return;
  }
  const { clientId } = getAdobeConfig();
  if (!clientId || clientId === "YOUR_ID") {
    setStatus("Add Adobe clientId in adobe-config.js, then redeploy.", "error");
    return;
  }
  busy = true;
  if (adobeBtn) adobeBtn.disabled = true;
  processBtn.disabled = true;
  setStatus("Opening Adobe Express Full Editor…", "busy");
  try {
    await openFullEditor(source, {
      onSave: async ({ base64: outBase64 }) => {
        const blob = base64ToBlob(outBase64, "image/png");
        showResult(blob);
        setStatus(`Saved from Adobe Express · ${formatBytes(blob.size)}`);
      },
      onCancel: () => setStatus("Adobe Express closed without saving."),
      onError: (err) => {
        console.error(err);
        setStatus(err.message || "Adobe Express error.", "error");
      },
    });
    setStatus("Edit in Adobe Express — Save to bring the PNG back here.", "busy");
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Could not open Adobe Express.", "error");
  } finally {
    busy = false;
    if (adobeBtn) adobeBtn.disabled = !resultBlob && !currentFile;
    processBtn.disabled = false;
  }
}

async function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Please choose a JPEG, PNG, or WebP image.", "error");
    return;
  }

  currentFile = file;
  revoke(sourceUrl);
  sourceUrl = URL.createObjectURL(file);
  baseName = (file.name || "trace").replace(/\.[^.]+$/, "") || "trace";

  fileNameEl.textContent = file.name || "Untitled";
  fileSizeEl.textContent = formatBytes(file.size);
  sourcePreview.src = sourceUrl;
  resultPreview.replaceChildren();
  downloadBtn.disabled = true;
  if (adobeBtn) adobeBtn.disabled = true;
  markMap = null;

  await new Promise((resolve) => {
    if (sourcePreview.complete && sourcePreview.naturalWidth) {
      resolve();
      return;
    }
    sourcePreview.onload = () => resolve();
  });
  initMarkMap(sourcePreview.naturalWidth, sourcePreview.naturalHeight);

  showWorkspace();
  await processCurrent();
}

async function processCurrent() {
  if (!currentFile || busy) return;

  busy = true;
  downloadBtn.disabled = true;
  processBtn.disabled = true;

  try {
    let blob;
    if (modeEl.value === "logo") {
      const requested = Number(supersampleEl?.value || 2);
      setStatus(
        requested >= 6
          ? "Guided cutout at 6×… may take a bit"
          : requested >= 4
            ? "Guided cutout at 4×… may take a few seconds"
            : "Guided cutout…",
        "busy"
      );
      const result = await removeSolidBackground(currentFile, {
        tolerance: Number(toleranceEl.value),
        scale: requested,
      });
      blob = result.blob;
      const used = result.scale;
      const notes = [];
      if (result.baseShrunk) notes.push("large image: base shrunk, supersample kept");
      if (result.labelOverflow) notes.push("tolerance very low — used safe mode");
      setStatus(
        `Done · logo · ${used}× smooth · ${formatBytes(blob.size)}${
          notes.length ? ` (${notes.join("; ")})` : ""
        }`
      );
    } else {
      setStatus("AI cutout… first run may download a model", "busy");
      const raw = await removeBackground(currentFile, {
        model: "isnet_fp16",
        output: { format: "image/png", quality: 0.9 },
        progress: (key, current, total) => {
          if (!total) return;
          setStatus(`Working… ${key} ${Math.round((current / total) * 100)}%`, "busy");
        },
      });
      blob = await hardenAiAlpha(raw, 140);
      setStatus(`Done · photo mode · ${formatBytes(blob.size)}`);
    }
    showResult(blob);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Background removal failed.", "error");
  } finally {
    busy = false;
    processBtn.disabled = false;
  }
}

function downloadPng() {
  if (!resultBlob) return;
  const a = document.createElement("a");
  a.href = resultUrl;
  a.download = `${baseName}-transparent.png`;
  a.click();
}

async function loadSample() {
  // White-background logo-style sample
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 420;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, 640, 420);
  ctx.fillStyle = "#0f7a5f";
  ctx.beginPath();
  ctx.arc(320, 180, 100, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#14201c";
  ctx.font = "700 48px Georgia, serif";
  ctx.textAlign = "center";
  ctx.fillText("THREE SONS", 320, 340);
  ctx.font = "500 20px sans-serif";
  ctx.fillText("Windows · Remodeling · More", 320, 375);

  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Sample failed"))), "image/png");
  });
  modeEl.value = "logo";
  syncModeUi();
  await loadFile(new File([pngBlob], "sample-logo.png", { type: "image/png" }));
}

["dragenter", "dragover"].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((type) => {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    if (type === "dragleave") dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (e) => {
  dropzone.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  fileInput.value = "";
});

sampleBtn.addEventListener("click", () => {
  loadSample().catch((err) => {
    console.error(err);
    setStatus("Could not load sample.", "error");
  });
});

replaceBtn.addEventListener("click", () => fileInput.click());
downloadBtn.addEventListener("click", downloadPng);
processBtn.addEventListener("click", () => processCurrent());
if (adobeBtn) {
  adobeBtn.addEventListener("click", () => {
    openInAdobeExpress().catch((err) => {
      console.error(err);
      setStatus(err.message || "Could not open Adobe Express.", "error");
    });
  });
}
modeEl.addEventListener("change", () => {
  syncModeUi();
  if (currentFile) processCurrent();
});
toleranceEl.addEventListener("input", () => {
  toleranceVal.textContent = toleranceEl.value;
});

document.querySelectorAll(".btn.brush").forEach((btn) => {
  btn.addEventListener("click", () => setBrushMode(btn.dataset.brush));
});
brushSizeEl?.addEventListener("input", () => {
  if (brushSizeVal) brushSizeVal.textContent = brushSizeEl.value;
});
clearMarksBtn?.addEventListener("click", () => clearMarks());

function onPaintPointer(e) {
  if (!painting || !markMap || modeEl.value !== "logo") return;
  e.preventDefault();
  const { x, y } = pointerToImageCoords(e);
  const radius =
    (Number(brushSizeEl?.value || 24) * markW) /
    Math.max(1, sourcePreview.getBoundingClientRect().width);
  stampMark(x, y, brushMode, radius);
  redrawMarkOverlay();
}

markCanvas?.addEventListener("pointerdown", (e) => {
  if (modeEl.value !== "logo") return;
  painting = true;
  markCanvas.setPointerCapture(e.pointerId);
  onPaintPointer(e);
});
markCanvas?.addEventListener("pointermove", onPaintPointer);
markCanvas?.addEventListener("pointerup", () => {
  painting = false;
});
markCanvas?.addEventListener("pointercancel", () => {
  painting = false;
});

window.addEventListener("resize", () => {
  if (markMap) redrawMarkOverlay();
});

setBrushMode("keep");
syncModeUi();
