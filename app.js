import { HybridGpuRenderer } from "./gpu_renderer.js";

const worker = new Worker("./worker.js", { type: "module" });
const gpuRenderer = new HybridGpuRenderer();

const sourceCanvas = document.getElementById("source-canvas");
const resultCanvas = document.getElementById("result-canvas");
const compareSourceCanvas = document.getElementById("compare-source-canvas");
const compareResultCanvas = document.getElementById("compare-result-canvas");
const compareStage = document.getElementById("compare-stage");
const compareOverlay = document.getElementById("compare-overlay");
const compareDivider = document.getElementById("compare-divider");
const compareSlider = document.getElementById("compare-slider");
const compareValue = document.getElementById("compare-value");

const sourceCtx = sourceCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
const resultCtx = resultCanvas.getContext("2d", { alpha: false });
const compareSourceCtx = compareSourceCanvas.getContext("2d", { alpha: false });
const compareResultCtx = compareResultCanvas.getContext("2d", { alpha: false });

const controlsRoot = document.getElementById("controls");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("file-input");
const loadDemoButton = document.getElementById("load-demo");
const exportButton = document.getElementById("export-png");
const resetButton = document.getElementById("reset-params");
const backendSelect = document.getElementById("backend-select");

const MAX_IMAGE_DIM = 1024;

const DEFAULT_PARAMS = {
  radius: 36,
  filterType: "butterworth",
  butterOrder: 2,
  highpassStrength: 1.0,
  weightR: 1.0,
  weightG: 1.0,
  weightB: 1.0,
  kScale: 1.0,
  normalize: true,
  contrast: 1.35,
  threshold: 0.22,
  clipMin: 0.0,
  clipMax: 1.0,
  blur: 0,
  sharpen: 0.0,
};

const CONTROL_SCHEMA = [
  {
    title: "FFT / Filter 参数",
    controls: [
      { key: "radius", label: "R 半径", type: "range", min: 2, max: 280, step: 1 },
      {
        key: "filterType",
        label: "高通类型",
        type: "select",
        options: [
          { value: "butterworth", label: "Butterworth" },
          { value: "ideal", label: "Ideal" },
        ],
      },
      { key: "butterOrder", label: "Butterworth 阶数", type: "range", min: 1, max: 8, step: 1 },
      { key: "highpassStrength", label: "高通强度", type: "range", min: 0.2, max: 3, step: 0.05 },
    ],
  },
  {
    title: "K Algorithm 参数",
    controls: [
      { key: "weightR", label: "R 权重", type: "range", min: 0, max: 2, step: 0.01 },
      { key: "weightG", label: "G 权重", type: "range", min: 0, max: 2, step: 0.01 },
      { key: "weightB", label: "B 权重", type: "range", min: 0, max: 2, step: 0.01 },
      { key: "kScale", label: "K Scale", type: "range", min: 0.1, max: 5, step: 0.05 },
    ],
  },
  {
    title: "Post Processing 参数",
    controls: [
      { key: "normalize", label: "Normalize", type: "checkbox" },
      { key: "contrast", label: "Contrast", type: "range", min: 0.1, max: 3, step: 0.01 },
      { key: "threshold", label: "Threshold", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "clipMin", label: "Clip Min", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "clipMax", label: "Clip Max", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "blur", label: "Blur", type: "range", min: 0, max: 6, step: 1 },
      { key: "sharpen", label: "Sharpen", type: "range", min: 0, max: 3, step: 0.05 },
    ],
  },
];

const params = { ...DEFAULT_PARAMS };
const bindings = new Map();

const LAYER1_KEYS = new Set(["radius", "filterType", "butterOrder", "highpassStrength"]);
const LAYER2_KEYS = new Set(["weightR", "weightG", "weightB", "kScale"]);

let isImageReady = false;
let hasResult = false;
let requestId = 0;
let lastResultId = 0;
let renderTimer = null;
let backendPreference = backendSelect.value;
let activeBackend = "cpu";
let backendToken = 0;
let forceKMapSync = true;

buildControls();
bindEvents();
applyComparePosition(Number(compareSlider.value));
initializeBackend().then(() => loadDemoImage());

worker.onmessage = (event) => {
  const message = event.data;

  if (message.type === "imageReady") {
    isImageReady = true;
    hasResult = false;
    forceKMapSync = true;
    setStatus(
      `图像就绪 ${message.width}x${message.height} | FFT 初始化 ${message.stats.initMs.toFixed(1)}ms | pad ${message.stats.padW}x${message.stats.padH}`
    );
    requestRender("", true);
    return;
  }

  if (message.type === "result") {
    if (message.id < lastResultId) return;
    lastResultId = message.id;

    if (message.kMapBuffer) {
      const kMap = new Float32Array(message.kMapBuffer);
      const uploaded = gpuRenderer.uploadKMap(kMap, message.width, message.height, message.kRange);
      if (!uploaded && activeBackend !== "cpu") {
        activeBackend = "cpu";
        backendSelect.value = "cpu";
        forceKMapSync = false;
        setStatus("GPU 纹理上传失败，已回退 CPU 并重算");
        requestRender("", true);
        return;
      }
    }

    let renderedBy = "CPU";
    let gpuMs = 0;

    if (activeBackend !== "cpu" && gpuRenderer.isReady() && gpuRenderer.hasKMap()) {
      gpuMs = gpuRenderer.render(params);
      drawFromGpuCanvas(message.width, message.height);
      renderedBy = activeBackend.toUpperCase();
    } else if (message.imageBuffer) {
      drawCpuResult(message.width, message.height, message.imageBuffer);
      renderedBy = "CPU";
    } else if (activeBackend !== "cpu") {
      activeBackend = "cpu";
      backendSelect.value = "cpu";
      forceKMapSync = false;
      setStatus("GPU 输出不可用，已回退 CPU 并重算");
      requestRender("", true);
      return;
    }

    hasResult = true;
    const layers = [];
    if (message.stats.recomputed.layer1) layers.push("Layer1");
    if (message.stats.recomputed.layer2) layers.push("Layer2");
    layers.push("Layer3");

    setStatus(
      `输出完成 | 后端 ${renderedBy} | 重算 ${layers.join(" + ")} | 总耗时 ${message.stats.totalMs.toFixed(1)}ms` +
        ` (L1 ${message.stats.layer1Ms.toFixed(1)}ms, L2 ${message.stats.layer2Ms.toFixed(1)}ms, L3 ${message.stats.layer3Ms.toFixed(1)}ms` +
        `${renderedBy !== "CPU" ? `, GPU ${gpuMs.toFixed(1)}ms` : ""})`
    );
    return;
  }

  if (message.type === "error") {
    setStatus(`计算失败: ${message.message}`);
  }
};

function buildControls() {
  const frag = document.createDocumentFragment();
  for (const group of CONTROL_SCHEMA) {
    const section = document.createElement("section");
    section.className = "control-group";

    const title = document.createElement("h3");
    title.textContent = group.title;
    section.appendChild(title);

    for (const control of group.controls) {
      section.appendChild(createControlRow(control));
    }
    frag.appendChild(section);
  }

  controlsRoot.appendChild(frag);
  updateDynamicControlState();
}

function createControlRow(control) {
  if (control.type === "checkbox") {
    const row = document.createElement("label");
    row.className = "checkbox-row";
    row.textContent = control.label;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(params[control.key]);
    input.addEventListener("change", () => {
      params[control.key] = input.checked;
      requestRender(control.key);
    });
    row.appendChild(input);

    bindings.set(control.key, { input, type: "checkbox" });
    return row;
  }

  const row = document.createElement("div");
  row.className = "control-row";

  const head = document.createElement("div");
  head.className = "control-head";
  const label = document.createElement("label");
  label.textContent = control.label;
  label.htmlFor = `input-${control.key}`;
  const value = document.createElement("span");
  value.className = "value-badge";
  value.textContent = formatValue(params[control.key], control.step);
  head.append(label, value);
  row.appendChild(head);

  let input;
  if (control.type === "range") {
    input = document.createElement("input");
    input.type = "range";
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step);
    input.value = String(params[control.key]);
    input.id = `input-${control.key}`;
    input.addEventListener("input", () => {
      params[control.key] = Number(input.value);
      value.textContent = formatValue(params[control.key], control.step);
      guardClipBounds(control.key);
      updateDynamicControlState();
      requestRender(control.key);
    });
  } else if (control.type === "select") {
    input = document.createElement("select");
    input.id = `input-${control.key}`;
    for (const optionDef of control.options) {
      const option = document.createElement("option");
      option.value = optionDef.value;
      option.textContent = optionDef.label;
      input.appendChild(option);
    }
    input.value = String(params[control.key]);
    value.textContent = String(input.options[input.selectedIndex].textContent);
    input.addEventListener("change", () => {
      params[control.key] = input.value;
      value.textContent = String(input.options[input.selectedIndex].textContent);
      updateDynamicControlState();
      requestRender(control.key);
    });
  }

  row.appendChild(input);
  bindings.set(control.key, { input, value, type: control.type, step: control.step, row });
  return row;
}

function bindEvents() {
  fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadImageFromSource(file);
    fileInput.value = "";
  });

  loadDemoButton.addEventListener("click", () => {
    loadDemoImage();
  });

  resetButton.addEventListener("click", () => {
    Object.assign(params, DEFAULT_PARAMS);
    syncControlValues();
    updateDynamicControlState();
    requestRender("", true);
  });

  exportButton.addEventListener("click", () => {
    exportPng();
  });

  compareSlider.addEventListener("input", () => {
    applyComparePosition(Number(compareSlider.value));
  });

  backendSelect.addEventListener("change", async () => {
    backendPreference = backendSelect.value;
    await initializeBackend();
    forceKMapSync = true;
    requestRender("", true);
  });
}

async function initializeBackend() {
  const token = ++backendToken;
  const pref = backendPreference;

  if (pref === "cpu") {
    gpuRenderer.destroy();
    activeBackend = "cpu";
    setStatus("渲染后端: CPU");
    return;
  }

  const result = await gpuRenderer.initialize(pref);
  if (token !== backendToken) return;

  if (result.available) {
    activeBackend = result.backend;
    setStatus(`渲染后端已启用: ${activeBackend.toUpperCase()}`);
  } else {
    activeBackend = "cpu";
    setStatus("GPU 后端不可用，已回退 CPU");
  }
}

async function loadDemoImage() {
  await loadImageFromSource("./test.jpg");
}

async function loadImageFromSource(source) {
  setStatus("正在加载图片...");
  try {
    const image = await loadImageElement(source);
    const target = fitSize(image.naturalWidth || image.width, image.naturalHeight || image.height, MAX_IMAGE_DIM);
    drawSource(image, target.width, target.height);
    initWorkerImage();
  } catch (error) {
    setStatus(`图片加载失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function drawSource(image, width, height) {
  resizeAllCanvases(width, height);

  sourceCtx.clearRect(0, 0, width, height);
  sourceCtx.imageSmoothingEnabled = true;
  sourceCtx.imageSmoothingQuality = "high";
  sourceCtx.drawImage(image, 0, 0, width, height);

  compareSourceCtx.clearRect(0, 0, width, height);
  compareSourceCtx.drawImage(sourceCanvas, 0, 0);

  resultCtx.clearRect(0, 0, width, height);
  compareResultCtx.clearRect(0, 0, width, height);
}

function resizeAllCanvases(width, height) {
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  resultCanvas.width = width;
  resultCanvas.height = height;
  compareSourceCanvas.width = width;
  compareSourceCanvas.height = height;
  compareResultCanvas.width = width;
  compareResultCanvas.height = height;
  compareStage.style.aspectRatio = `${width} / ${height}`;
}

function initWorkerImage() {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const imageData = sourceCtx.getImageData(0, 0, width, height);

  isImageReady = false;
  hasResult = false;
  forceKMapSync = true;
  gpuRenderer.resetKMap();
  setStatus("正在初始化频域缓存...");

  worker.postMessage(
    {
      type: "initImage",
      width,
      height,
      data: imageData.data.buffer,
    },
    [imageData.data.buffer]
  );
}

function requestRender(changedKey = "", force = false) {
  if (!isImageReady) return;

  if (renderTimer !== null) {
    clearTimeout(renderTimer);
  }

  const canLocalGpu =
    !force &&
    changedKey &&
    activeBackend !== "cpu" &&
    gpuRenderer.isReady() &&
    gpuRenderer.hasKMap() &&
    !LAYER1_KEYS.has(changedKey) &&
    !LAYER2_KEYS.has(changedKey);

  const delay = pickDelay(changedKey);
  renderTimer = setTimeout(() => {
    renderTimer = null;

    if (canLocalGpu) {
      const gpuMs = gpuRenderer.render(params);
      drawFromGpuCanvas(sourceCanvas.width, sourceCanvas.height);
      setStatus(`GPU 本地后处理完成 | Layer3 | ${gpuMs.toFixed(1)}ms`);
      hasResult = true;
      return;
    }

    requestId += 1;
    const useGpu = activeBackend !== "cpu" && gpuRenderer.isReady();
    worker.postMessage({
      type: "process",
      id: requestId,
      params: { ...params },
      options: {
        needRgba: !useGpu,
        needKMap: useGpu,
        forceKMap: forceKMapSync,
      },
    });
    forceKMapSync = false;

    if (useGpu) {
      setStatus("正在计算 Layer1/Layer2，Layer3 由 GPU 渲染...");
    } else {
      setStatus("正在计算...");
    }
  }, delay);
}

function pickDelay(changedKey) {
  if (!changedKey) return 40;
  if (LAYER1_KEYS.has(changedKey)) return 140;
  if (LAYER2_KEYS.has(changedKey)) return 70;
  return 20;
}

function drawCpuResult(width, height, buffer) {
  if (resultCanvas.width !== width || resultCanvas.height !== height) {
    resizeAllCanvases(width, height);
  }
  const rgba = new Uint8ClampedArray(buffer);
  const imageData = new ImageData(rgba, width, height);
  resultCtx.putImageData(imageData, 0, 0);
  compareResultCtx.putImageData(imageData, 0, 0);
}

function drawFromGpuCanvas(width, height) {
  if (resultCanvas.width !== width || resultCanvas.height !== height) {
    resizeAllCanvases(width, height);
  }
  resultCtx.clearRect(0, 0, width, height);
  compareResultCtx.clearRect(0, 0, width, height);
  resultCtx.drawImage(gpuRenderer.canvas, 0, 0, width, height);
  compareResultCtx.drawImage(gpuRenderer.canvas, 0, 0, width, height);
}

function applyComparePosition(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  compareOverlay.style.width = `${p}%`;
  compareDivider.style.left = `${p}%`;
  compareValue.textContent = `${p}%`;
}

function exportPng() {
  if (!hasResult) {
    setStatus("当前没有可导出的输出图像");
    return;
  }

  resultCanvas.toBlob((blob) => {
    if (!blob) {
      setStatus("导出失败：无法生成 PNG");
      return;
    }

    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `line-sketch-${stamp}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setStatus("PNG 已导出");
  }, "image/png");
}

function updateDynamicControlState() {
  const orderBinding = bindings.get("butterOrder");
  const isButterworth = params.filterType === "butterworth";
  if (orderBinding?.input) {
    orderBinding.input.disabled = !isButterworth;
    orderBinding.row.style.opacity = isButterworth ? "1" : "0.45";
  }
}

function guardClipBounds(changedKey) {
  if (changedKey !== "clipMin" && changedKey !== "clipMax") return;
  if (params.clipMin <= params.clipMax) return;

  if (changedKey === "clipMin") {
    params.clipMax = params.clipMin;
    updateControlValue("clipMax");
  } else {
    params.clipMin = params.clipMax;
    updateControlValue("clipMin");
  }
}

function syncControlValues() {
  for (const key of bindings.keys()) {
    updateControlValue(key);
  }
}

function updateControlValue(key) {
  const binding = bindings.get(key);
  if (!binding) return;

  if (binding.type === "checkbox") {
    binding.input.checked = Boolean(params[key]);
    return;
  }

  if (binding.type === "select") {
    binding.input.value = String(params[key]);
    if (binding.value) {
      binding.value.textContent = String(binding.input.options[binding.input.selectedIndex].textContent);
    }
    return;
  }

  binding.input.value = String(params[key]);
  if (binding.value) {
    binding.value.textContent = formatValue(params[key], binding.step);
  }
}

function formatValue(value, step = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (step >= 1) return String(Math.round(n));
  const decimals = Math.max(0, String(step).split(".")[1]?.length ?? 0);
  return n.toFixed(Math.min(decimals, 3));
}

function fitSize(width, height, maxDim) {
  const maxEdge = Math.max(width, height);
  if (maxEdge <= maxDim) return { width, height };
  const scale = maxDim / maxEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    let objectUrl = null;

    image.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error("无法解码图像"));
    };

    if (source instanceof File) {
      objectUrl = URL.createObjectURL(source);
      image.src = objectUrl;
    } else {
      image.src = source;
    }
  });
}

function setStatus(text) {
  statusEl.textContent = text;
}
