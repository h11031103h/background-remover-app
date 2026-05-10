const imageInput = document.querySelector("#imageInput");
const downloadButton = document.querySelector("#downloadButton");
const downloadAllButton = document.querySelector("#downloadAllButton");
const resetButton = document.querySelector("#resetButton");
const toleranceInput = document.querySelector("#tolerance");
const featherInput = document.querySelector("#feather");
const selectionRadiusInput = document.querySelector("#selectionRadius");
const toleranceValue = document.querySelector("#toleranceValue");
const featherValue = document.querySelector("#featherValue");
const selectionRadiusValue = document.querySelector("#selectionRadiusValue");
const undoPickButton = document.querySelector("#undoPickButton");
const clearPickButton = document.querySelector("#clearPickButton");
const batchPanel = document.querySelector("#batchPanel");
const batchCounter = document.querySelector("#batchCounter");
const imageList = document.querySelector("#imageList");
const prevImageButton = document.querySelector("#prevImageButton");
const nextImageButton = document.querySelector("#nextImageButton");
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
let restoreMask = null;
let manualHistory = [];
let sourceName = "transparent-background.png";
let imageItems = [];
let currentImageIndex = -1;
let renderTimer = null;
let isSelecting = false;
let selectionChanged = false;
let lastSelectionAt = 0;

const defaults = {
  tolerance: 42,
  feather: 3,
  selectionRadius: 80,
  sampleMode: "auto",
  viewMode: "result",
  pickMode: "off",
};

function getErrorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return "unknown error";
}

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
  return !!(
    manualMask &&
    (manualMask.some((value) => value > 0) || restoreMask.some((value) => value > 0))
  );
}

function updateManualButtons() {
  undoPickButton.disabled = manualHistory.length === 0;
  clearPickButton.disabled = !hasManualMask();
  dropZone.classList.toggle("pick-active", getSelected("pickMode") !== "off" && !!sourceImageData);
}

function updateBatchControls() {
  const hasImages = imageItems.length > 0;
  const hasMultiple = imageItems.length > 1;
  downloadButton.disabled = !hasImages;
  downloadAllButton.disabled = !hasImages;
  resetButton.disabled = !hasImages;
  batchPanel.hidden = !hasImages;
  prevImageButton.disabled = !hasMultiple || currentImageIndex <= 0;
  nextImageButton.disabled = !hasMultiple || currentImageIndex >= imageItems.length - 1;
  batchCounter.textContent = hasImages ? `${currentImageIndex + 1} / ${imageItems.length}` : "0 / 0";
}

function renderImageList() {
  imageList.replaceChildren();
  imageItems.forEach((item, index) => {
    const button = document.createElement("button");
    button.className = `image-chip${index === currentImageIndex ? " is-active" : ""}`;
    button.type = "button";
    button.textContent = `${index + 1}. ${item.displayName}`;
    button.title = item.displayName;
    button.addEventListener("click", () => setActiveImage(index));
    imageList.append(button);
  });
}

function syncCurrentItem() {
  if (currentImageIndex < 0 || !imageItems[currentImageIndex]) return;
  const item = imageItems[currentImageIndex];
  item.resultImageData = resultImageData;
  item.manualMask = manualMask;
  item.restoreMask = restoreMask;
  item.manualHistory = manualHistory;
}

function setActiveImage(index) {
  if (!imageItems[index]) return;
  syncCurrentItem();
  currentImageIndex = index;
  const item = imageItems[index];
  sourceImageData = item.sourceImageData;
  resultImageData = item.resultImageData;
  manualMask = item.manualMask;
  restoreMask = item.restoreMask;
  manualHistory = item.manualHistory;
  sourceName = item.outputName;
  canvas.width = item.width;
  canvas.height = item.height;
  dropZone.classList.add("has-image");
  updateBatchControls();
  renderImageList();
  processImage();
}

function scheduleRender() {
  updateReadouts();
  updateManualButtons();
  updateBatchControls();
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

function loadBitmapWithFallback(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file).catch(() => loadImageElement(file));
  }
  return loadImageElement(file);
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("この画像形式をブラウザで読み込めませんでした。PNG、JPEG、WebPで試してください。"));
    };
    image.src = url;
  });
}

async function createImageItem(file) {
  if (!file || !file.type.startsWith("image/")) {
    throw new Error("画像ファイルを選んでください。");
  }

  const bitmap = await loadBitmapWithFallback(file);
  const size = resizeToFit(bitmap.width, bitmap.height);
  sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = size.width;
  sourceCanvas.height = size.height;
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceCtx.drawImage(bitmap, 0, 0, size.width, size.height);
  const sourceData = sourceCtx.getImageData(0, 0, size.width, size.height);
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  return {
    displayName: file.name,
    outputName: `${baseName}-transparent.png`,
    sourceImageData: sourceData,
    resultImageData: null,
    manualMask: new Uint8Array(size.width * size.height),
    restoreMask: new Uint8Array(size.width * size.height),
    manualHistory: [],
    width: size.width,
    height: size.height,
    scaled: size.scaled,
  };
}

async function loadImages(fileList) {
  const files = Array.from(fileList || []).filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) {
    setStatus("画像ファイルを選んでください。", true);
    return;
  }

  setStatus(`${files.length}枚の画像を読み込んでいます。`);
  const loaded = [];
  const failed = [];
  for (const file of files) {
    try {
      loaded.push(await createImageItem(file));
    } catch (error) {
      failed.push(`${file.name}: ${getErrorMessage(error)}`);
    }
  }

  if (loaded.length === 0) {
    setStatus("画像を読み込めませんでした。PNG、JPEG、WebPで試してください。", true);
    return;
  }

  imageItems = loaded;
  currentImageIndex = -1;
  dropZone.classList.add("has-image");
  setSelected("viewMode", "result");
  setActiveImage(0);
  const scaledCount = loaded.filter((item) => item.scaled).length;
  if (failed.length > 0) {
    setStatus(`${loaded.length}枚を読み込みました。${failed.length}枚は読み込めませんでした。`, true);
  } else if (loaded.length > 1 && scaledCount > 0) {
    setStatus(`${loaded.length}枚を読み込みました。${scaledCount}枚は長辺2800pxに縮小して処理しています。`);
  } else if (loaded.length > 1) {
    setStatus(`${loaded.length}枚を読み込みました。`);
  }
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

function applyRestoreMask(target, source) {
  if (!source) return target;
  for (let i = 0; i < target.length; i++) {
    if (source[i] > 0) target[i] = Math.min(target[i], 255 - source[i]);
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
  if (!manualMask || !restoreMask) return;
  manualHistory.push({
    manualMask: new Uint8Array(manualMask),
    restoreMask: new Uint8Array(restoreMask),
  });
  if (manualHistory.length > MAX_MANUAL_HISTORY) manualHistory.shift();
  updateManualButtons();
}

function editPickedArea(seedX, seedY, mode) {
  if (!sourceImageData || !manualMask || !restoreMask) return 0;
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
    const targetMask = mode === "restore" ? restoreMask : manualMask;
    const otherMask = mode === "restore" ? manualMask : restoreMask;
    if (strength > targetMask[index] || otherMask[index] > 0) {
      if (targetMask[index] === 0 && otherMask[index] === 0) changed += 1;
      targetMask[index] = Math.max(targetMask[index], strength);
      otherMask[index] = 0;
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

function createProcessedImageData(item) {
  const tolerance = Number(toleranceInput.value);
  const feather = Number(featherInput.value);
  const sampleMode = getSelected("sampleMode");
  const { width, height, data } = item.sourceImageData;
  const combinedMask = addMask(buildBackgroundMask(item.sourceImageData, tolerance, sampleMode), item.manualMask);
  const mask = applyRestoreMask(featherMask(combinedMask, width, height, feather), item.restoreMask);
  const output = new ImageData(new Uint8ClampedArray(data), width, height);

  for (let i = 0; i < mask.length; i++) {
    const alpha = output.data[i * 4 + 3];
    output.data[i * 4 + 3] = Math.max(0, Math.round(alpha * (1 - mask[i] / 255)));
  }

  const removed = Math.round((mask.reduce((sum, value) => sum + (value > 0 ? 1 : 0), 0) / mask.length) * 100);
  return { output, removed };
}

function processImage() {
  if (!sourceImageData || currentImageIndex < 0) return;
  syncCurrentItem();
  const viewMode = getSelected("viewMode");
  const item = imageItems[currentImageIndex];

  if (viewMode === "original") {
    ctx.putImageData(sourceImageData, 0, 0);
    setStatus(`元画像を表示しています。${imageItems.length > 1 ? `（${currentImageIndex + 1}/${imageItems.length}）` : ""}`);
    updateManualButtons();
    updateBatchControls();
    return;
  }

  setStatus("背景を透過しています。");
  const { output, removed } = createProcessedImageData(item);
  resultImageData = output;
  item.resultImageData = output;
  ctx.putImageData(output, 0, 0);
  setStatus(`背景候補を約${removed}%透過しました。${imageItems.length > 1 ? `（${currentImageIndex + 1}/${imageItems.length}）` : ""}`);
  updateManualButtons();
  updateBatchControls();
}

function canvasBlob(targetCanvas, type = "image/png") {
  return new Promise((resolve) => {
    targetCanvas.toBlob((blob) => resolve(blob), type);
  });
}

async function downloadResult() {
  if (!sourceImageData || currentImageIndex < 0) return;
  clearTimeout(renderTimer);
  const previousView = getSelected("viewMode");
  setSelected("viewMode", "result");
  processImage();
  const blob = await canvasBlob(canvas, "image/png");
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sourceName;
    link.click();
    URL.revokeObjectURL(url);
  if (previousView !== "result") setSelected("viewMode", previousView);
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function getCrcTable() {
  if (getCrcTable.table) return getCrcTable.table;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  getCrcTable.table = table;
  return table;
}

function crc32(bytes) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function createZip(files) {
  const encoder = new TextEncoder();
  const now = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, now.time);
    writeUint16(localView, 12, now.day);
    writeUint32(localView, 14, crc);
    writeUint32(localView, 18, data.length);
    writeUint32(localView, 22, data.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, now.time);
    writeUint16(centralView, 14, now.day);
    writeUint32(centralView, 16, crc);
    writeUint32(centralView, 20, data.length);
    writeUint32(centralView, 24, data.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralSize);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

async function pngBytesForItem(item) {
  const { output } = createProcessedImageData(item);
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = item.width;
  outputCanvas.height = item.height;
  outputCanvas.getContext("2d").putImageData(output, 0, 0);
  const blob = await canvasBlob(outputCanvas, "image/png");
  return new Uint8Array(await blob.arrayBuffer());
}

async function downloadAllResults() {
  if (imageItems.length === 0) return;
  clearTimeout(renderTimer);
  syncCurrentItem();
  downloadAllButton.disabled = true;
  setStatus(`${imageItems.length}枚をまとめて処理しています。`);
  const files = [];
  for (let i = 0; i < imageItems.length; i++) {
    setStatus(`${i + 1}/${imageItems.length}枚目を処理しています。`);
    files.push({
      name: imageItems[i].outputName,
      data: await pngBytesForItem(imageItems[i]),
    });
  }
  const zipBlob = createZip(files);
  const url = URL.createObjectURL(zipBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "transparent-images.zip";
  link.click();
  URL.revokeObjectURL(url);
  downloadAllButton.disabled = false;
  setStatus(`${imageItems.length}枚をZIPにまとめました。`);
  processImage();
}

function resetControls() {
  toleranceInput.value = defaults.tolerance;
  featherInput.value = defaults.feather;
  selectionRadiusInput.value = defaults.selectionRadius;
  setSelected("sampleMode", defaults.sampleMode);
  setSelected("viewMode", defaults.viewMode);
  setSelected("pickMode", defaults.pickMode);
  if (manualMask) manualMask.fill(0);
  if (restoreMask) restoreMask.fill(0);
  manualHistory = [];
  syncCurrentItem();
  scheduleRender();
}

function undoPick() {
  if (!manualMask || manualHistory.length === 0) return;
  const previous = manualHistory.pop();
  manualMask = previous.manualMask;
  restoreMask = previous.restoreMask;
  syncCurrentItem();
  setSelected("viewMode", "result");
  processImage();
}

function clearPicks() {
  if (!manualMask || !hasManualMask()) return;
  pushManualHistory();
  manualMask.fill(0);
  restoreMask.fill(0);
  syncCurrentItem();
  setSelected("viewMode", "result");
  processImage();
}

function applyManualSelection(event, immediate = false) {
  const point = getCanvasPoint(event);
  if (!point) return;
  const mode = getSelected("pickMode");
  if (mode === "off") return;
  const changed = editPickedArea(point.x, point.y, mode);
  if (changed === 0) return;

  selectionChanged = true;
  setSelected("viewMode", "result");
  updateManualButtons();
  if (immediate) {
    processImage();
    setStatus(mode === "restore" ? "選択部分の背景を戻しました。" : "選択部分を追加で透過しました。");
  } else {
    scheduleRender();
  }
}

imageInput.addEventListener("change", (event) => {
  loadImages(event.target.files).catch(() => {
    setStatus("画像を読み込めませんでした。PNG、JPEG、WebPで試してください。", true);
  }).finally(() => {
    imageInput.value = "";
  });
});

imageInput.addEventListener("click", () => {
  imageInput.value = "";
});

window.addEventListener("error", (event) => {
  if (sourceImageData) return;
  setStatus(`アプリ初期化でエラーが出ています: ${event.message}`, true);
});

window.addEventListener("unhandledrejection", (event) => {
  if (sourceImageData) return;
  setStatus(`画像処理でエラーが出ています: ${getErrorMessage(event.reason)}`, true);
});

downloadButton.addEventListener("click", downloadResult);
downloadAllButton.addEventListener("click", downloadAllResults);
resetButton.addEventListener("click", resetControls);
undoPickButton.addEventListener("click", undoPick);
clearPickButton.addEventListener("click", clearPicks);
prevImageButton.addEventListener("click", () => setActiveImage(currentImageIndex - 1));
nextImageButton.addEventListener("click", () => setActiveImage(currentImageIndex + 1));
toleranceInput.addEventListener("input", scheduleRender);
featherInput.addEventListener("input", scheduleRender);
selectionRadiusInput.addEventListener("input", updateReadouts);
document.querySelectorAll('input[name="sampleMode"], input[name="viewMode"], input[name="pickMode"]').forEach((input) => {
  input.addEventListener("change", scheduleRender);
});

canvas.addEventListener("pointerdown", (event) => {
  if (getSelected("pickMode") === "off" || !sourceImageData) return;
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
  loadImages(event.dataTransfer.files).catch(() => {
    setStatus("画像を読み込めませんでした。別のファイルで試してください。", true);
  });
});

updateReadouts();
updateBatchControls();
