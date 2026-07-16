import init, { to_svg } from "./vendor/vtracer/vtracer.js";

const deg2rad = (deg) => (deg / 180) * Math.PI;

const PRESETS = {
  exact: {
    mode: "pixel",
    color: 8,
    speckle: 0,
    layer: 0,
    corner: 180,
  },
  logo: {
    mode: "spline",
    color: 8,
    speckle: 2,
    layer: 8,
    corner: 60,
  },
  balanced: {
    mode: "spline",
    color: 6,
    speckle: 4,
    layer: 16,
    corner: 60,
  },
  photo: {
    mode: "spline",
    color: 7,
    speckle: 8,
    layer: 32,
    corner: 90,
  },
};

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const sampleBtn = document.getElementById("sample-btn");
const workspace = document.getElementById("workspace");
const fileNameEl = document.getElementById("file-name");
const fileSizeEl = document.getElementById("file-size");
const sourcePreview = document.getElementById("source-preview");
const svgPreview = document.getElementById("svg-preview");
const downloadBtn = document.getElementById("download-btn");
const replaceBtn = document.getElementById("replace-btn");
const traceBtn = document.getElementById("trace-btn");
const statusEl = document.getElementById("status");
const presetEl = document.getElementById("preset");
const modeEl = document.getElementById("mode");
const colorEl = document.getElementById("color");
const colorVal = document.getElementById("color-val");
const speckleEl = document.getElementById("speckle");
const speckleVal = document.getElementById("speckle-val");
const layerEl = document.getElementById("layer");
const layerVal = document.getElementById("layer-val");
const cornerEl = document.getElementById("corner");
const cornerVal = document.getElementById("corner-val");
const solidBgEl = document.getElementById("solid-bg");

let objectUrl = null;
let latestSvg = "";
let baseName = "trace";
let tracing = false;
let engineReady = false;
let applyingPreset = false;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ""}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function syncLabels() {
  colorVal.textContent = colorEl.value;
  speckleVal.textContent = speckleEl.value;
  layerVal.textContent = layerEl.value;
  cornerVal.textContent = `${cornerEl.value}°`;
}

function applyPreset(name) {
  const preset = PRESETS[name];
  if (!preset) return;
  applyingPreset = true;
  modeEl.value = preset.mode;
  colorEl.value = String(preset.color);
  speckleEl.value = String(preset.speckle);
  layerEl.value = String(preset.layer);
  cornerEl.value = String(preset.corner);
  syncLabels();
  applyingPreset = false;
}

function buildConfig() {
  const colorUi = Number(colorEl.value);
  const speckleUi = Number(speckleEl.value);
  return {
    binary: false,
    mode: modeEl.value,
    hierarchical: "stacked",
    cornerThreshold: deg2rad(Number(cornerEl.value)),
    lengthThreshold: 3.5,
    maxIterations: 10,
    spliceThreshold: deg2rad(45),
    // Match VTracer webapp: filter is squared; higher UI color = more accurate (lower internal value)
    filterSpeckle: speckleUi * speckleUi,
    colorPrecision: 8 - colorUi,
    layerDifference: Number(layerEl.value),
    pathPrecision: 8,
  };
}

function showWorkspace() {
  dropzone.classList.add("hidden");
  workspace.classList.remove("hidden");
}

function updatePreviewBg() {
  svgPreview.classList.toggle("solid", solidBgEl.checked);
  svgPreview.classList.toggle("checker", !solidBgEl.checked);
}

async function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Please choose a JPEG, PNG, or WebP image.", "error");
    return;
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  baseName = (file.name || "trace").replace(/\.[^.]+$/, "") || "trace";

  fileNameEl.textContent = file.name || "Untitled";
  fileSizeEl.textContent = formatBytes(file.size);
  sourcePreview.src = objectUrl;
  showWorkspace();
  await traceCurrent();
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image."));
    img.src = src;
  });
}

async function traceCurrent() {
  if (!objectUrl || tracing) return;
  if (!engineReady) {
    setStatus("Engine still loading…", "error");
    return;
  }

  tracing = true;
  downloadBtn.disabled = true;
  traceBtn.disabled = true;
  setStatus("Tracing for exact match… this can take a moment", "busy");

  try {
    const img = await loadImageElement(objectUrl);
    // Keep full resolution for fidelity (cap only extreme megapixel shots)
    const maxEdge = 2400;
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    // Flatten onto white so JPEG “background” stays in the SVG
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const pixels = new Uint8Array(data.buffer.slice(0));
    const config = buildConfig();

    await new Promise((r) => setTimeout(r, 30));
    const started = performance.now();
    latestSvg = to_svg(pixels, width, height, config);
    const ms = Math.round(performance.now() - started);

    renderSvgPreview(latestSvg, width, height);

    downloadBtn.disabled = false;
    setStatus(`Done · ${width}×${height}px · ${ms}ms · ${modeEl.value} mode`);
  } catch (err) {
    console.error(err);
    setStatus(err.message || "Trace failed.", "error");
  } finally {
    tracing = false;
    traceBtn.disabled = false;
  }
}

function renderSvgPreview(svgString, fallbackW, fallbackH) {
  // innerHTML chokes on <?xml ...?> and VTracer SVGs often lack viewBox,
  // which makes the preview look blank (only a white crop shows).
  const cleaned = String(svgString)
    .replace(/<\?xml[^?]*\?>/i, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  const doc = new DOMParser().parseFromString(cleaned, "image/svg+xml");
  const svgEl = doc.documentElement;
  const parseError = doc.querySelector("parsererror");
  if (parseError || !svgEl || svgEl.tagName.toLowerCase() !== "svg") {
    throw new Error("Could not render SVG preview.");
  }

  const w = parseFloat(svgEl.getAttribute("width")) || fallbackW;
  const h = parseFloat(svgEl.getAttribute("height")) || fallbackH;
  if (!svgEl.getAttribute("viewBox") && w && h) {
    svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }

  // Keep width/height for download fidelity; preview uses CSS sizing.
  svgEl.setAttribute("width", "100%");
  svgEl.setAttribute("height", "100%");
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svgEl.style.width = "100%";
  svgEl.style.height = "100%";
  svgEl.style.maxHeight = "420px";
  svgEl.style.display = "block";

  svgPreview.replaceChildren(document.importNode(svgEl, true));
}

function downloadSvg() {
  if (!latestSvg) return;
  let payload = latestSvg;
  if (!/viewBox=/i.test(payload)) {
    const widthMatch = payload.match(/\bwidth=["']?(\d+(?:\.\d+)?)["']?/i);
    const heightMatch = payload.match(/\bheight=["']?(\d+(?:\.\d+)?)["']?/i);
    if (widthMatch && heightMatch) {
      payload = payload.replace(
        /<svg\b/i,
        `<svg viewBox="0 0 ${widthMatch[1]} ${heightMatch[1]}"`
      );
    }
  }
  const blob = new Blob([payload], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}.svg`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadSample() {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 420;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0f7a5f";
  ctx.beginPath();
  ctx.arc(180, 210, 96, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1d3b32";
  ctx.beginPath();
  ctx.roundRect(300, 118, 210, 184, 28);
  ctx.fill();
  ctx.fillStyle = "#d9f56b";
  ctx.beginPath();
  ctx.moveTo(420, 150);
  ctx.lineTo(510, 290);
  ctx.lineTo(330, 290);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#14201c";
  ctx.font = "700 42px Georgia, serif";
  ctx.fillText("TRACE", 48, 64);

  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Sample failed"))), "image/png");
  });
  await loadFile(new File([pngBlob], "sample-shapes.png", { type: "image/png" }));
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
downloadBtn.addEventListener("click", downloadSvg);
traceBtn.addEventListener("click", () => traceCurrent());

presetEl.addEventListener("change", () => {
  applyPreset(presetEl.value);
  if (objectUrl) traceCurrent();
});

[modeEl, colorEl, speckleEl, layerEl, cornerEl].forEach((el) => {
  el.addEventListener("input", () => {
    syncLabels();
    if (!applyingPreset && el.tagName === "SELECT" && objectUrl) {
      // mode select: auto re-trace
    }
  });
  el.addEventListener("change", () => {
    syncLabels();
  });
});

solidBgEl.addEventListener("change", updatePreviewBg);

applyPreset("exact");
syncLabels();
updatePreviewBg();

init({ module_or_path: new URL("./vendor/vtracer/vtracer.wasm", import.meta.url) })
  .then(() => {
    engineReady = true;
    setStatus("Ready · Exact match preset");
  })
  .catch((err) => {
    console.error(err);
    setStatus("Failed to load VTracer engine.", "error");
  });
