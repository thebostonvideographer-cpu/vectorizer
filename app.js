import { removeBackground } from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";
import {
  openFullEditor,
  blobToBase64,
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

let currentFile = null;
let sourceUrl = null;
let resultUrl = null;
let resultBlob = null;
let baseName = "trace";
let busy = false;

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
  toleranceVal.textContent = toleranceEl.value;
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

/**
 * Logo cutout tuned for white backgrounds + white face fills:
 * 1) clear outer bg from edges
 * 2) clear only SMALL enclosed whites (letter holes) — keep large face whites
 * 3) choke pale anti-alias fringe so there's no jagged halo
 */
async function removeSolidBackground(file, tolerance) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageElement(url);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imageData;
    const total = width * height;
    const maxHole = Math.floor(total * 0.012); // ~1.2% — letters yes, faces no

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
    const bg = sg / 4;
    const bb = sb / 4;

    const matchesBg = (i, tol = tolerance) =>
      colorDist(data[i], data[i + 1], data[i + 2], br, bg, bb) <= tol;

    const outer = new Uint8Array(total);
    const stack = [];
    const seed = (idx) => {
      if (outer[idx] || !matchesBg(idx * 4)) return;
      outer[idx] = 1;
      stack.push(idx);
    };
    for (let x = 0; x < width; x++) {
      seed(x);
      seed((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      seed(y * width);
      seed(y * width + (width - 1));
    }
    while (stack.length) {
      const idx = stack.pop();
      data[idx * 4 + 3] = 0;
      const x = idx % width;
      const y = (idx / width) | 0;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const nidx = ny * width + nx;
        if (outer[nidx] || !matchesBg(nidx * 4)) continue;
        outer[nidx] = 1;
        stack.push(nidx);
      }
    }

    const holeSeen = new Uint8Array(total);
    for (let idx = 0; idx < total; idx++) {
      if (holeSeen[idx] || outer[idx]) continue;
      const i = idx * 4;
      if (data[i + 3] === 0 || !matchesBg(i)) continue;

      const component = [];
      const q = [idx];
      holeSeen[idx] = 1;
      let touchesEdge = false;
      while (q.length) {
        const cidx = q.pop();
        component.push(cidx);
        const x = cidx % width;
        const y = (cidx / width) | 0;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nidx = ny * width + nx;
          if (holeSeen[nidx] || outer[nidx]) continue;
          const ni = nidx * 4;
          if (data[ni + 3] === 0 || !matchesBg(ni)) continue;
          holeSeen[nidx] = 1;
          q.push(nidx);
        }
      }
      if (!touchesEdge && component.length <= maxHole) {
        for (const cidx of component) data[cidx * 4 + 3] = 0;
      }
    }

    // Choke pale fringe only (keeps navy/yellow ink intact)
    for (let pass = 0; pass < 3; pass++) {
      const doomed = [];
      for (let idx = 0; idx < total; idx++) {
        const i = idx * 4;
        if (data[i + 3] === 0) continue;
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const nearBg = matchesBg(i, tolerance * 1.35) || lum >= 205;
        if (!nearBg) continue;
        const x = idx % width;
        const y = (idx / width) | 0;
        let nextToClear = false;
        for (const [nx, ny] of [
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (data[(ny * width + nx) * 4 + 3] === 0) {
            nextToClear = true;
            break;
          }
        }
        if (nextToClear) doomed.push(idx);
      }
      for (const idx of doomed) data[idx * 4 + 3] = 0;
    }

    for (let i = 3; i < data.length; i += 4) {
      data[i] = data[i] ? 255 : 0;
    }

    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Export failed"))), "image/png");
    });
    return blob;
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
  adobeBtn.disabled = false;
}

async function openInAdobeExpress() {
  const source = resultBlob || currentFile;
  if (!source) {
    setStatus("Process or upload an image first.", "error");
    return;
  }

  const { clientId } = getAdobeConfig();
  if (!clientId || clientId === "YOUR_ID") {
    setStatus(
      "Add your Adobe clientId in adobe-config.js, allow-list this HTTPS domain, then redeploy.",
      "error"
    );
    return;
  }

  if (location.protocol !== "https:" && location.hostname !== "localhost") {
    setStatus("Adobe Express requires HTTPS (Cloudflare deploy is fine).", "error");
    return;
  }

  busy = true;
  adobeBtn.disabled = true;
  processBtn.disabled = true;
  setStatus("Opening Adobe Express Full Editor…", "busy");

  try {
    const base64 = await blobToBase64(source);
    await openFullEditor(base64, {
      onSave: async ({ base64: outBase64 }) => {
        const blob = base64ToBlob(outBase64, "image/png");
        showResult(blob);
        setStatus(`Saved from Adobe Express · ${formatBytes(blob.size)}`);
      },
      onCancel: () => {
        setStatus("Adobe Express closed without saving.");
      },
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
    adobeBtn.disabled = !resultBlob && !currentFile;
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
  adobeBtn.disabled = true;
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
      setStatus("Punching out solid background…", "busy");
      blob = await removeSolidBackground(currentFile, Number(toleranceEl.value));
      setStatus(`Done · logo mode · ${formatBytes(blob.size)}`);
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
adobeBtn.addEventListener("click", () => {
  openInAdobeExpress().catch((err) => {
    console.error(err);
    setStatus(err.message || "Could not open Adobe Express.", "error");
  });
});
modeEl.addEventListener("change", () => {
  syncModeUi();
  if (currentFile) processCurrent();
});
toleranceEl.addEventListener("input", () => {
  toleranceVal.textContent = toleranceEl.value;
});

syncModeUi();
