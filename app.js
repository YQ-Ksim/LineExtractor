import { HybridGpuRenderer } from "./gpu_renderer.js";
const APP_VERSION = "20260325-8";
const MAX_IMAGE_DIM = 1024;
const LOCALE_STORAGE_KEY = "lineextractor.locale";
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
    embedSketchLines: false,
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
        title: "FFT / Filter",
        controls: [
            { key: "radius", label: "R Radius", type: "range", min: 2, max: 280, step: 1 },
            {
                key: "filterType",
                label: "Filter Type",
                type: "select",
                options: [
                    { value: "butterworth", label: "Butterworth" },
                    { value: "ideal", label: "Ideal" },
                ],
            },
            { key: "butterOrder", label: "Butterworth Order", type: "range", min: 1, max: 8, step: 1 },
            { key: "highpassStrength", label: "Highpass Strength", type: "range", min: 0.2, max: 3, step: 0.05 },
        ],
    },
    {
        title: "Post Processing",
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
        title: "Line-guided Region Binarization",
        controls: [
            { key: "regionBinarize", label: "Enable Region Binarization", type: "checkbox" },
            { key: "embedSketchLines", label: "Embed Sketch Lines", type: "checkbox" },
            { key: "regionTopPercent", label: "Top p% As Black", type: "range", min: 1, max: 99, step: 1 },
            { key: "rankVoteWeight", label: "Vote Score Weight", type: "range", min: 0, max: 1, step: 0.01 },
            { key: "rankGrayWeight", label: "Gray Rank Weight", type: "range", min: 0, max: 1, step: 0.01 },
            { key: "regionMergeEnabled", label: "Merge Similar Small Regions", type: "checkbox" },
            { key: "regionMergeStrength", label: "Merge Strength", type: "range", min: 0, max: 2, step: 0.05 },
            { key: "regionMergePasses", label: "Merge Passes", type: "range", min: 1, max: 4, step: 1 },
            { key: "segLineThreshold", label: "Segmentation Line Threshold", type: "range", min: 0.05, max: 0.95, step: 0.01 },
            { key: "segLineDenoiseRadius", label: "Line Denoise Radius", type: "range", min: 0, max: 3, step: 1 },
            { key: "segLineMinArea", label: "Minimum Line Area", type: "range", min: 0, max: 64, step: 1 },
            { key: "segDilateRadius", label: "Barrier Dilate Radius", type: "range", min: 0, max: 4, step: 1 },
            { key: "useWatershedInit", label: "Watershed Init", type: "checkbox" },
            { key: "wsSeedSpacing", label: "WS Seed Spacing", type: "range", min: 2, max: 24, step: 1 },
            { key: "wsSeedMinDist", label: "WS Seed Min Dist", type: "range", min: 0.1, max: 6, step: 0.1 },
            { key: "felzK", label: "Felzenszwalb k", type: "range", min: 1, max: 1000, step: 1 },
            { key: "felzMinSize", label: "Felzenszwalb Min Region", type: "range", min: 0, max: 2000, step: 1 },
            { key: "linePenalty", label: "Line Penalty", type: "range", min: 0, max: 2000, step: 1 },
            { key: "multiScaleEnabled", label: "Multi-scale Fusion", type: "checkbox" },
            { key: "multiScaleKFactor", label: "Coarse k Factor", type: "range", min: 1, max: 6, step: 0.1 },
            { key: "multiScaleMinFactor", label: "Coarse Min Factor", type: "range", min: 1, max: 6, step: 0.1 },
            { key: "crfEnabled", label: "CRF Refine", type: "checkbox" },
            { key: "crfIters", label: "CRF Iterations", type: "range", min: 0, max: 6, step: 1 },
            { key: "crfUnaryWeight", label: "CRF Unary Weight", type: "range", min: 0, max: 6, step: 0.1 },
            { key: "crfPairWeight", label: "CRF Pair Weight", type: "range", min: 0, max: 6, step: 0.1 },
            { key: "crfColorSigma", label: "CRF Color Sigma", type: "range", min: 1, max: 80, step: 1 },
        ],
    },
];
const GROUP_TITLES = {
    zh: ["FFT / Filter 参数", "后处理参数", "线稿引导区域二值化"],
    en: ["FFT / Filter", "Post Processing", "Line-guided Region Binarization"],
};
const CONTROL_LABELS = {
    zh: {
        radius: "R 半径",
        filterType: "高通类型",
        butterOrder: "Butterworth 阶数",
        highpassStrength: "高通强度",
        normalize: "归一化",
        contrast: "对比度",
        threshold: "阈值",
        blur: "模糊",
        sharpen: "锐化",
        regionBinarize: "启用区域二值化",
        embedSketchLines: "嵌入线稿纹理",
        regionTopPercent: "前 p% 设为黑",
        rankVoteWeight: "投票分数权重",
        rankGrayWeight: "灰度排名权重",
        regionMergeEnabled: "合并相近小区域",
        regionMergeStrength: "合并强度",
        regionMergePasses: "合并轮数",
        segLineThreshold: "分割线阈值",
        segLineDenoiseRadius: "线稿去噪半径",
        segLineMinArea: "线稿最小面积",
        segDilateRadius: "边界膨胀半径",
        useWatershedInit: "Watershed 初分割",
        wsSeedSpacing: "WS 种子间距",
        wsSeedMinDist: "WS 最小距离",
        felzMinSize: "Felzenszwalb 最小区域",
        linePenalty: "跨线惩罚",
        multiScaleEnabled: "多尺度融合",
        multiScaleKFactor: "粗尺度 k 倍率",
        multiScaleMinFactor: "粗尺度最小区域倍率",
        crfEnabled: "CRF 细化",
        crfIters: "CRF 迭代次数",
    },
    en: {},
};
const FILTER_OPTION_LABELS = {
    zh: { butterworth: "Butterworth", ideal: "Ideal" },
    en: { butterworth: "Butterworth", ideal: "Ideal" },
};
const UI_TEXT = {
    zh: {
        title: "LineExtractor",
        subtitle: "纯前端流程：频域线稿提取 + 线稿引导区域二值化",
        importImage: "导入图片",
        loadDemo: "加载 test.jpg",
        exportPng: "导出 PNG",
        resetParams: "重置参数",
        renderBackend: "渲染后端",
        source: "原图",
        output: "输出",
        waiting: "等待加载图片...",
        switchLabel: "EN",
        backendAuto: "自动 (WebGPU > WebGL2 > CPU)",
        backendWebgpu: "WebGPU",
        backendWebgl: "WebGL2",
        backendCpu: "CPU",
        modeLine: "线稿",
        modeRegion: "区域二值化",
        status: {
            processingFailed: "处理失败",
            gpuTextureFallback: "GPU 纹理上传失败，已回退到 CPU。",
            gpuOutputFallback: "GPU 输出不可用，已回退到 CPU。",
            noOutputToExport: "当前没有可导出的输出图像。",
            exportFailed: "导出失败：PNG 编码结果为空。",
            exported: "PNG 已导出。",
            renderBackendCpu: "渲染后端：CPU",
            renderBackendEnabled: "渲染后端已启用",
            renderBackendFallback: "GPU 后端不可用，已回退到 CPU。",
            loadingImage: "正在加载图片...",
            loadFailed: "图片加载失败",
            initFrequency: "正在初始化频域缓冲...",
            processingRegion: "正在执行区域二值化（Watershed + Felzenszwalb + CRF）...",
            processingGpu: "正在计算 Layer1/Layer2，并由 GPU 渲染 Layer3...",
            processingGeneric: "正在处理...",
            localGpuDone: "GPU 本地后处理完成",
            cacheHit: "命中缓存",
            languageSwitched: "语言已切换为中文。",
        },
    },
    en: {
        title: "LineExtractor",
        subtitle: "Pure frontend pipeline: Frequency-domain line extraction + line-guided region binarization",
        importImage: "Import Image",
        loadDemo: "Load test.jpg",
        exportPng: "Export PNG",
        resetParams: "Reset Parameters",
        renderBackend: "Render Backend",
        source: "Source",
        output: "Output",
        waiting: "Waiting for image...",
        switchLabel: "中文",
        backendAuto: "Auto (WebGPU > WebGL2 > CPU)",
        backendWebgpu: "WebGPU",
        backendWebgl: "WebGL2",
        backendCpu: "CPU",
        modeLine: "line",
        modeRegion: "region-binarize",
        status: {
            processingFailed: "Processing failed",
            gpuTextureFallback: "GPU texture upload failed. Fallback to CPU.",
            gpuOutputFallback: "GPU output unavailable. Fallback to CPU.",
            noOutputToExport: "No output image to export.",
            exportFailed: "Export failed: PNG encoding returned empty blob.",
            exported: "PNG exported.",
            renderBackendCpu: "Render backend: CPU",
            renderBackendEnabled: "Render backend enabled",
            renderBackendFallback: "GPU backend unavailable. Fallback to CPU.",
            loadingImage: "Loading image...",
            loadFailed: "Image load failed",
            initFrequency: "Initializing frequency buffers...",
            processingRegion: "Processing region binarization (Watershed + Felzenszwalb + CRF)...",
            processingGpu: "Computing Layer1/Layer2 in worker, rendering Layer3 on GPU...",
            processingGeneric: "Processing...",
            localGpuDone: "GPU local postprocess done",
            cacheHit: "cache hit",
            languageSwitched: "Language switched to English.",
        },
    },
};
const titleEl = getRequiredElement("app-title");
const subtitleEl = getRequiredElement("app-subtitle");
const importLabelEl = getRequiredElement("import-label");
const sourceCaptionEl = getRequiredElement("source-caption");
const outputCaptionEl = getRequiredElement("output-caption");
const backendLabelEl = getRequiredElement("backend-label");
const langToggleButton = getRequiredElement("lang-toggle");
const sourceCanvas = getRequiredElement("source-canvas");
const resultCanvas = getRequiredElement("result-canvas");
const controlsRoot = getRequiredElement("controls");
const statusEl = getRequiredElement("status");
const fileInput = getRequiredElement("file-input");
const loadDemoButton = getRequiredElement("load-demo");
const exportButton = getRequiredElement("export-png");
const resetButton = getRequiredElement("reset-params");
const backendSelect = getRequiredElement("backend-select");
const sourceCtx = getRequired2DContext(sourceCanvas, true);
const resultCtx = getRequired2DContext(resultCanvas, false);
const worker = new Worker(`./worker.js?v=${APP_VERSION}`, { type: "module" });
const gpuRenderer = new HybridGpuRenderer();
const params = { ...DEFAULT_PARAMS };
const bindings = new Map();
const LAYER1_KEYS = new Set(["radius", "filterType", "butterOrder", "highpassStrength"]);
const LAYER2_KEYS = new Set();
const REGION_DETAIL_KEYS = new Set([
    "embedSketchLines",
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
let currentLocale = detectInitialLocale();
let isImageReady = false;
let hasResult = false;
let requestId = 0;
let lastResultId = 0;
let renderTimer = null;
let backendPreference = readBackendPreference(backendSelect.value);
let activeBackend = "cpu";
let backendToken = 0;
let forceKMapSync = true;
let workerInFlight = false;
let workerActiveRequestId = 0;
let queuedRenderPending = false;
let queuedRenderForce = false;
applyLocaleTexts(false);
buildControls();
bindEvents();
void initializeBackend().then(() => loadDemoImage());
worker.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "imageReady") {
        handleImageReady(message);
        return;
    }
    if (message.type === "result") {
        handleWorkerResult(message);
        return;
    }
    if (message.type === "error") {
        workerInFlight = false;
        setStatus(`${ui().status.processingFailed}: ${message.message}`);
        scheduleQueuedRenderIfNeeded();
    }
});
function ui() {
    return UI_TEXT[currentLocale];
}
function detectInitialLocale() {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "zh" || saved === "en")
        return saved;
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}
function applyLocaleTexts(announce = true) {
    document.documentElement.lang = currentLocale === "zh" ? "zh-CN" : "en";
    document.title = ui().title;
    titleEl.textContent = ui().title;
    subtitleEl.textContent = ui().subtitle;
    importLabelEl.textContent = ui().importImage;
    loadDemoButton.textContent = ui().loadDemo;
    exportButton.textContent = ui().exportPng;
    resetButton.textContent = ui().resetParams;
    backendLabelEl.textContent = ui().renderBackend;
    sourceCaptionEl.textContent = ui().source;
    outputCaptionEl.textContent = ui().output;
    langToggleButton.textContent = ui().switchLabel;
    updateBackendOptionTexts();
    if (!isImageReady && !hasResult) {
        setStatus(ui().waiting);
    }
    else if (announce) {
        setStatus(ui().status.languageSwitched);
    }
}
function toggleLanguage() {
    currentLocale = currentLocale === "zh" ? "en" : "zh";
    window.localStorage.setItem(LOCALE_STORAGE_KEY, currentLocale);
    applyLocaleTexts(true);
    rebuildControls();
}
function updateBackendOptionTexts() {
    for (const option of backendSelect.options) {
        if (option.value === "auto")
            option.textContent = ui().backendAuto;
        if (option.value === "webgpu")
            option.textContent = ui().backendWebgpu;
        if (option.value === "webgl")
            option.textContent = ui().backendWebgl;
        if (option.value === "cpu")
            option.textContent = ui().backendCpu;
    }
}
function rebuildControls() {
    controlsRoot.textContent = "";
    bindings.clear();
    buildControls();
    syncControlValues();
    updateDynamicControlState();
}
function getGroupTitle(groupIndex, fallback) {
    return GROUP_TITLES[currentLocale][groupIndex] ?? fallback;
}
function getControlLabel(key, fallback) {
    return CONTROL_LABELS[currentLocale][key] ?? fallback;
}
function getFilterOptionLabel(value, fallback) {
    return FILTER_OPTION_LABELS[currentLocale][value] ?? fallback;
}
function handleImageReady(message) {
    isImageReady = true;
    hasResult = false;
    forceKMapSync = true;
    if (currentLocale === "zh") {
        setStatus(`图像就绪 ${message.width}x${message.height} | FFT 初始化 ${message.stats.initMs.toFixed(1)}ms | pad ${message.stats.padW}x${message.stats.padH}`);
    }
    else {
        setStatus(`Image ready ${message.width}x${message.height} | FFT init ${message.stats.initMs.toFixed(1)}ms | pad ${message.stats.padW}x${message.stats.padH}`);
    }
    requestRender("", true);
}
function handleWorkerResult(message) {
    if (message.id === workerActiveRequestId) {
        workerInFlight = false;
    }
    if (message.id < lastResultId) {
        scheduleQueuedRenderIfNeeded();
        return;
    }
    lastResultId = message.id;
    if (message.kMapBuffer) {
        const kMap = new Float32Array(message.kMapBuffer);
        const uploaded = gpuRenderer.uploadKMap(kMap, message.width, message.height, message.kRange);
        if (!uploaded && activeBackend !== "cpu") {
            activeBackend = "cpu";
            backendSelect.value = "cpu";
            forceKMapSync = false;
            setStatus(ui().status.gpuTextureFallback);
            requestRender("", true);
            return;
        }
    }
    let renderedBy = "cpu";
    let gpuMs = 0;
    if (!params.regionBinarize && activeBackend !== "cpu" && gpuRenderer.isReady() && gpuRenderer.hasKMap()) {
        gpuMs = gpuRenderer.render(params);
        drawFromGpuCanvas(message.width, message.height);
        renderedBy = activeBackend;
    }
    else if (message.imageBuffer) {
        drawCpuResult(message.width, message.height, message.imageBuffer);
        renderedBy = "cpu";
    }
    else if (activeBackend !== "cpu") {
        activeBackend = "cpu";
        backendSelect.value = "cpu";
        forceKMapSync = false;
        setStatus(ui().status.gpuOutputFallback);
        requestRender("", true);
        return;
    }
    hasResult = true;
    const layers = [];
    if (message.stats.recomputed.layer1)
        layers.push("Layer1");
    if (message.stats.recomputed.layer2)
        layers.push("Layer2");
    layers.push("Layer3");
    if (message.stats.regionMs > 0)
        layers.push("Region");
    const cachePart = message.stats.regionCacheHit ? `, ${ui().status.cacheHit}` : "";
    const regionPart = params.regionBinarize
        ? `, Felz ${message.stats.felzMs.toFixed(1)}ms, E=${message.stats.felzEdgeCount}, R=${message.stats.felzInitialRegions}->${message.stats.felzFinalRegions}, Ws ${message.stats.watershedMs.toFixed(1)}ms, Merge ${message.stats.mergeMs.toFixed(1)}ms, Fuse ${message.stats.fusionMs.toFixed(1)}ms, CRF ${message.stats.crfMs.toFixed(1)}ms${cachePart}`
        : "";
    const modeText = params.regionBinarize ? ui().modeRegion : ui().modeLine;
    if (currentLocale === "zh") {
        setStatus(`完成 | 模式 ${modeText} | 后端 ${renderedBy.toUpperCase()} | 重算 ${layers.join(" + ")} | 总耗时 ${message.stats.totalMs.toFixed(1)}ms (L1 ${message.stats.layer1Ms.toFixed(1)}ms, L2 ${message.stats.layer2Ms.toFixed(1)}ms, L3 ${message.stats.layer3Ms.toFixed(1)}ms, Region ${message.stats.regionMs.toFixed(1)}ms${regionPart}${renderedBy !== "cpu" ? `, GPU ${gpuMs.toFixed(1)}ms` : ""})`);
    }
    else {
        setStatus(`Done | mode ${modeText} | backend ${renderedBy.toUpperCase()} | recompute ${layers.join(" + ")} | total ${message.stats.totalMs.toFixed(1)}ms (L1 ${message.stats.layer1Ms.toFixed(1)}ms, L2 ${message.stats.layer2Ms.toFixed(1)}ms, L3 ${message.stats.layer3Ms.toFixed(1)}ms, Region ${message.stats.regionMs.toFixed(1)}ms${regionPart}${renderedBy !== "cpu" ? `, GPU ${gpuMs.toFixed(1)}ms` : ""})`);
    }
    scheduleQueuedRenderIfNeeded();
}
function buildControls() {
    const frag = document.createDocumentFragment();
    for (let groupIndex = 0; groupIndex < CONTROL_SCHEMA.length; groupIndex += 1) {
        const group = CONTROL_SCHEMA[groupIndex];
        const section = document.createElement("section");
        section.className = "control-group";
        const title = document.createElement("h3");
        title.textContent = getGroupTitle(groupIndex, group.title);
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
        const text = document.createElement("span");
        text.textContent = getControlLabel(control.key, control.label);
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(params[control.key]);
        input.addEventListener("change", () => {
            params[control.key] = input.checked;
            updateDynamicControlState();
            requestRender(control.key);
        });
        row.append(text, input);
        bindings.set(control.key, { input, type: "checkbox", row });
        return row;
    }
    const row = document.createElement("div");
    row.className = "control-row";
    const head = document.createElement("div");
    head.className = "control-head";
    const label = document.createElement("label");
    label.textContent = getControlLabel(control.key, control.label);
    label.htmlFor = `input-${control.key}`;
    const value = document.createElement("span");
    value.className = "value-badge";
    value.textContent = control.type === "range" ? formatValue(params[control.key], control.step) : String(params[control.key]);
    head.append(label, value);
    row.appendChild(head);
    if (control.type === "range") {
        const input = document.createElement("input");
        input.type = "range";
        input.min = String(control.min);
        input.max = String(control.max);
        input.step = String(control.step);
        input.value = String(params[control.key]);
        input.id = `input-${control.key}`;
        input.addEventListener("input", () => {
            params[control.key] = Number(input.value);
            enforceRankWeightSum(control.key);
            guardClipBounds(control.key);
            updateControlValue(control.key);
            updateDynamicControlState();
            requestRender(control.key);
        });
        row.appendChild(input);
        bindings.set(control.key, { input, value, type: "range", step: control.step, row });
        return row;
    }
    const input = document.createElement("select");
    input.id = `input-${control.key}`;
    for (const optionDef of control.options) {
        const option = document.createElement("option");
        option.value = optionDef.value;
        option.textContent = control.key === "filterType" ? getFilterOptionLabel(optionDef.value, optionDef.label) : optionDef.label;
        input.appendChild(option);
    }
    input.value = String(params[control.key]);
    value.textContent = String(input.options[input.selectedIndex]?.textContent ?? "");
    input.addEventListener("change", () => {
        params[control.key] = input.value;
        updateControlValue(control.key);
        updateDynamicControlState();
        requestRender(control.key);
    });
    row.appendChild(input);
    bindings.set(control.key, { input, value, type: "select", row });
    return row;
}
function bindEvents() {
    fileInput.addEventListener("change", async (event) => {
        const target = event.target;
        const file = target.files?.[0];
        if (!file)
            return;
        await loadImageFromSource(file);
        fileInput.value = "";
    });
    loadDemoButton.addEventListener("click", () => {
        void loadDemoImage();
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
        backendPreference = readBackendPreference(backendSelect.value);
        await initializeBackend();
        forceKMapSync = true;
        requestRender("", true);
    });
    langToggleButton.addEventListener("click", () => {
        toggleLanguage();
    });
}
async function initializeBackend() {
    const token = ++backendToken;
    if (backendPreference === "cpu") {
        gpuRenderer.destroy();
        activeBackend = "cpu";
        setStatus(ui().status.renderBackendCpu);
        return;
    }
    const result = await gpuRenderer.initialize(backendPreference);
    if (token !== backendToken)
        return;
    if (result.available) {
        activeBackend = result.backend;
        setStatus(`${ui().status.renderBackendEnabled}: ${activeBackend.toUpperCase()}`);
    }
    else {
        activeBackend = "cpu";
        setStatus(ui().status.renderBackendFallback);
    }
}
async function loadDemoImage() {
    await loadImageFromSource("./test.jpg");
}
async function loadImageFromSource(source) {
    setStatus(ui().status.loadingImage);
    try {
        const image = await loadImageElement(source);
        const fitted = fitSize(image.naturalWidth || image.width, image.naturalHeight || image.height, MAX_IMAGE_DIM);
        drawSource(image, fitted.width, fitted.height);
        initWorkerImage();
    }
    catch (error) {
        setStatus(`${ui().status.loadFailed}: ${error instanceof Error ? error.message : String(error)}`);
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
    workerInFlight = false;
    workerActiveRequestId = 0;
    queuedRenderPending = false;
    queuedRenderForce = false;
    gpuRenderer.resetKMap();
    setStatus(ui().status.initFrequency);
    const message = {
        type: "initImage",
        width,
        height,
        data: imageData.data.buffer,
    };
    worker.postMessage(message, [imageData.data.buffer]);
}
function dispatchWorkerRender(force) {
    requestId += 1;
    const useGpu = !params.regionBinarize && activeBackend !== "cpu" && gpuRenderer.isReady();
    const message = {
        type: "process",
        id: requestId,
        params: { ...params },
        options: {
            needRgba: !useGpu || params.regionBinarize,
            needKMap: useGpu,
            forceKMap: forceKMapSync || force,
        },
    };
    workerInFlight = true;
    workerActiveRequestId = requestId;
    worker.postMessage(message);
    forceKMapSync = false;
    if (params.regionBinarize) {
        setStatus(ui().status.processingRegion);
    }
    else if (useGpu) {
        setStatus(ui().status.processingGpu);
    }
    else {
        setStatus(ui().status.processingGeneric);
    }
}
function scheduleQueuedRenderIfNeeded() {
    if (!queuedRenderPending || workerInFlight || !isImageReady)
        return;
    const nextForce = queuedRenderForce;
    queuedRenderPending = false;
    queuedRenderForce = false;
    requestRender("", nextForce);
}
function requestRender(changedKey = "", force = false) {
    if (!isImageReady)
        return;
    if (renderTimer !== null)
        window.clearTimeout(renderTimer);
    const canLocalGpu = !force &&
        !params.regionBinarize &&
        changedKey !== "" &&
        activeBackend !== "cpu" &&
        gpuRenderer.isReady() &&
        gpuRenderer.hasKMap() &&
        !LAYER1_KEYS.has(changedKey) &&
        !LAYER2_KEYS.has(changedKey);
    const delay = pickDelay(changedKey);
    renderTimer = window.setTimeout(() => {
        renderTimer = null;
        if (canLocalGpu) {
            const gpuMs = gpuRenderer.render(params);
            drawFromGpuCanvas(sourceCanvas.width, sourceCanvas.height);
            hasResult = true;
            setStatus(`${ui().status.localGpuDone} | Layer3 | ${gpuMs.toFixed(1)}ms`);
            return;
        }
        if (workerInFlight) {
            queuedRenderPending = true;
            queuedRenderForce = queuedRenderForce || force;
            return;
        }
        dispatchWorkerRender(force);
    }, delay);
}
function pickDelay(changedKey) {
    if (!changedKey)
        return 40;
    if (LAYER1_KEYS.has(changedKey))
        return 140;
    if (LAYER2_KEYS.has(changedKey))
        return 70;
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
        setStatus(ui().status.noOutputToExport);
        return;
    }
    resultCanvas.toBlob((blob) => {
        if (!blob) {
            setStatus(ui().status.exportFailed);
            return;
        }
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `line-sketch-${stamp}.png`;
        anchor.click();
        window.setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 2000);
        setStatus(ui().status.exported);
    }, "image/png");
}
function updateDynamicControlState() {
    const setEnabled = (key, enabled) => {
        const binding = bindings.get(key);
        if (!binding)
            return;
        binding.input.disabled = !enabled;
        binding.row.style.opacity = enabled ? "1" : "0.45";
    };
    const isButterworth = params.filterType === "butterworth";
    setEnabled("butterOrder", isButterworth);
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
    if (changedKey !== "rankVoteWeight" && changedKey !== "rankGrayWeight")
        return;
    const own = clamp01Number(Number(params[changedKey]));
    const normalized = Math.round(own * 100) / 100;
    params[changedKey] = normalized;
    const otherKey = changedKey === "rankVoteWeight" ? "rankGrayWeight" : "rankVoteWeight";
    params[otherKey] = (Math.round((1 - normalized) * 100) / 100);
    updateControlValue(otherKey);
}
function guardClipBounds(changedKey) {
    if (changedKey !== "clipMin" && changedKey !== "clipMax")
        return;
    if (params.clipMin <= params.clipMax)
        return;
    if (changedKey === "clipMin") {
        params.clipMax = params.clipMin;
        updateControlValue("clipMax");
    }
    else {
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
    if (!binding)
        return;
    if (binding.type === "checkbox") {
        binding.input.checked = Boolean(params[key]);
        return;
    }
    if (binding.type === "select") {
        const input = binding.input;
        input.value = String(params[key]);
        if (binding.value) {
            binding.value.textContent = String(input.options[input.selectedIndex]?.textContent ?? "");
        }
        return;
    }
    const input = binding.input;
    input.value = String(params[key]);
    if (binding.value) {
        binding.value.textContent = formatValue(params[key], binding.step);
    }
}
function formatValue(value, step = 1) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return "0";
    if (step >= 1)
        return String(Math.round(n));
    const decimals = Math.max(0, String(step).split(".")[1]?.length ?? 0);
    return n.toFixed(Math.min(decimals, 3));
}
function clamp01Number(v) {
    if (!Number.isFinite(v))
        return 0;
    if (v < 0)
        return 0;
    if (v > 1)
        return 1;
    return v;
}
function fitSize(width, height, maxDim) {
    const maxEdge = Math.max(width, height);
    if (maxEdge <= maxDim)
        return { width, height };
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
            if (objectUrl)
                URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            if (objectUrl)
                URL.revokeObjectURL(objectUrl);
            reject(new Error("Failed to decode image."));
        };
        if (source instanceof File) {
            objectUrl = URL.createObjectURL(source);
            image.src = objectUrl;
        }
        else {
            image.src = source;
        }
    });
}
function setStatus(text) {
    statusEl.textContent = text;
}
function readBackendPreference(value) {
    if (value === "cpu" || value === "webgl" || value === "webgpu")
        return value;
    return "auto";
}
function getRequiredElement(id) {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`Missing required element: #${id}`);
    return el;
}
function getRequired2DContext(canvas, willReadFrequently) {
    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently });
    if (!ctx)
        throw new Error("Failed to create 2D canvas context.");
    return ctx;
}
