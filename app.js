const imageInput = document.querySelector("#imageInput");
const downloadButton = document.querySelector("#downloadButton");
const resetButton = document.querySelector("#resetButton");
const restoreBackgroundButton = document.querySelector("#restoreBackgroundButton");
const toleranceInput = document.querySelector("#tolerance");
const featherInput = document.querySelector("#feather");
const selectionRadiusInput = document.querySelector("#selectionRadius");
const toleranceValue = document.querySelector("#toleranceValue");
const featherValue = document.querySelector("#featherValue");
const selectionRadiusValue = document.querySelector("#selectionRadiusValue");
const undoPickButton = document.querySelector("#undoPickButton");
const clearPickButton = document.querySelector("#clearPickButton");
const dropZone = document.querySelector("#dropZone");
const statusLine = document.querySelector("#status");
const canvas = document.querySelector("#previewCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const MAX_SIDE = 2800;
const MAX_MANUAL_HISTORY = 12;
let sourceCanvas = null;
let sourceImageData = null;
let resultImageData = null;
let manualMask = null;
let manualHistory = [];
let sourceName = "transparent-background.png";
let renderTimer = null;
let isSelecting = false;
let selectionChanged = false;
let lastSelectionAt = 0;
let transparencyEnabled = true;

const defaults = {
  tolerance: 42,
  feather: 3,
  selectionRadius: 80,
  sampleMode: "auto",
  viewMode: "result",
  pickMode: "off",
  transparencyEnabled: true,
};

function setStatus(message, isWarning = false) {
  statusLine.textContent = message;
  statusLine.classList.toggle("warning", isWarning);
}

function updateReadouts() {
  toleranceValue.value = toleranceInput.value;
  featherValue.value = featherInput.value;
  selectionRadiusValue.value = selectionRadiusInput.value;
}

function getSelected(name) {
  return document.querySelector(`input[name="${name}"]:checked`).value;
}

function setSelected(name, value) {
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function hasManualMask() {
  return manualMask ? manualMask.some((value) => value > 0) : false;
}

function updateManualButtons() {
  undoPickButton.disabled = manualHistory.length === 0;
  clearPickButton.disabled = !hasManualMask();
  restoreBackgroundButton.disabled = !sourceImageData;
  restoreBackgroundButton.textContent = transparencyEnabled ? "背景を戻す" : "背景を透過";
  dropZone.classList.toggle("pick-active", getSelected("pickMode") === "remove" && !!sourceImageData);
}

function scheduleRender() {
  updateReadouts();
  updateManualButtons();
  if (!sourceImageData) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(processImage, 70);
}

function resizeToFit(width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: scale < 1,
  };
}

async function loadImage(file) {
  if (!file || !file.type.startsWith("image/")) {
    setStatus("画像ファイルを選んでください。", true);
    return;
  }

  const bitmap = await createImageBitmap(file);
  const size = resizeToFit(bitmap.width, bitmap.height);
  sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = size.width;
  sourceCanvas.height = size.height;
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceCtx.drawImage(bitmap, 0, 0, size.width, size.height);
  sourceImageData = sourceCtx.getImageData(0, 0, size.width, size.height);
  manualMask = new Uint8Array(size.width * size.height);
  manualHistory = [];
  transparencyEnabled = true;
  sourceName = file.name.replace(/\.[^.]+$/, "") + "-transparent.png";
  canvas.width = size.width;
  canvas.height = size.height;
  dropZone.classList.add("has-image");
  downloadButton.disabled = false;
  resetButton.disabled = false;
  setStatus(size.scaled ? "大きな画像のため、長辺2800pxに縮小して処理しています。" : "背景を検出しています。");
  updateManualButtons();
  processImage();
}

function colorAt(data, width, x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
}

function collectEdgeSamples(data, width, height, mode) {
  const samples = [];
  const stride = Math.max(1, Math.floor(Math.min(width, height) / 80));

  if (mode === "corner") {
    const inset = Math.max(2, Math.floor(Math.min(width, height) * 0.035));
    const corners = [
      [inset, inset],
      [width - inset - 1, inset],
      [inset, height - inset - 1],
      [width - inset - 1, height - inset - 1],
    ];
    for (const [cx, cy] of corners) {
      for (let y = Math.max(0, cy - inset); y <= Math.min(height - 1, cy + inset); y += stride) {
        for (let x = Math.max(0, cx - inset); x <= Math.min(width - 1, cx + inset); x += stride) {
          samples.push(colorAt(data, width, x, y));
        }
      }
    }
    return samples;
  }

  for (let x = 0; x < width; x += stride) {
    samples.push(colorAt(data, width, x, 0), colorAt(data, width, x, height - 1));
  }
  for (let y = 0; y < height; y += stride) {
    samples.push(colorAt(data, width, 0, y), colorAt(data, width, width - 1, y));
  }
  return samples;
}

function quantizedKey(color) {
  return color.map((value) => Math.round(value / 24) * 24).join(",");
}

function estimateBackground(samples) {
  const buckets = new Map();
  for (const sample of samples) {
    const key = quantizedKey(sample);
    if (!buckets.has(key)) buckets.set(key, { count: 0, color: [0, 0, 0] });
    const bucket = buckets.get(key);
    bucket.count += 1;
    bucket.color[0] += sample[0];
    bucket.color[1] += sample[1];
    bucket.color[2] += sample[2];
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket;
  }

  if (!best) return [255, 255, 255];
  return best.color.map((value) => value / best.count);
}

function buildBackgroundMask(imageData, tolerance, sampleMode) {
  const { data, width, height } = imageData;
  const mask = new Uint8Array(width * height);
  const queue = [];
  const samples = collectEdgeSamples(data, width, height, sampleMode);
  const bgColor = estimateBackground(samples);
  const hardLimit = tolerance;
  const softLimit = tolerance + 24;

  function enqueue(x, y) {
    const index = y * width + x;
    if (mask[index]) return;
    const distance = colorDistance(colorAt(data, width, x, y), bgColor);
    if (distance <= hardLimit) {
      mask[index] = 255;
      queue.push(index);
    } else if (distance <= softLimit) {
      mask[index] = Math.max(mask[index], Math.round(255 * (1 - (distance - hardLimit) / 24)));
    }
  }

  for (let x = 0; x < width; x++) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(x - 1, y);
    if (x < width - 1) enqueue(x + 1, y);
    if (y > 0) enqueue(x, y - 1);
    if (y < height - 1) enqueue(x, y + 1);
  }

  return mask;
}

function addMask(target, source) {
  if (!source) return target;
  for (let i = 0; i < target.length; i++) {
    if (source[i] > target[i]) target[i] = source[i];
  }
  return target;
}

function featherMask(mask, width, height, radius) {
  if (radius <= 0) return mask;
  const output = new Uint8Array(mask);
  const radiusSq = radius * radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (mask[index] === 255) continue;
      let strongest = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || dx * dx + dy * dy > radiusSq) continue;
          const nearby = mask[yy * width + xx];
          if (nearby > 0) {
            const distance = Math.sqrt(dx * dx + dy * dy);
            strongest = Math.max(strongest, nearby * (1 - distance / (radius + 1)));
          }
        }
      }
      output[index] = Math.max(output[index], strongest);
    }
  }

  return output;
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  return { x, y };
}

function pushManualHistory() {
  if (!manualMask) return;
  manualHistory.push(new Uint8Array(manualMask));
  if (manualHistory.length > MAX_MANUAL_HISTORY) manualHistory.shift();
  updateManualButtons();
}

function addPickedArea(seedX, seedY) {
  if (!sourceImageData || !manualMask) return 0;
  const { data, width, height } = sourceImageData;
  const seedColor = colorAt(data, width, seedX, seedY);
  const tolerance = Number(toleranceInput.value);
  const radius = Number(selectionRadiusInput.value);
  const radiusSq = radius * radius;
  const softLimit = tolerance + 18;
  const seen = new Uint8Array(width * height);
  const queue = [seedY * width + seedX];
  let changed = 0;

  seen[queue[0]] = 1;

  function trySet(index, distance, full) {
    const strength = full ? 255 : Math.round(255 * (1 - (distance - tolerance) / 18));
    if (strength > manualMask[index]) {
      if (manualMask[index] === 0) changed += 1;
      manualMask[index] = strength;
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const x = index % width;
    const y = Math.floor(index / width);
    const distanceFromSeed = (x - seedX) * (x - seedX) + (y - seedY) * (y - seedY);
    if (distanceFromSeed > radiusSq) continue;

    const distance = colorDistance(colorAt(data, width, x, y), seedColor);
    if (distance <= tolerance) {
      trySet(index, distance, true);
    } else if (distance <= softLimit) {
      trySet(index, distance, false);
      continue;
    } else {
      continue;
    }

    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nextIndex = ny * width + nx;
      if (seen[nextIndex]) continue;
      seen[nextIndex] = 1;
      queue.push(nextIndex);
    }
  }

  return changed;
}

function processImage() {
  if (!sourceImageData) return;
  const tolerance = Number(toleranceInput.value);
  const feather = Number(featherInput.value);
  const sampleMode = getSelected("sampleMode");
  const viewMode = getSelected("viewMode");

  if (viewMode === "original") {
    ctx.putImageData(sourceImageData, 0, 0);
    setStatus("元画像を表示しています。");
    updateManualButtons();
    return;
  }

  if (!transparencyEnabled) {
    resultImageData = new ImageData(new Uint8ClampedArray(sourceImageData.data), sourceImageData.width, sourceImageData.height);
    ctx.putImageData(resultImageData, 0, 0);
    setStatus("背景を戻しています。PNG保存にも元背景が反映されます。");
    updateManualButtons();
    return;
  }

  setStatus("背景を透過しています。");
  const { width, height, data } = sourceImageData;
  const combinedMask = addMask(buildBackgroundMask(sourceImageData, tolerance, sampleMode), manualMask);
  const mask = featherMask(combinedMask, width, height, feather);
  const output = new ImageData(new Uint8ClampedArray(data), width, height);

  for (let i = 0; i < mask.length; i++) {
    const alpha = output.data[i * 4 + 3];
    output.data[i * 4 + 3] = Math.max(0, Math.round(alpha * (1 - mask[i] / 255)));
  }

  resultImageData = output;
  ctx.putImageData(output, 0, 0);
  const removed = Math.round((mask.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0) / mask.length) * 100);
  setStatus(`背景候補を約${removed}%透過しました。縁が残る場合は背景判定を上げてください。`);
  updateManualButtons();
}

function downloadResult() {
  if (!sourceImageData) return;
  clearTimeout(renderTimer);
  if (getSelected("viewMode") !== "result") {
    setSelected("viewMode", "result");
  }
  processImage();
  ctx.putImageData(resultImageData, 0, 0);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sourceName;
    link.click();
    URL.revokeObjectURL(url);
  }, "image/png");
}

function resetControls() {
  toleranceInput.value = defaults.tolerance;
  featherInput.value = defaults.feather;
  selectionRadiusInput.value = defaults.selectionRadius;
  setSelected("sampleMode", defaults.sampleMode);
  setSelected("viewMode", defaults.viewMode);
  setSelected("pickMode", defaults.pickMode);
  transparencyEnabled = defaults.transparencyEnabled;
  if (manualMask) manualMask.fill(0);
  manualHistory = [];
  scheduleRender();
}

function toggleBackgroundRestore() {
  if (!sourceImageData) return;
  transparencyEnabled = !transparencyEnabled;
  setSelected("viewMode", "result");
  processImage();
}

function undoPick() {
  if (!manualMask || manualHistory.length === 0) return;
  manualMask = manualHistory.pop();
  setSelected("viewMode", "result");
  processImage();
}

function clearPicks() {
  if (!manualMask || !hasManualMask()) return;
  pushManualHistory();
  manualMask.fill(0);
  setSelected("viewMode", "result");
  processImage();
}

function applyManualSelection(event, immediate = false) {
  const point = getCanvasPoint(event);
  if (!point) return;
  const changed = addPickedArea(point.x, point.y);
  if (changed === 0) return;

  selectionChanged = true;
  setSelected("viewMode", "result");
  updateManualButtons();
  if (immediate) {
    processImage();
    setStatus(`選択部分を追加で透過しました。`);
  } else {
    scheduleRender();
  }
}

imageInput.addEventListener("change", (event) => {
  loadImage(event.target.files[0]).catch(() => {
    setStatus("画像を読み込めませんでした。別のファイルで試してください。", true);
  });
});

downloadButton.addEventListener("click", downloadResult);
resetButton.addEventListener("click", resetControls);
restoreBackgroundButton.addEventListener("click", toggleBackgroundRestore);
undoPickButton.addEventListener("click", undoPick);
clearPickButton.addEventListener("click", clearPicks);
toleranceInput.addEventListener("input", scheduleRender);
featherInput.addEventListener("input", scheduleRender);
selectionRadiusInput.addEventListener("input", updateReadouts);
document.querySelectorAll('input[name="sampleMode"], input[name="viewMode"], input[name="pickMode"]').forEach((input) => {
  input.addEventListener("change", scheduleRender);
});

canvas.addEventListener("pointerdown", (event) => {
  if (getSelected("pickMode") !== "remove" || !sourceImageData) return;
  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  pushManualHistory();
  isSelecting = true;
  selectionChanged = false;
  lastSelectionAt = performance.now();
  applyManualSelection(event, true);
});

canvas.addEventListener("pointermove", (event) => {
  if (!isSelecting) return;
  event.preventDefault();
  const now = performance.now();
  if (now - lastSelectionAt < 65) return;
  lastSelectionAt = now;
  applyManualSelection(event);
});

function finishManualSelection(event) {
  if (!isSelecting) return;
  if (event) canvas.releasePointerCapture(event.pointerId);
  isSelecting = false;
  if (!selectionChanged) manualHistory.pop();
  processImage();
  updateManualButtons();
}

canvas.addEventListener("pointerup", finishManualSelection);
canvas.addEventListener("pointercancel", finishManualSelection);

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  loadImage(event.dataTransfer.files[0]).catch(() => {
    setStatus("画像を読み込めませんでした。別のファイルで試してください。", true);
  });
});

updateReadouts();
