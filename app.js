import { removeBackground } from "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";

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
const statusEl = document.getElementById("status");

let currentFile = null;
let sourceUrl = null;
let resultUrl = null;
let resultBlob = null;
let baseName = "cutout";
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

async function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("Please choose a JPEG, PNG, or WebP image.", "error");
    return;
  }

  currentFile = file;
  revoke(sourceUrl);
  sourceUrl = URL.createObjectURL(file);
  baseName = (file.name || "cutout").replace(/\.[^.]+$/, "") || "cutout";

  fileNameEl.textContent = file.name || "Untitled";
  fileSizeEl.textContent = formatBytes(file.size);
  sourcePreview.src = sourceUrl;
  resultPreview.replaceChildren();
  downloadBtn.disabled = true;
  showWorkspace();
  await processCurrent();
}

async function processCurrent() {
  if (!currentFile || busy) return;

  busy = true;
  downloadBtn.disabled = true;
  processBtn.disabled = true;
  setStatus("Loading model / removing background…", "busy");

  try {
    const blob = await removeBackground(currentFile, {
      model: "isnet_fp16",
      output: { format: "image/png", quality: 0.9 },
      progress: (key, current, total) => {
        if (!total) return;
        const pct = Math.round((current / total) * 100);
        setStatus(`Working… ${key} ${pct}%`, "busy");
      },
    });

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
    setStatus(`Done · transparent PNG · ${formatBytes(blob.size)}`);
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
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 420;
  const ctx = canvas.getContext("2d");
  // Busy background
  const grad = ctx.createLinearGradient(0, 0, 640, 420);
  grad.addColorStop(0, "#c8ddd4");
  grad.addColorStop(1, "#e8efd8");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 640, 420);
  // Subject
  ctx.fillStyle = "#0f7a5f";
  ctx.beginPath();
  ctx.arc(320, 200, 110, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1d3b32";
  ctx.beginPath();
  ctx.roundRect(230, 280, 180, 100, 24);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 36px Georgia, serif";
  ctx.textAlign = "center";
  ctx.fillText("TRACE", 320, 210);

  const pngBlob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Sample failed"))), "image/png");
  });
  await loadFile(new File([pngBlob], "sample-subject.png", { type: "image/png" }));
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
