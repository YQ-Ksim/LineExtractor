import { HybridGpuRenderer } from "./gpu_renderer.js";

const APP_VERSION = "20260325-6";
const worker = new Worker(`./worker.js?v=${APP_VERSION}`, { type: "module" });
const gpuRenderer = new HybridGpuRenderer();

const sourceCanvas = document.getElementById("source-canvas");
const resultCanvas = document.getElementById("result-canvas");

const sourceCtx = sourceCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
const resultCtx = resultCanvas.getContext("2d", { alpha: false });

const controlsRoot = document.getElementById("controls");
const statusEl = document.getElementById("status");
const fileInput = document.getElementById("file-input");
const loadDemoButton = document.getElementById("load-demo");
const exportButton = document.getElementById("export-png");
const resetButton = document.getElementById("reset-params");
const backendSelect = document.getElementById("backend-select");

const MAX_IMAGE_DIM = 1024;

const DEFAULT_PARAMS = {
  radius: 160,
  filterType: "butterworth",
  butterOrder: 2,
  highpassStrength: 0.8,
  normalize: true,
  contrast: 0.8,
  threshold: 0.15,
  clipMin: 0.01,
  clipMax: 1.0,
  blur: 0,
  sharpen: 0.35,
  regionBinarize: false,
  regionTopPercent: 32,
  rankVoteWeight: 0.7,
  rankGrayWeight: 0.3,
  regionMergeEnabled: true,
  regionMergeStrength: 1.0,
  regionMergePasses: 2,
  segLineThreshold: 0.55,
  segLineDenoiseRadius: 1,
  segLineMinArea: 6,
  segDilateRadius: 1,
  useWatershedInit: false,
  wsSeedSpacing: 4,
  wsSeedMinDist: 0.8,
  felzK: 220,
  felzMinSize: 48,
  linePenalty: 1000,
  multiScaleEnabled: false,
  multiScaleKFactor: 2.2,
  multiScaleMinFactor: 2.0,
  crfEnabled: false,
  crfIters: 2,
  crfUnaryWeight: 2.0,
  crfPairWeight: 1.2,
  crfColorSigma: 24,
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
  {
    title: "线稿引导区域二值化",
    controls: [
      { key: "regionBinarize", label: "启用区域排序二值化", type: "checkbox" },
      { key: "regionTopPercent", label: "Top p% 设黑", type: "range", min: 1, max: 99, step: 1 },
      { key: "rankVoteWeight", label: "Vote Score Weight", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "rankGrayWeight", label: "Gray Rank Weight", type: "range", min: 0, max: 1, step: 0.01 },
      { key: "regionMergeEnabled", label: "Merge Similar Small Regions", type: "checkbox" },
      { key: "regionMergeStrength", label: "Merge Strength", type: "range", min: 0, max: 2, step: 0.05 },
      { key: "regionMergePasses", label: "Merge Passes", type: "range", min: 1, max: 4, step: 1 },
      { key: "segLineThreshold", label: "分割前白线二值阈值", type: "range", min: 0.05, max: 0.95, step: 0.01 },
      { key: "segLineDenoiseRadius", label: "线稿降噪半径", type: "range", min: 0, max: 3, step: 1 },
      { key: "segLineMinArea", label: "最小线连通面积", type: "range", min: 0, max: 64, step: 1 },
      { key: "segDilateRadius", label: "线稿膨胀半径", type: "range", min: 0, max: 4, step: 1 },
      { key: "useWatershedInit", label: "Watershed 初分割", type: "checkbox" },
      { key: "wsSeedSpacing", label: "Watershed 种子间距", type: "range", min: 2, max: 24, step: 1 },
      { key: "wsSeedMinDist", label: "Watershed 最小种距", type: "range", min: 0.1, max: 6, step: 0.1 },
      { key: "felzK", label: "Felzenszwalb k", type: "range", min: 1, max: 1000, step: 1 },
      { key: "felzMinSize", label: "最小区域大小", type: "range", min: 0, max: 2000, step: 1 },
      { key: "linePenalty", label: "线稿约束 λ", type: "range", min: 0, max: 2000, step: 1 },
      { key: "multiScaleEnabled", label: "多尺度融合", type: "checkbox" },
      { key: "multiScaleKFactor", label: "粗尺度 k 倍率", type: "range", min: 1, max: 6, step: 0.1 },
      { key: "multiScaleMinFactor", label: "粗尺度 min 倍率", type: "range", min: 1, max: 6, step: 0.1 },
      { key: "crfEnabled", label: "CRF 细化", type: "checkbox" },
      { key: "crfIters", label: "CRF 迭代", type: "range", min: 0, max: 6, step: 1 },
      { key: "crfUnaryWeight", label: "CRF Unary 权重", type: "range", min: 0, max: 6, step: 0.1 },
      { key: "crfPairWeight", label: "CRF Pair 权重", type: "range", min: 0, max: 6, step: 0.1 },
      { key: "crfColorSigma", label: "CRF 颜色 Sigma", type: "range", min: 1, max: 80, step: 1 },
    ],
  },
];

const params = { ...DEFAULT_PARAMS };
const bindings = new Map();
const REGION_DETAIL_KEYS = new Set([
  "regionTopPercent",
  "rankVoteWeight",
  "rankGrayWeight",
  "regionMergeEnabled",
  "regionMergeStrength",
  "regionMergePasses",
  "segLineThreshold",
  "segLineDenoiseRadius",
  "segLineMinArea",
  "segDilateRadius",
  "useWatershedInit",
  "wsSeedSpacing",
  "wsSeedMinDist",
  "felzK",
  "felzMinSize",
  "linePenalty",
  "multiScaleEnabled",
  "multiScaleKFactor",
  "multiScaleMinFactor",
  "crfEnabled",
  "crfIters",
  "crfUnaryWeight",
  "crfPairWeight",
  "crfColorSigma",
]);

const LAYER1_KEYS = new Set(["radius", "filterType", "butterOrder", "highpassStrength"]);
const LAYER2_KEYS = new Set();

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

    if (!params.regionBinarize && activeBackend !== "cpu" && gpuRenderer.isReady() && gpuRenderer.hasKMap()) {
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
    if (message.stats.regionMs > 0) layers.push("Region");

    setStatus(
        `输出完成 | 模式 ${params.regionBinarize ? "区域排序二值化" : "线稿"} | 后端 ${renderedBy}` +
        ` | 重算 ${layers.join(" + ")} | 总耗时 ${message.stats.totalMs.toFixed(1)}ms` +
        ` (L1 ${message.stats.layer1Ms.toFixed(1)}ms, L2 ${message.stats.layer2Ms.toFixed(1)}ms,` +
        ` L3 ${message.stats.layer3Ms.toFixed(1)}ms, Region ${message.stats.regionMs.toFixed(1)}ms` +
        `${
          params.regionBinarize
            ? `, Felz ${message.stats.felzMs.toFixed(1)}ms, E=${message.stats.felzEdgeCount}, R=${message.stats.felzInitialRegions}->${message.stats.felzFinalRegions}, Ws ${message.stats.watershedMs.toFixed(1)}ms, Merge ${message.stats.mergeMs.toFixed(1)}ms, Fuse ${message.stats.fusionMs.toFixed(1)}ms, CRF ${message.stats.crfMs.toFixed(1)}ms`
            : ""
        }` +
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
      updateDynamicControlState();
      requestRender(control.key);
    });
    row.appendChild(input);
    bindings.set(control.key, { input, type: "checkbox", row });
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
      enforceRankWeightSum(control.key);
      updateControlValue(control.key);
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
  resizeCanvases(width, height);
  sourceCtx.clearRect(0, 0, width, height);
  sourceCtx.imageSmoothingEnabled = true;
  sourceCtx.imageSmoothingQuality = "high";
  sourceCtx.drawImage(image, 0, 0, width, height);
  resultCtx.clearRect(0, 0, width, height);
}

function resizeCanvases(width, height) {
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  resultCanvas.width = width;
  resultCanvas.height = height;
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
  if (renderTimer !== null) clearTimeout(renderTimer);

  const canLocalGpu =
    !force &&
    !params.regionBinarize &&
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
    const useGpu = !params.regionBinarize && activeBackend !== "cpu" && gpuRenderer.isReady();

    worker.postMessage({
      type: "process",
      id: requestId,
      params: { ...params },
      options: {
        needRgba: !useGpu || params.regionBinarize,
        needKMap: useGpu,
        forceKMap: forceKMapSync,
      },
    });
    forceKMapSync = false;

    if (params.regionBinarize) {
      setStatus("正在执行 Watershed + 多尺度 Felzenszwalb + CRF 区域二值化...");
    } else if (useGpu) {
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
    resizeCanvases(width, height);
  }
  const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
  resultCtx.putImageData(imageData, 0, 0);
}

function drawFromGpuCanvas(width, height) {
  if (resultCanvas.width !== width || resultCanvas.height !== height) {
    resizeCanvases(width, height);
  }
  resultCtx.clearRect(0, 0, width, height);
  resultCtx.drawImage(gpuRenderer.canvas, 0, 0, width, height);
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
  const setEnabled = (key, enabled) => {
    const binding = bindings.get(key);
    if (!binding?.input) return;
    binding.input.disabled = !enabled;
    if (binding.row) binding.row.style.opacity = enabled ? "1" : "0.45";
  };

  const orderBinding = bindings.get("butterOrder");
  const isButterworth = params.filterType === "butterworth";
  if (orderBinding?.input) {
    orderBinding.input.disabled = !isButterworth;
    orderBinding.row.style.opacity = isButterworth ? "1" : "0.45";
  }

  for (const key of REGION_DETAIL_KEYS) {
    setEnabled(key, params.regionBinarize);
  }

  setEnabled("wsSeedSpacing", params.regionBinarize && params.useWatershedInit);
  setEnabled("wsSeedMinDist", params.regionBinarize && params.useWatershedInit);

  setEnabled("regionMergeStrength", params.regionBinarize && params.regionMergeEnabled);
  setEnabled("regionMergePasses", params.regionBinarize && params.regionMergeEnabled);

  setEnabled("multiScaleKFactor", params.regionBinarize && params.multiScaleEnabled);
  setEnabled("multiScaleMinFactor", params.regionBinarize && params.multiScaleEnabled);

  setEnabled("crfIters", params.regionBinarize && params.crfEnabled);
  setEnabled("crfUnaryWeight", params.regionBinarize && params.crfEnabled);
  setEnabled("crfPairWeight", params.regionBinarize && params.crfEnabled);
  setEnabled("crfColorSigma", params.regionBinarize && params.crfEnabled);
}

function enforceRankWeightSum(changedKey) {
  if (changedKey !== "rankVoteWeight" && changedKey !== "rankGrayWeight") return;

  const own = clamp01Number(params[changedKey]);
  const normalized = Math.round(own * 100) / 100;
  params[changedKey] = normalized;

  const otherKey = changedKey === "rankVoteWeight" ? "rankGrayWeight" : "rankVoteWeight";
  params[otherKey] = Math.round((1 - normalized) * 100) / 100;
  updateControlValue(otherKey);
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
  for (const key of bindings.keys()) updateControlValue(key);
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
    if (binding.value) binding.value.textContent = String(binding.input.options[binding.input.selectedIndex].textContent);
    return;
  }

  binding.input.value = String(params[key]);
  if (binding.value) binding.value.textContent = formatValue(params[key], binding.step);
}

function formatValue(value, step = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (step >= 1) return String(Math.round(n));
  const decimals = Math.max(0, String(step).split(".")[1]?.length ?? 0);
  return n.toFixed(Math.min(decimals, 3));
}

function clamp01Number(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
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
