const EPS = 1e-8;

const state = {
  ready: false,
  width: 0,
  height: 0,
  padW: 0,
  padH: 0,
  totalPix: 0,
  totalPad: 0,
  fft: null,
  grayOriginal: null,
  origR: null,
  origG: null,
  origB: null,
  distance: null,
  mask: null,
  edges: null,
  kBuffer: null,
  workA: null,
  workB: null,
  blurTemp: null,
  tmpReal: null,
  tmpImag: null,
  fftScratch: null,
  seg: null,
  kRange: { min: 0, max: 1 },
  kVersion: 0,
  cache: {
    layer1Key: "",
    layer2Key: "",
    kSentVersion: -1,
  },
};

self.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === "initImage") {
      initImage(message);
      return;
    }
    if (message.type === "process") {
      processFrame(message.id, message.params, message.options || {});
      return;
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

function initImage(message) {
  const t0 = performance.now();
  const width = message.width | 0;
  const height = message.height | 0;
  if (width <= 0 || height <= 0) throw new Error("Invalid image size");

  const rgba = new Uint8ClampedArray(message.data);
  const padW = nextPow2(width);
  const padH = nextPow2(height);
  const totalPad = padW * padH;
  const totalPix = width * height;

  const rSpatial = new Float32Array(totalPad);
  const gSpatial = new Float32Array(totalPad);
  const bSpatial = new Float32Array(totalPad);
  const grayOriginal = new Float32Array(totalPix);
  const origR = new Float32Array(totalPix);
  const origG = new Float32Array(totalPix);
  const origB = new Float32Array(totalPix);

  for (let y = 0; y < height; y += 1) {
    const srcRow = y * width * 4;
    const dstRow = y * padW;
    const grayRow = y * width;
    for (let x = 0; x < width; x += 1) {
      const src = srcRow + x * 4;
      const dst = dstRow + x;
      const r = rgba[src];
      const g = rgba[src + 1];
      const b = rgba[src + 2];
      rSpatial[dst] = r;
      gSpatial[dst] = g;
      bSpatial[dst] = b;
      const p = grayRow + x;
      grayOriginal[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      origR[p] = r / 255;
      origG[p] = g / 255;
      origB[p] = b / 255;
    }
  }

  const rReal = rSpatial.slice();
  const rImag = new Float32Array(totalPad);
  const gReal = gSpatial.slice();
  const gImag = new Float32Array(totalPad);
  const bReal = bSpatial.slice();
  const bImag = new Float32Array(totalPad);

  const fftScratch = {
    rowReal: new Float32Array(padW),
    rowImag: new Float32Array(padW),
    colReal: new Float32Array(padH),
    colImag: new Float32Array(padH),
  };

  fft2D(rReal, rImag, padW, padH, false, fftScratch);
  fft2D(gReal, gImag, padW, padH, false, fftScratch);
  fft2D(bReal, bImag, padW, padH, false, fftScratch);

  state.ready = true;
  state.width = width;
  state.height = height;
  state.padW = padW;
  state.padH = padH;
  state.totalPix = totalPix;
  state.totalPad = totalPad;
  state.fft = { rReal, rImag, gReal, gImag, bReal, bImag };
  state.grayOriginal = grayOriginal;
  state.origR = origR;
  state.origG = origG;
  state.origB = origB;
  state.distance = buildDistanceMap(padW, padH);
  state.mask = new Float32Array(totalPad);
  state.tmpReal = new Float32Array(totalPad);
  state.tmpImag = new Float32Array(totalPad);
  state.fftScratch = fftScratch;
  state.edges = {
    r: new Float32Array(totalPix),
    g: new Float32Array(totalPix),
    b: new Float32Array(totalPix),
  };
  state.kBuffer = new Float32Array(totalPix);
  state.workA = new Float32Array(totalPix);
  state.workB = new Float32Array(totalPix);
  state.blurTemp = new Float32Array(totalPix);
  const edgeCapacity = (width - 1) * height + width * (height - 1);
  state.seg = {
    lineMask: new Uint8Array(totalPix),
    barrier: new Uint8Array(totalPix),
    tempU8: new Uint8Array(totalPix),
    dist: new Float32Array(totalPix),
    labels: new Int32Array(totalPix),
    labelsAux: new Int32Array(totalPix),
    queue: new Int32Array(totalPix),
    visited: new Uint8Array(totalPix),
    edgeU: new Int32Array(edgeCapacity),
    edgeV: new Int32Array(edgeCapacity),
    edgeW: new Float32Array(edgeCapacity),
    edgeCross: new Uint8Array(edgeCapacity),
    edgeOrder: new Int32Array(edgeCapacity),
    parent: new Int32Array(totalPix),
    compSize: new Int32Array(totalPix),
    intDiff: new Float32Array(totalPix),
    rootMap: new Int32Array(totalPix),
    crfA: new Float32Array(totalPix),
    crfB: new Float32Array(totalPix),
    crfPrior: new Float32Array(totalPix),
  };
  state.kRange = { min: 0, max: 1 };
  state.kVersion = 0;
  state.cache.layer1Key = "";
  state.cache.layer2Key = "";
  state.cache.kSentVersion = -1;

  const t1 = performance.now();
  self.postMessage({
    type: "imageReady",
    width,
    height,
    stats: {
      initMs: t1 - t0,
      padW,
      padH,
    },
  });
}

function processFrame(id, rawParams, options) {
  if (!state.ready) throw new Error("Image not initialized");

  const needRgba = options.needRgba !== false;
  const needKMap = Boolean(options.needKMap);
  const forceKMap = Boolean(options.forceKMap);
  const params = sanitizeParams(rawParams);

  const started = performance.now();
  let layer1Ms = 0;
  let layer2Ms = 0;
  let layer3Ms = 0;
  let regionMs = 0;
  let felzMs = 0;
  let felzInitialRegions = 0;
  let felzFinalRegions = 0;
  let felzEdgeCount = 0;
  let watershedMs = 0;
  let mergeMs = 0;
  let fusionMs = 0;
  let crfMs = 0;
  let recomputeLayer1 = false;
  let recomputeLayer2 = false;

  const layer1Key = buildLayer1Key(params);
  if (layer1Key !== state.cache.layer1Key) {
    const s = performance.now();
    recomputeEdges(params);
    layer1Ms = performance.now() - s;
    recomputeLayer1 = true;
    state.cache.layer1Key = layer1Key;
    state.cache.layer2Key = "";
  }

  const layer2Key = buildLayer2Key(params, state.cache.layer1Key);
  if (layer2Key !== state.cache.layer2Key) {
    const s = performance.now();
    recomputeK();
    layer2Ms = performance.now() - s;
    recomputeLayer2 = true;
    state.cache.layer2Key = layer2Key;
  }

  let output = null;
  if (needRgba) {
    const s = performance.now();
    const tone = postprocessTone(params);
    layer3Ms = performance.now() - s;

    if (params.regionBinarize) {
      const r = performance.now();
      const regionResult = lineGuidedRegionBinarize(tone, params);
      output = regionResult.image;
      felzMs = regionResult.felzMs;
      felzInitialRegions = regionResult.felzInitialRegions;
      felzFinalRegions = regionResult.felzFinalRegions;
      felzEdgeCount = regionResult.felzEdgeCount;
      watershedMs = regionResult.watershedMs || 0;
      mergeMs = regionResult.mergeMs || 0;
      fusionMs = regionResult.fusionMs || 0;
      crfMs = regionResult.crfMs || 0;
      regionMs = performance.now() - r;
    } else {
      output = grayscaleToRgba(tone);
    }
  }

  let kMapBuffer = null;
  if (needKMap && (forceKMap || recomputeLayer2 || state.cache.kSentVersion !== state.kVersion)) {
    const copy = new Float32Array(state.kBuffer);
    kMapBuffer = copy.buffer;
    state.cache.kSentVersion = state.kVersion;
  }

  const totalMs = performance.now() - started;
  const transfer = [];
  if (output) transfer.push(output.buffer);
  if (kMapBuffer) transfer.push(kMapBuffer);

  self.postMessage(
    {
      type: "result",
      id,
      width: state.width,
      height: state.height,
      imageBuffer: output ? output.buffer : null,
      kMapBuffer,
      kRange: state.kRange,
      kVersion: state.kVersion,
      stats: {
        totalMs,
        layer1Ms,
        layer2Ms,
        layer3Ms,
        regionMs,
        felzMs,
        felzInitialRegions,
        felzFinalRegions,
        felzEdgeCount,
        watershedMs,
        mergeMs,
        fusionMs,
        crfMs,
        recomputed: {
          layer1: recomputeLayer1,
          layer2: recomputeLayer2,
        },
      },
    },
    transfer
  );
}

function sanitizeParams(params) {
  const safe = {
    radius: clampNumber(params.radius, 1, 2000, 160),
    filterType: params.filterType === "ideal" ? "ideal" : "butterworth",
    butterOrder: clampNumber(params.butterOrder, 1, 16, 2),
    highpassStrength: clampNumber(params.highpassStrength, 0, 10, 0.8),
    normalize: params.normalize === undefined ? true : Boolean(params.normalize),
    contrast: clampNumber(params.contrast, 0, 10, 0.8),
    threshold: clampNumber(params.threshold, 0, 1, 0.15),
    clipMin: clampNumber(params.clipMin, 0, 1, 0.01),
    clipMax: clampNumber(params.clipMax, 0, 1, 1),
    blur: clampNumber(params.blur, 0, 16, 0),
    sharpen: clampNumber(params.sharpen, 0, 10, 0.35),
    regionBinarize: Boolean(params.regionBinarize),
    regionTopPercent: clampNumber(params.regionTopPercent, 1, 99, 32),
    rankVoteWeight: clampNumber(params.rankVoteWeight, 0, 5, 0.7),
    rankGrayWeight: clampNumber(params.rankGrayWeight, 0, 5, 0.3),
    regionMergeEnabled: params.regionMergeEnabled === undefined ? true : Boolean(params.regionMergeEnabled),
    regionMergeStrength: clampNumber(params.regionMergeStrength, 0, 2, 1),
    regionMergePasses: clampNumber(params.regionMergePasses, 1, 4, 2),
    segLineThreshold: clampNumber(params.segLineThreshold, 0.01, 0.99, 0.55),
    segLineDenoiseRadius: clampNumber(params.segLineDenoiseRadius, 0, 8, 1),
    segLineMinArea: clampNumber(params.segLineMinArea, 0, 4096, 6),
    segDilateRadius: clampNumber(params.segDilateRadius, 0, 8, 1),
    useWatershedInit: params.useWatershedInit === undefined ? false : Boolean(params.useWatershedInit),
    wsSeedSpacing: clampNumber(params.wsSeedSpacing, 2, 64, 4),
    wsSeedMinDist: clampNumber(params.wsSeedMinDist, 0, 64, 0.8),
    felzK: clampNumber(params.felzK, 1, 5000, 220),
    felzMinSize: clampNumber(params.felzMinSize, 0, 20000, 48),
    linePenalty: clampNumber(params.linePenalty, 0, 5000, 1000),
    multiScaleEnabled: params.multiScaleEnabled === undefined ? false : Boolean(params.multiScaleEnabled),
    multiScaleKFactor: clampNumber(params.multiScaleKFactor, 1, 8, 2.2),
    multiScaleMinFactor: clampNumber(params.multiScaleMinFactor, 1, 8, 2.0),
    crfEnabled: params.crfEnabled === undefined ? false : Boolean(params.crfEnabled),
    crfIters: clampNumber(params.crfIters, 0, 8, 2),
    crfUnaryWeight: clampNumber(params.crfUnaryWeight, 0, 10, 2.0),
    crfPairWeight: clampNumber(params.crfPairWeight, 0, 10, 1.2),
    crfColorSigma: clampNumber(params.crfColorSigma, 1, 120, 24),
  };

  if (safe.clipMin > safe.clipMax) safe.clipMax = safe.clipMin;
  return safe;
}

function buildLayer1Key(params) {
  return [
    numberKey(params.radius),
    params.filterType,
    numberKey(params.butterOrder),
    numberKey(params.highpassStrength),
  ].join("|");
}

function buildLayer2Key(params, layer1Key) {
  return layer1Key;
}

function numberKey(value) {
  return Number(value).toFixed(6);
}

function recomputeEdges(params) {
  buildHighpassMask(state.mask, state.distance, params, state.totalPad);
  applyFilterAndIfft(state.fft.rReal, state.fft.rImag, state.edges.r);
  applyFilterAndIfft(state.fft.gReal, state.fft.gImag, state.edges.g);
  applyFilterAndIfft(state.fft.bReal, state.fft.bImag, state.edges.b);
}

function buildHighpassMask(mask, distance, params, total) {
  const cutoff = Math.max(1, params.radius);
  const order = Math.max(1, Math.round(params.butterOrder));
  const gain = Math.max(0, params.highpassStrength);
  const power = 2 * order;

  if (params.filterType === "ideal") {
    for (let i = 0; i < total; i += 1) {
      mask[i] = distance[i] >= cutoff ? gain : 0;
    }
    return;
  }

  for (let i = 0; i < total; i += 1) {
    const d = distance[i];
    if (d <= EPS) {
      mask[i] = 0;
      continue;
    }
    const base = 1 / (1 + Math.pow(cutoff / d, power));
    mask[i] = base * gain;
  }
}

function applyFilterAndIfft(srcReal, srcImag, outEdge) {
  const { totalPad, mask, tmpReal, tmpImag, padW, padH, width, height } = state;

  tmpReal.set(srcReal);
  tmpImag.set(srcImag);
  for (let i = 0; i < totalPad; i += 1) {
    const m = mask[i];
    tmpReal[i] *= m;
    tmpImag[i] *= m;
  }

  fft2D(tmpReal, tmpImag, padW, padH, true, state.fftScratch);

  for (let y = 0; y < height; y += 1) {
    const srcRow = y * padW;
    const dstRow = y * width;
    for (let x = 0; x < width; x += 1) {
      outEdge[dstRow + x] = Math.abs(tmpReal[srcRow + x]);
    }
  }
}

function recomputeK() {
  const { r, g, b } = state.edges;
  const out = state.kBuffer;
  const n = state.totalPix;

  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < n; i += 1) {
    const rv = r[i];
    const gv = g[i];
    const bv = b[i];
    const numerator = rv * rv + gv * gv + bv * bv;
    const denominator = 256 * (rv + gv + bv + EPS);
    const kv = numerator / denominator;
    out[i] = kv;
    if (kv < min) min = kv;
    if (kv > max) max = kv;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  state.kRange = { min, max };
  state.kVersion += 1;
}

function postprocessTone(params) {
  let current = state.workA;
  let scratch = state.workB;
  current.set(state.kBuffer);

  if (params.normalize) {
    normalizeInPlace(current);
  }

  applyContrastInPlace(current, params.contrast);
  applyThresholdInPlace(current, params.threshold);
  applyClipAndScaleInPlace(current, params.clipMin, params.clipMax);

  const blurRadius = Math.round(params.blur);
  if (blurRadius > 0) {
    boxBlur(current, scratch, state.blurTemp, state.width, state.height, blurRadius);
    [current, scratch] = [scratch, current];
  }

  if (params.sharpen > 0) {
    boxBlur(current, scratch, state.blurTemp, state.width, state.height, 1);
    const amount = params.sharpen;
    const n = state.totalPix;
    for (let i = 0; i < n; i += 1) {
      current[i] = clamp01(current[i] + amount * (current[i] - scratch[i]));
    }
  }

  return current;
}

function lineGuidedRegionBinarize(tone, params) {
  const width = state.width;
  const height = state.height;
  const n = state.totalPix;
  const minStableRegions = clampInt(Math.round((width * height) / 1400), 24, 2000);
  const gray = state.grayOriginal;
  const origR = state.origR;
  const origG = state.origG;
  const origB = state.origB;
  const seg = state.seg;
  let watershedMs = 0;
  let mergeMs = 0;
  let fusionMs = 0;
  let crfMs = 0;

  // Layer3 line sketch is black background + white lines.
  // White lines define constrained boundaries for graph segmentation.
  buildLineMask(tone, seg.lineMask, params.segLineThreshold, n);
  const denoiseRadius = Math.round(params.segLineDenoiseRadius);
  if (denoiseRadius > 0) {
    erodeBinary(seg.lineMask, seg.barrier, seg.tempU8, width, height, denoiseRadius);
    dilateBinary(seg.barrier, seg.lineMask, seg.tempU8, width, height, denoiseRadius);
  }
  const minLineArea = Math.max(0, Math.round(params.segLineMinArea));
  if (minLineArea > 1) {
    removeSmallBinaryComponents(seg.lineMask, width, height, minLineArea, seg.queue, seg.visited);
  }
  dilateBinary(seg.lineMask, seg.barrier, seg.tempU8, width, height, Math.round(params.segDilateRadius));

  const felzStarted = performance.now();
  let segResult;
  const barrierRatio = binaryRatio(seg.barrier);
  const allowWatershed = barrierRatio >= 0.01 && barrierRatio <= 0.42;
  if (params.useWatershedInit) {
    if (allowWatershed) {
      const wsStart = performance.now();
      const seedCount = watershedInitialSegmentation(seg, width, height, n, params);
      watershedMs = performance.now() - wsStart;
      if (seedCount <= 0) {
        return {
          image: grayscaleToRgba(tone),
          felzMs: 0,
          felzInitialRegions: 0,
          felzFinalRegions: 0,
          felzEdgeCount: 0,
          watershedMs,
          mergeMs: 0,
          fusionMs: 0,
          crfMs: 0,
        };
      }

      const mergeStart = performance.now();
      const merged = felzenszwalbMergeFromWatershed(seg.labels, seedCount, width, height, origR, origG, origB, seg.barrier, params);
      mergeMs = performance.now() - mergeStart;
      segResult = {
        edgeCount: merged.edgeCount,
        initialRegions: seedCount,
        regionCount: merged.regionCount,
      };
      // Fallback: if watershed merge collapses too much, keep pixel-level Felzenszwalb.
      if (segResult.regionCount < minStableRegions) {
        segResult = felzenszwalbSegment(width, height, origR, origG, origB, seg.barrier, seg, params);
        mergeMs = 0;
      }
    } else {
      segResult = felzenszwalbSegment(width, height, origR, origG, origB, seg.barrier, seg, params);
    }
  } else {
    segResult = felzenszwalbSegment(width, height, origR, origG, origB, seg.barrier, seg, params);
  }
  const felzMs = performance.now() - felzStarted;

  if (segResult.regionCount <= 0) {
    return {
      image: grayscaleToRgba(tone),
      felzMs,
      felzInitialRegions: segResult.initialRegions,
      felzFinalRegions: 0,
      felzEdgeCount: segResult.edgeCount,
      watershedMs,
      mergeMs,
      fusionMs,
      crfMs,
    };
  }

  if (params.multiScaleEnabled && segResult.regionCount > 1) {
    const fuseStart = performance.now();
    seg.queue.set(seg.labels);
    seg.labelsAux.set(seg.labels);

    const coarseParams = {
      ...params,
      felzK: params.felzK * params.multiScaleKFactor,
      felzMinSize: Math.max(params.felzMinSize, Math.round(params.felzMinSize * params.multiScaleMinFactor)),
    };
    const coarse = felzenszwalbSegment(width, height, origR, origG, origB, seg.barrier, seg, coarseParams);
    const fusedCount = fuseFineWithCoarse(
      seg.labelsAux,
      segResult.regionCount,
      seg.labels,
      seg.barrier,
      width,
      height,
      seg,
      params
    );
    const minAllowed = Math.max(minStableRegions, Math.round(segResult.regionCount * 0.35));
    if (fusedCount >= minAllowed) {
      seg.labels.set(seg.labelsAux);
      segResult.regionCount = fusedCount;
      segResult.edgeCount = Math.max(segResult.edgeCount, coarse.edgeCount);
    } else {
      // Fusion too aggressive: revert to fine labels.
      seg.labels.set(seg.queue);
    }
    fusionMs = performance.now() - fuseStart;
  }

  let stats = computeRegionStatsAndCompact(seg.labels, gray, seg.barrier, n, segResult.regionCount);
  if (stats.regionCount <= 0) {
    return {
      image: grayscaleToRgba(tone),
      felzMs,
      felzInitialRegions: segResult.initialRegions,
      felzFinalRegions: 0,
      felzEdgeCount: segResult.edgeCount,
      watershedMs,
      mergeMs,
      fusionMs,
      crfMs,
    };
  }

  if (params.regionMergeEnabled && stats.regionCount > 1) {
    const merged = mergeSimilarAdjacentRegions(
      seg.labels,
      seg.barrier,
      width,
      height,
      stats.regionCount,
      gray,
      origR,
      origG,
      origB,
      params,
      seg
    );
    if (merged.regionCount > 0 && merged.regionCount < stats.regionCount) {
      segResult.regionCount = merged.regionCount;
      stats = computeRegionStatsAndCompact(seg.labels, gray, seg.barrier, n, merged.regionCount);
      if (stats.regionCount <= 0) {
        return {
          image: grayscaleToRgba(tone),
          felzMs,
          felzInitialRegions: segResult.initialRegions,
          felzFinalRegions: 0,
          felzEdgeCount: segResult.edgeCount,
          watershedMs,
          mergeMs,
          fusionMs,
          crfMs,
        };
      }
    }
  }

  const adjacency = buildRegionBoundaryGraph(seg.labels, width, height, stats.regionCount);
  const score = computeRegionScore(adjacency, stats.meanGray, stats.regionCount);
  const rankScore = combineVoteAndGrayRank(
    score,
    stats.meanGray,
    stats.regionCount,
    params.rankVoteWeight,
    params.rankGrayWeight
  );
  const blackRegion = chooseTopRegions(rankScore, stats.regionCount, params.regionTopPercent);

  for (let i = 0; i < n; i += 1) {
    if (seg.barrier[i]) {
      seg.crfA[i] = 0;
      continue;
    }
    const id = seg.labels[i];
    seg.crfA[i] = id > 0 && blackRegion[id] ? 1 : 0;
  }

  if (params.crfEnabled && params.crfIters > 0) {
    const crfStart = performance.now();
    crfRefineBinaryMask(seg.crfA, seg.crfB, seg.crfPrior, origR, origG, origB, seg.barrier, width, height, params);
    crfMs = performance.now() - crfStart;
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 1) {
    let c = 255;
    if (!seg.barrier[i] && seg.crfA[i] >= 0.5) {
      c = 0;
    }
    const base = i * 4;
    out[base] = c;
    out[base + 1] = c;
    out[base + 2] = c;
    out[base + 3] = 255;
  }

  return {
    image: out,
    felzMs,
    felzInitialRegions: segResult.initialRegions,
    felzFinalRegions: stats.regionCount,
    felzEdgeCount: segResult.edgeCount,
    watershedMs,
    mergeMs,
    fusionMs,
    crfMs,
  };
}

function buildLineMask(tone, outMask, lineThreshold, n) {
  for (let i = 0; i < n; i += 1) {
    outMask[i] = tone[i] >= lineThreshold ? 1 : 0;
  }
}

function erodeBinary(src, dst, temp, width, height, radius) {
  if (radius <= 0) {
    dst.set(src);
    return;
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let v = 1;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const xx = clampInt(x + dx, 0, width - 1);
        if (!src[row + xx]) {
          v = 0;
          break;
        }
      }
      temp[row + x] = v;
    }
  }

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let v = 1;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = clampInt(y + dy, 0, height - 1);
        if (!temp[yy * width + x]) {
          v = 0;
          break;
        }
      }
      dst[y * width + x] = v;
    }
  }
}

function dilateBinary(src, dst, temp, width, height, radius) {
  if (radius <= 0) {
    dst.set(src);
    return;
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let v = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const xx = clampInt(x + dx, 0, width - 1);
        if (src[row + xx]) {
          v = 1;
          break;
        }
      }
      temp[row + x] = v;
    }
  }

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let v = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = clampInt(y + dy, 0, height - 1);
        if (temp[yy * width + x]) {
          v = 1;
          break;
        }
      }
      dst[y * width + x] = v;
    }
  }
}

function removeSmallBinaryComponents(mask, width, height, minArea, queue, visited) {
  const n = mask.length;
  visited.fill(0);

  for (let start = 0; start < n; start += 1) {
    if (!mask[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx / width) | 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const nb = ny * width + nx;
          if (mask[nb] && !visited[nb]) {
            visited[nb] = 1;
            queue[tail++] = nb;
          }
        }
      }
    }

    if (tail < minArea) {
      for (let i = 0; i < tail; i += 1) {
        mask[queue[i]] = 0;
      }
    }
  }
}

function binaryRatio(buffer) {
  let count = 0;
  const n = buffer.length;
  for (let i = 0; i < n; i += 1) {
    if (buffer[i]) count += 1;
  }
  return n > 0 ? count / n : 0;
}

function watershedInitialSegmentation(seg, width, height, n, params) {
  computeChamferDistance(seg.barrier, seg.dist, width, height, n);
  const spacing = Math.max(2, Math.round(params.wsSeedSpacing));
  const minDist = params.wsSeedMinDist;
  let seedCount = placeGridSeeds(seg.dist, seg.barrier, seg.labels, width, height, spacing, minDist);
  seedCount = ensureSeedPerComponent(seg.dist, seg.barrier, seg.labels, seg.visited, seg.queue, width, height, n, seedCount);
  seedCount = propagateLabels(seg.barrier, seg.labels, seg.queue, width, height, n, seedCount);
  return seedCount;
}

function computeChamferDistance(barrier, dist, width, height, n) {
  const inf = 1e9;
  for (let i = 0; i < n; i += 1) {
    dist[i] = barrier[i] ? 0 : inf;
  }

  const d1 = 1;
  const d2 = 1.41421356;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      let best = dist[idx];
      if (x > 0) best = Math.min(best, dist[idx - 1] + d1);
      if (y > 0) best = Math.min(best, dist[idx - width] + d1);
      if (x > 0 && y > 0) best = Math.min(best, dist[idx - width - 1] + d2);
      if (x + 1 < width && y > 0) best = Math.min(best, dist[idx - width + 1] + d2);
      dist[idx] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x -= 1) {
      const idx = row + x;
      let best = dist[idx];
      if (x + 1 < width) best = Math.min(best, dist[idx + 1] + d1);
      if (y + 1 < height) best = Math.min(best, dist[idx + width] + d1);
      if (x + 1 < width && y + 1 < height) best = Math.min(best, dist[idx + width + 1] + d2);
      if (x > 0 && y + 1 < height) best = Math.min(best, dist[idx + width - 1] + d2);
      dist[idx] = best;
    }
  }
}

function placeGridSeeds(dist, barrier, labels, width, height, spacing, minDist) {
  labels.fill(0);
  let seedCount = 0;

  for (let i = 0; i < labels.length; i += 1) {
    if (barrier[i]) labels[i] = -1;
  }

  for (let y0 = 0; y0 < height; y0 += spacing) {
    const y1 = Math.min(height, y0 + spacing);
    for (let x0 = 0; x0 < width; x0 += spacing) {
      const x1 = Math.min(width, x0 + spacing);
      let best = -1;
      let bestDist = -1;

      for (let y = y0; y < y1; y += 1) {
        const row = y * width;
        for (let x = x0; x < x1; x += 1) {
          const idx = row + x;
          if (barrier[idx]) continue;
          const d = dist[idx];
          if (d > bestDist) {
            bestDist = d;
            best = idx;
          }
        }
      }

      if (best >= 0 && bestDist >= minDist && labels[best] === 0) {
        seedCount += 1;
        labels[best] = seedCount;
      }
    }
  }

  return seedCount;
}

function ensureSeedPerComponent(dist, barrier, labels, visited, queue, width, height, n, seedCount) {
  visited.fill(0);
  let nextSeed = seedCount;

  for (let start = 0; start < n; start += 1) {
    if (barrier[start] || visited[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let hasSeed = false;
    let bestIdx = start;
    let bestDist = dist[start];

    while (head < tail) {
      const idx = queue[head++];
      if (labels[idx] > 0) hasSeed = true;

      const d = dist[idx];
      if (d > bestDist) {
        bestDist = d;
        bestIdx = idx;
      }

      const x = idx % width;
      const y = (idx / width) | 0;

      if (x > 0) {
        const nb = idx - 1;
        if (!barrier[nb] && !visited[nb]) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (x + 1 < width) {
        const nb = idx + 1;
        if (!barrier[nb] && !visited[nb]) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (y > 0) {
        const nb = idx - width;
        if (!barrier[nb] && !visited[nb]) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
      if (y + 1 < height) {
        const nb = idx + width;
        if (!barrier[nb] && !visited[nb]) {
          visited[nb] = 1;
          queue[tail++] = nb;
        }
      }
    }

    if (!hasSeed) {
      nextSeed += 1;
      labels[bestIdx] = nextSeed;
    }
  }

  return nextSeed;
}

function propagateLabels(barrier, labels, queue, width, height, n, seedCount) {
  let head = 0;
  let tail = 0;

  for (let i = 0; i < n; i += 1) {
    if (labels[i] > 0) queue[tail++] = i;
  }

  while (head < tail) {
    const idx = queue[head++];
    const label = labels[idx];
    const x = idx % width;
    const y = (idx / width) | 0;

    if (x > 0) {
      const nb = idx - 1;
      if (!barrier[nb] && labels[nb] === 0) {
        labels[nb] = label;
        queue[tail++] = nb;
      }
    }
    if (x + 1 < width) {
      const nb = idx + 1;
      if (!barrier[nb] && labels[nb] === 0) {
        labels[nb] = label;
        queue[tail++] = nb;
      }
    }
    if (y > 0) {
      const nb = idx - width;
      if (!barrier[nb] && labels[nb] === 0) {
        labels[nb] = label;
        queue[tail++] = nb;
      }
    }
    if (y + 1 < height) {
      const nb = idx + width;
      if (!barrier[nb] && labels[nb] === 0) {
        labels[nb] = label;
        queue[tail++] = nb;
      }
    }
  }

  let maxLabel = seedCount;
  for (let i = 0; i < n; i += 1) {
    if (!barrier[i] && labels[i] === 0) {
      maxLabel += 1;
      labels[i] = maxLabel;
    }
  }
  return maxLabel;
}

function computeRegionColorStatsAndCompact(labels, origR, origG, origB, barrier, n, maxLabel) {
  const sizeRaw = new Int32Array(maxLabel + 1);
  const sumRRaw = new Float64Array(maxLabel + 1);
  const sumGRaw = new Float64Array(maxLabel + 1);
  const sumBRaw = new Float64Array(maxLabel + 1);

  for (let i = 0; i < n; i += 1) {
    const id = labels[i];
    if (id > 0 && !barrier[i]) {
      sizeRaw[id] += 1;
      sumRRaw[id] += origR[i];
      sumGRaw[id] += origG[i];
      sumBRaw[id] += origB[i];
    }
  }

  const remap = new Int32Array(maxLabel + 1);
  let regionCount = 0;
  for (let id = 1; id <= maxLabel; id += 1) {
    if (sizeRaw[id] > 0) {
      regionCount += 1;
      remap[id] = regionCount;
    }
  }

  const size = new Int32Array(regionCount + 1);
  const meanR = new Float32Array(regionCount + 1);
  const meanG = new Float32Array(regionCount + 1);
  const meanB = new Float32Array(regionCount + 1);

  for (let id = 1; id <= maxLabel; id += 1) {
    const mapped = remap[id];
    if (!mapped) continue;
    const s = Math.max(1, sizeRaw[id]);
    size[mapped] = sizeRaw[id];
    meanR[mapped] = sumRRaw[id] / s;
    meanG[mapped] = sumGRaw[id] / s;
    meanB[mapped] = sumBRaw[id] / s;
  }

  for (let i = 0; i < n; i += 1) {
    if (barrier[i]) {
      labels[i] = 0;
      continue;
    }
    const id = labels[i];
    labels[i] = id > 0 ? remap[id] : 0;
  }

  return {
    regionCount,
    size,
    meanR,
    meanG,
    meanB,
  };
}

function buildRegionMergeEdges(labels, width, height, regionCount, meanR, meanG, meanB, barrier, linePenalty) {
  const stride = regionCount + 1;
  const map = new Map();

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      const a = labels[idx];
      if (a <= 0) continue;

      if (x + 1 < width) {
        const nb = idx + 1;
        const b = labels[nb];
        if (b > 0 && b !== a) {
          const lo = a < b ? a : b;
          const hi = a < b ? b : a;
          const key = lo * stride + hi;
          const rec = map.get(key) || { a: lo, b: hi, len: 0, line: 0 };
          rec.len += 1;
          if (barrier[idx] || barrier[nb]) rec.line += 1;
          map.set(key, rec);
        }
      }
      if (y + 1 < height) {
        const nb = idx + width;
        const b = labels[nb];
        if (b > 0 && b !== a) {
          const lo = a < b ? a : b;
          const hi = a < b ? b : a;
          const key = lo * stride + hi;
          const rec = map.get(key) || { a: lo, b: hi, len: 0, line: 0 };
          rec.len += 1;
          if (barrier[idx] || barrier[nb]) rec.line += 1;
          map.set(key, rec);
        }
      }
    }
  }

  const edges = [];
  for (const rec of map.values()) {
    const dr = meanR[rec.a] - meanR[rec.b];
    const dg = meanG[rec.a] - meanG[rec.b];
    const db = meanB[rec.a] - meanB[rec.b];
    const colorDiff = Math.sqrt(dr * dr + dg * dg + db * db) * 255;
    const lineRatio = rec.line / Math.max(1, rec.len);
    edges.push({
      a: rec.a,
      b: rec.b,
      w: colorDiff + linePenalty * lineRatio,
      lineRatio,
    });
  }
  edges.sort((a, b) => a.w - b.w);
  return edges;
}

function felzenszwalbMergeFromWatershed(labels, maxLabel, width, height, origR, origG, origB, barrier, params) {
  const n = labels.length;
  const stats = computeRegionColorStatsAndCompact(labels, origR, origG, origB, barrier, n, maxLabel);
  const regionCount = stats.regionCount;
  if (regionCount <= 1) {
    return { regionCount, edgeCount: 0 };
  }

  const edges = buildRegionMergeEdges(
    labels,
    width,
    height,
    regionCount,
    stats.meanR,
    stats.meanG,
    stats.meanB,
    barrier,
    params.linePenalty
  );
  if (edges.length === 0) {
    return { regionCount, edgeCount: 0 };
  }

  const parent = new Int32Array(regionCount + 1);
  const compSize = new Int32Array(regionCount + 1);
  const intDiff = new Float32Array(regionCount + 1);
  for (let i = 1; i <= regionCount; i += 1) {
    parent[i] = i;
    compSize[i] = Math.max(1, stats.size[i]);
    intDiff[i] = 0;
  }

  const k = params.felzK;
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const ru = findRoot(parent, edge.a);
    const rv = findRoot(parent, edge.b);
    if (ru === rv) continue;
    const thrU = intDiff[ru] + k / compSize[ru];
    const thrV = intDiff[rv] + k / compSize[rv];
    if (edge.w <= thrU && edge.w <= thrV) {
      unionRoots(ru, rv, edge.w, parent, compSize, intDiff);
    }
  }

  const minSize = Math.max(0, Math.round(params.felzMinSize));
  if (minSize > 1) {
    for (let i = 0; i < edges.length; i += 1) {
      const edge = edges[i];
      if (edge.lineRatio > 0.4) continue;
      const ru = findRoot(parent, edge.a);
      const rv = findRoot(parent, edge.b);
      if (ru === rv) continue;
      if (compSize[ru] < minSize || compSize[rv] < minSize) {
        unionRoots(ru, rv, edge.w, parent, compSize, intDiff);
      }
    }
  }

  const rootToCompact = new Int32Array(regionCount + 1);
  let compactCount = 0;
  for (let i = 0; i < n; i += 1) {
    if (barrier[i]) {
      labels[i] = 0;
      continue;
    }
    const id = labels[i];
    if (id <= 0) continue;
    const root = findRoot(parent, id);
    let mapped = rootToCompact[root];
    if (!mapped) {
      compactCount += 1;
      mapped = compactCount;
      rootToCompact[root] = mapped;
    }
    labels[i] = mapped;
  }

  return {
    regionCount: compactCount,
    edgeCount: edges.length,
  };
}

function fuseFineWithCoarse(fineLabels, fineRegionCount, coarseLabels, barrier, width, height, seg, params) {
  if (fineRegionCount <= 1) return fineRegionCount;
  const parent = seg.parent;
  const size = seg.compSize;
  const rootMap = seg.rootMap;
  const smallLimit = Math.max(1, Math.round(params.felzMinSize * params.multiScaleMinFactor));

  for (let i = 1; i <= fineRegionCount; i += 1) {
    parent[i] = i;
    size[i] = 0;
    rootMap[i] = 0;
  }

  for (let i = 0; i < fineLabels.length; i += 1) {
    const id = fineLabels[i];
    if (id > 0) size[id] += 1;
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      if (barrier[idx]) continue;

      if (x + 1 < width) {
        const nb = idx + 1;
        if (!barrier[nb]) {
          const fa = fineLabels[idx];
          const fb = fineLabels[nb];
          const canMerge = size[fa] <= smallLimit || size[fb] <= smallLimit;
          if (fa > 0 && fb > 0 && fa !== fb && coarseLabels[idx] === coarseLabels[nb] && canMerge) {
            unionSimple(fa, fb, parent, size);
          }
        }
      }
      if (y + 1 < height) {
        const nb = idx + width;
        if (!barrier[nb]) {
          const fa = fineLabels[idx];
          const fb = fineLabels[nb];
          const canMerge = size[fa] <= smallLimit || size[fb] <= smallLimit;
          if (fa > 0 && fb > 0 && fa !== fb && coarseLabels[idx] === coarseLabels[nb] && canMerge) {
            unionSimple(fa, fb, parent, size);
          }
        }
      }
    }
  }

  let compactCount = 0;
  for (let i = 0; i < fineLabels.length; i += 1) {
    if (barrier[i]) {
      fineLabels[i] = 0;
      continue;
    }
    const id = fineLabels[i];
    if (id <= 0) continue;
    const root = findRoot(parent, id);
    let mapped = rootMap[root];
    if (!mapped) {
      compactCount += 1;
      mapped = compactCount;
      rootMap[root] = mapped;
    }
    fineLabels[i] = mapped;
  }

  return compactCount;
}

function unionSimple(a0, b0, parent, size) {
  let a = findRoot(parent, a0);
  let b = findRoot(parent, b0);
  if (a === b) return a;
  if (size[a] < size[b]) {
    const t = a;
    a = b;
    b = t;
  }
  parent[b] = a;
  size[a] += size[b];
  return a;
}

function crfRefineBinaryMask(maskA, maskB, prior, origR, origG, origB, barrier, width, height, params) {
  prior.set(maskA);

  const iters = Math.max(0, Math.round(params.crfIters));
  if (iters <= 0) return;

  const unaryWeight = params.crfUnaryWeight;
  const pairWeight = params.crfPairWeight;
  const sigma = Math.max(1, params.crfColorSigma);
  const invSigma2 = 1 / (sigma * sigma);

  let current = maskA;
  let next = maskB;

  for (let iter = 0; iter < iters; iter += 1) {
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        const idx = row + x;
        if (barrier[idx]) {
          next[idx] = 0;
          continue;
        }

        const unary = unaryWeight * ((prior[idx] - 0.5) * 2);
        let smooth = 0;
        let wsum = 0;

        if (x > 0) {
          const nb = idx - 1;
          if (!barrier[nb]) {
            const dr = (origR[idx] - origR[nb]) * 255;
            const dg = (origG[idx] - origG[nb]) * 255;
            const db = (origB[idx] - origB[nb]) * 255;
            const w = Math.exp(-(dr * dr + dg * dg + db * db) * invSigma2);
            smooth += w * ((current[nb] - 0.5) * 2);
            wsum += w;
          }
        }
        if (x + 1 < width) {
          const nb = idx + 1;
          if (!barrier[nb]) {
            const dr = (origR[idx] - origR[nb]) * 255;
            const dg = (origG[idx] - origG[nb]) * 255;
            const db = (origB[idx] - origB[nb]) * 255;
            const w = Math.exp(-(dr * dr + dg * dg + db * db) * invSigma2);
            smooth += w * ((current[nb] - 0.5) * 2);
            wsum += w;
          }
        }
        if (y > 0) {
          const nb = idx - width;
          if (!barrier[nb]) {
            const dr = (origR[idx] - origR[nb]) * 255;
            const dg = (origG[idx] - origG[nb]) * 255;
            const db = (origB[idx] - origB[nb]) * 255;
            const w = Math.exp(-(dr * dr + dg * dg + db * db) * invSigma2);
            smooth += w * ((current[nb] - 0.5) * 2);
            wsum += w;
          }
        }
        if (y + 1 < height) {
          const nb = idx + width;
          if (!barrier[nb]) {
            const dr = (origR[idx] - origR[nb]) * 255;
            const dg = (origG[idx] - origG[nb]) * 255;
            const db = (origB[idx] - origB[nb]) * 255;
            const w = Math.exp(-(dr * dr + dg * dg + db * db) * invSigma2);
            smooth += w * ((current[nb] - 0.5) * 2);
            wsum += w;
          }
        }

        const pair = wsum > EPS ? pairWeight * (smooth / wsum) : 0;
        const logit = unary + pair;
        const z = Math.max(-20, Math.min(20, logit));
        next[idx] = 1 / (1 + Math.exp(-z));
      }
    }
    const tmp = current;
    current = next;
    next = tmp;
  }

  if (current !== maskA) {
    maskA.set(current);
  }
}

function buildFelzenszwalbEdges(width, height, origR, origG, origB, barrier, edgeU, edgeV, edgeW, edgeCross, linePenalty) {
  let edgeCount = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      if (x + 1 < width) {
        const nb = idx + 1;
        const dr = origR[idx] - origR[nb];
        const dg = origG[idx] - origG[nb];
        const db = origB[idx] - origB[nb];
        const colorDiff = Math.sqrt(dr * dr + dg * dg + db * db) * 255;
        const cross = barrier[idx] || barrier[nb] ? 1 : 0;
        edgeU[edgeCount] = idx;
        edgeV[edgeCount] = nb;
        edgeCross[edgeCount] = cross;
        edgeW[edgeCount] = colorDiff + (cross ? linePenalty : 0);
        edgeCount += 1;
      }
      if (y + 1 < height) {
        const nb = idx + width;
        const dr = origR[idx] - origR[nb];
        const dg = origG[idx] - origG[nb];
        const db = origB[idx] - origB[nb];
        const colorDiff = Math.sqrt(dr * dr + dg * dg + db * db) * 255;
        const cross = barrier[idx] || barrier[nb] ? 1 : 0;
        edgeU[edgeCount] = idx;
        edgeV[edgeCount] = nb;
        edgeCross[edgeCount] = cross;
        edgeW[edgeCount] = colorDiff + (cross ? linePenalty : 0);
        edgeCount += 1;
      }
    }
  }

  return edgeCount;
}

function felzenszwalbSegment(width, height, origR, origG, origB, barrier, seg, params) {
  const n = width * height;
  const edgeCount = buildFelzenszwalbEdges(
    width,
    height,
    origR,
    origG,
    origB,
    barrier,
    seg.edgeU,
    seg.edgeV,
    seg.edgeW,
    seg.edgeCross,
    params.linePenalty
  );

  const parent = seg.parent;
  const compSize = seg.compSize;
  const intDiff = seg.intDiff;
  const order = seg.edgeOrder;
  const labels = seg.labels;
  const rootMap = seg.rootMap;

  let initialRegions = 0;
  for (let i = 0; i < n; i += 1) {
    parent[i] = i;
    compSize[i] = 1;
    intDiff[i] = 0;
    if (!barrier[i]) initialRegions += 1;
  }

  for (let i = 0; i < edgeCount; i += 1) {
    order[i] = i;
  }
  order.subarray(0, edgeCount).sort((a, b) => seg.edgeW[a] - seg.edgeW[b]);

  const k = params.felzK;
  for (let oi = 0; oi < edgeCount; oi += 1) {
    const ei = order[oi];
    const u = seg.edgeU[ei];
    const v = seg.edgeV[ei];
    let ru = findRoot(parent, u);
    let rv = findRoot(parent, v);
    if (ru === rv) continue;

    const w = seg.edgeW[ei];
    const thrU = intDiff[ru] + k / compSize[ru];
    const thrV = intDiff[rv] + k / compSize[rv];
    if (w <= thrU && w <= thrV) {
      unionRoots(ru, rv, w, parent, compSize, intDiff);
    }
  }

  const minSize = Math.max(0, Math.round(params.felzMinSize));
  if (minSize > 1) {
    for (let oi = 0; oi < edgeCount; oi += 1) {
      const ei = order[oi];
      if (seg.edgeCross[ei]) continue;
      const u = seg.edgeU[ei];
      const v = seg.edgeV[ei];
      let ru = findRoot(parent, u);
      let rv = findRoot(parent, v);
      if (ru === rv) continue;
      if (compSize[ru] < minSize || compSize[rv] < minSize) {
        const w = seg.edgeW[ei];
        unionRoots(ru, rv, w, parent, compSize, intDiff);
      }
    }
  }

  rootMap.fill(0);
  let regionCount = 0;
  for (let i = 0; i < n; i += 1) {
    const root = findRoot(parent, i);
    let id = rootMap[root];
    if (!id) {
      regionCount += 1;
      id = regionCount;
      rootMap[root] = id;
    }
    labels[i] = id;
  }

  return {
    edgeCount,
    initialRegions,
    regionCount,
  };
}

function unionRoots(ra, rb, edgeWeight, parent, compSize, intDiff) {
  let a = ra;
  let b = rb;
  if (compSize[a] < compSize[b]) {
    a = rb;
    b = ra;
  }

  parent[b] = a;
  compSize[a] += compSize[b];
  intDiff[a] = Math.max(edgeWeight, intDiff[a], intDiff[b]);
  return a;
}

function findRoot(parent, x) {
  let r = x;
  while (parent[r] !== r) r = parent[r];
  while (parent[x] !== x) {
    const p = parent[x];
    parent[x] = r;
    x = p;
  }
  return r;
}

function computeRegionStatsAndCompact(labels, gray, barrier, n, maxLabel) {
  const sizeRaw = new Int32Array(maxLabel + 1);
  const sumGrayRaw = new Float64Array(maxLabel + 1);

  for (let i = 0; i < n; i += 1) {
    const id = labels[i];
    if (id > 0 && !barrier[i]) {
      sizeRaw[id] += 1;
      sumGrayRaw[id] += gray[i];
    }
  }

  const remap = new Int32Array(maxLabel + 1);
  let regionCount = 0;
  for (let id = 1; id <= maxLabel; id += 1) {
    if (sizeRaw[id] > 0) {
      regionCount += 1;
      remap[id] = regionCount;
    }
  }

  const size = new Int32Array(regionCount + 1);
  const sumGray = new Float64Array(regionCount + 1);
  const meanGray = new Float32Array(regionCount + 1);

  for (let id = 1; id <= maxLabel; id += 1) {
    const mapped = remap[id];
    if (!mapped) continue;
    size[mapped] = sizeRaw[id];
    sumGray[mapped] = sumGrayRaw[id];
  }

  for (let i = 0; i < n; i += 1) {
    if (barrier[i]) {
      labels[i] = 0;
      continue;
    }
    const id = labels[i];
    labels[i] = id > 0 ? remap[id] : 0;
  }

  for (let i = 1; i <= regionCount; i += 1) {
    meanGray[i] = sumGray[i] / Math.max(1, size[i]);
  }

  return {
    regionCount,
    meanGray,
  };
}

function buildRegionBoundaryGraph(labels, width, height, regionCount) {
  const adjacency = Array.from({ length: regionCount + 1 }, () => new Map());

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      const a = labels[idx];
      if (a <= 0) continue;

      if (x + 1 < width) {
        const b = labels[idx + 1];
        if (b > 0 && b !== a) addBoundaryEdge(adjacency, a, b, 1);
      }
      if (y + 1 < height) {
        const b = labels[idx + width];
        if (b > 0 && b !== a) addBoundaryEdge(adjacency, a, b, 1);
      }
    }
  }
  return adjacency;
}

function addBoundaryEdge(adjacency, a, b, len) {
  const ab = adjacency[a].get(b) || 0;
  const ba = adjacency[b].get(a) || 0;
  adjacency[a].set(b, ab + len);
  adjacency[b].set(a, ba + len);
}

function mergeSimilarAdjacentRegions(labels, barrier, width, height, regionCount, gray, origR, origG, origB, params, seg) {
  const n = labels.length;
  const parent = new Int32Array(regionCount + 1);
  const size = new Int32Array(regionCount + 1);
  const sumGray = new Float64Array(regionCount + 1);
  const sumR = new Float64Array(regionCount + 1);
  const sumG = new Float64Array(regionCount + 1);
  const sumB = new Float64Array(regionCount + 1);

  for (let i = 1; i <= regionCount; i += 1) {
    parent[i] = i;
  }

  for (let i = 0; i < n; i += 1) {
    if (barrier[i]) continue;
    const id = labels[i];
    if (id <= 0) continue;
    size[id] += 1;
    sumGray[id] += gray[i];
    sumR[id] += origR[i];
    sumG[id] += origG[i];
    sumB[id] += origB[i];
  }

  const stride = regionCount + 1;
  const edgeMap = new Map();
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      if (barrier[idx]) continue;
      const a = labels[idx];
      if (a <= 0) continue;

      if (x + 1 < width) {
        const nb = idx + 1;
        if (!barrier[nb]) {
          const b = labels[nb];
          if (b > 0 && b !== a) {
            const lo = a < b ? a : b;
            const hi = a < b ? b : a;
            const key = lo * stride + hi;
            edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
          }
        }
      }

      if (y + 1 < height) {
        const nb = idx + width;
        if (!barrier[nb]) {
          const b = labels[nb];
          if (b > 0 && b !== a) {
            const lo = a < b ? a : b;
            const hi = a < b ? b : a;
            const key = lo * stride + hi;
            edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
          }
        }
      }
    }
  }

  if (edgeMap.size === 0) {
    return { regionCount, mergeCount: 0 };
  }

  const edges = [];
  for (const [key, len] of edgeMap) {
    const a = (key / stride) | 0;
    const b = key - a * stride;
    edges.push({ a, b, len });
  }
  edges.sort((e1, e2) => e2.len - e1.len);

  const s = params.regionMergeStrength;
  const colorThr = 12 + 22 * s;
  const grayThr = 8 + 16 * s;
  const strongColorThr = 5 + 8 * s;
  const strongGrayThr = 4 + 7 * s;
  const smallAreaThr = Math.max(8, Math.round((width * height / 7000) * (1 + 2.2 * s)));
  const minBoundary = Math.max(1, Math.round(1 + 2 * s));
  const passes = Math.max(1, Math.round(params.regionMergePasses));

  let mergeCount = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;
    for (let i = 0; i < edges.length; i += 1) {
      const edge = edges[i];
      let ra = findRoot(parent, edge.a);
      let rb = findRoot(parent, edge.b);
      if (ra === rb) continue;

      const invA = 1 / Math.max(1, size[ra]);
      const invB = 1 / Math.max(1, size[rb]);
      const dr = (sumR[ra] * invA - sumR[rb] * invB) * 255;
      const dg = (sumG[ra] * invA - sumG[rb] * invB) * 255;
      const db = (sumB[ra] * invA - sumB[rb] * invB) * 255;
      const colorDiff = Math.sqrt(dr * dr + dg * dg + db * db);
      const grayDiff = Math.abs(sumGray[ra] * invA - sumGray[rb] * invB) * 255;
      const minArea = Math.min(size[ra], size[rb]);

      const veryClose = colorDiff <= strongColorThr && grayDiff <= strongGrayThr;
      const closeAndSmall =
        edge.len >= minBoundary && minArea <= smallAreaThr && colorDiff <= colorThr && grayDiff <= grayThr;
      const longBoundaryClose =
        edge.len >= minBoundary * 3 && colorDiff <= colorThr * 0.75 && grayDiff <= grayThr * 0.8;

      if (!(veryClose || closeAndSmall || longBoundaryClose)) continue;

      if (size[ra] < size[rb]) {
        const t = ra;
        ra = rb;
        rb = t;
      }
      parent[rb] = ra;
      size[ra] += size[rb];
      sumGray[ra] += sumGray[rb];
      sumR[ra] += sumR[rb];
      sumG[ra] += sumG[rb];
      sumB[ra] += sumB[rb];
      mergeCount += 1;
      changed = true;
    }
    if (!changed) break;
  }

  if (mergeCount === 0) {
    return { regionCount, mergeCount: 0 };
  }

  const rootMap = seg.rootMap;
  rootMap.fill(0);
  let compactCount = 0;
  for (let i = 0; i < n; i += 1) {
    if (barrier[i]) {
      labels[i] = 0;
      continue;
    }
    const id = labels[i];
    if (id <= 0) continue;
    const root = findRoot(parent, id);
    let mapped = rootMap[root];
    if (!mapped) {
      compactCount += 1;
      mapped = compactCount;
      rootMap[root] = mapped;
    }
    labels[i] = mapped;
  }

  return {
    regionCount: compactCount,
    mergeCount,
  };
}

function computeRegionScore(adjacency, meanGray, regionCount) {
  const score = new Float32Array(regionCount + 1);
  for (let i = 1; i <= regionCount; i += 1) {
    let s = 0;
    const map = adjacency[i];
    if (map) {
      for (const j of map.keys()) {
        s += meanGray[j] - meanGray[i];
      }
    }
    score[i] = s;
  }
  return score;
}

function combineVoteAndGrayRank(voteScore, meanGray, regionCount, voteWeight, grayWeight) {
  const out = new Float32Array(regionCount + 1);
  if (regionCount <= 0) return out;

  let minVote = Infinity;
  let maxVote = -Infinity;
  for (let i = 1; i <= regionCount; i += 1) {
    const v = voteScore[i];
    if (v < minVote) minVote = v;
    if (v > maxVote) maxVote = v;
  }
  const voteSpan = maxVote - minVote;

  const ids = [];
  for (let i = 1; i <= regionCount; i += 1) ids.push(i);
  // Darker mean gray should rank higher for black assignment.
  ids.sort((a, b) => meanGray[a] - meanGray[b]);

  const darkRank = new Float32Array(regionCount + 1);
  if (regionCount === 1) {
    darkRank[ids[0]] = 1;
  } else {
    const inv = 1 / (regionCount - 1);
    for (let r = 0; r < regionCount; r += 1) {
      darkRank[ids[r]] = 1 - r * inv;
    }
  }

  const wSum = Math.max(EPS, voteWeight + grayWeight);
  const wVote = voteWeight / wSum;
  const wGray = grayWeight / wSum;

  for (let i = 1; i <= regionCount; i += 1) {
    const voteNorm = voteSpan > EPS ? (voteScore[i] - minVote) / voteSpan : 0.5;
    out[i] = wVote * voteNorm + wGray * darkRank[i];
  }
  return out;
}

function chooseTopRegions(score, regionCount, topPercent) {
  const ids = [];
  for (let i = 1; i <= regionCount; i += 1) ids.push(i);
  ids.sort((a, b) => score[b] - score[a]);

  let blackCount = Math.round((topPercent / 100) * regionCount);
  blackCount = clampInt(blackCount, 1, regionCount);

  const black = new Uint8Array(regionCount + 1);
  for (let i = 0; i < blackCount; i += 1) {
    black[ids[i]] = 1;
  }
  return black;
}

function normalizeInPlace(buffer) {
  let min = Infinity;
  let max = -Infinity;
  const n = buffer.length;

  for (let i = 0; i < n; i += 1) {
    const v = buffer[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const span = max - min;
  if (!(span > EPS)) {
    buffer.fill(0);
    return;
  }

  const inv = 1 / span;
  for (let i = 0; i < n; i += 1) {
    buffer[i] = (buffer[i] - min) * inv;
  }
}

function applyContrastInPlace(buffer, contrast) {
  const n = buffer.length;
  for (let i = 0; i < n; i += 1) {
    const v = (buffer[i] - 0.5) * contrast + 0.5;
    buffer[i] = clamp01(v);
  }
}

function applyThresholdInPlace(buffer, threshold) {
  const n = buffer.length;
  for (let i = 0; i < n; i += 1) {
    buffer[i] = buffer[i] < threshold ? 0 : buffer[i];
  }
}

function applyClipAndScaleInPlace(buffer, clipMin, clipMax) {
  const n = buffer.length;
  const lo = Math.min(clipMin, clipMax);
  const hi = Math.max(clipMin, clipMax);
  const span = Math.max(EPS, hi - lo);

  for (let i = 0; i < n; i += 1) {
    const v = buffer[i];
    if (v <= lo) {
      buffer[i] = 0;
    } else if (v >= hi) {
      buffer[i] = 1;
    } else {
      buffer[i] = (v - lo) / span;
    }
  }
}

function boxBlur(src, dst, temp, width, height, radius) {
  if (radius <= 0) {
    dst.set(src);
    return;
  }

  const windowSize = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let ix = -radius; ix <= radius; ix += 1) {
      const x = clampInt(ix, 0, width - 1);
      sum += src[row + x];
    }
    for (let x = 0; x < width; x += 1) {
      temp[row + x] = sum / windowSize;
      const removeX = clampInt(x - radius, 0, width - 1);
      const addX = clampInt(x + radius + 1, 0, width - 1);
      sum += src[row + addX] - src[row + removeX];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let iy = -radius; iy <= radius; iy += 1) {
      const y = clampInt(iy, 0, height - 1);
      sum += temp[y * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      dst[y * width + x] = sum / windowSize;
      const removeY = clampInt(y - radius, 0, height - 1);
      const addY = clampInt(y + radius + 1, 0, height - 1);
      sum += temp[addY * width + x] - temp[removeY * width + x];
    }
  }
}

function grayscaleToRgba(buffer) {
  const n = buffer.length;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 1) {
    const c = Math.round(clamp01(buffer[i]) * 255);
    const base = i * 4;
    out[base] = c;
    out[base + 1] = c;
    out[base + 2] = c;
    out[base + 3] = 255;
  }
  return out;
}

function buildDistanceMap(width, height) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const fy = y <= height / 2 ? y : height - y;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const fx = x <= width / 2 ? x : width - x;
      out[row + x] = Math.sqrt(fx * fx + fy * fy);
    }
  }
  return out;
}

function fft2D(real, imag, width, height, inverse, scratch) {
  const rowReal = scratch.rowReal;
  const rowImag = scratch.rowImag;

  for (let y = 0; y < height; y += 1) {
    const offset = y * width;
    for (let x = 0; x < width; x += 1) {
      rowReal[x] = real[offset + x];
      rowImag[x] = imag[offset + x];
    }
    fft1D(rowReal, rowImag, inverse);
    for (let x = 0; x < width; x += 1) {
      real[offset + x] = rowReal[x];
      imag[offset + x] = rowImag[x];
    }
  }

  const colReal = scratch.colReal;
  const colImag = scratch.colImag;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      const idx = y * width + x;
      colReal[y] = real[idx];
      colImag[y] = imag[idx];
    }
    fft1D(colReal, colImag, inverse);
    for (let y = 0; y < height; y += 1) {
      const idx = y * width + x;
      real[idx] = colReal[y];
      imag[idx] = colImag[y];
    }
  }
}

function fft1D(real, imag, inverse) {
  const n = real.length;
  bitReversePermute(real, imag, n);

  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wlenR = Math.cos(angle);
    const wlenI = Math.sin(angle);
    const half = len >> 1;

    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < half; j += 1) {
        const uR = real[i + j];
        const uI = imag[i + j];
        const vIndex = i + j + half;
        const vR = real[vIndex] * wr - imag[vIndex] * wi;
        const vI = real[vIndex] * wi + imag[vIndex] * wr;

        real[i + j] = uR + vR;
        imag[i + j] = uI + vI;
        real[vIndex] = uR - vR;
        imag[vIndex] = uI - vI;

        const nextWr = wr * wlenR - wi * wlenI;
        wi = wr * wlenI + wi * wlenR;
        wr = nextWr;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i += 1) {
      real[i] *= invN;
      imag[i] *= invN;
    }
  }
}

function bitReversePermute(real, imag, n) {
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;

    if (i < j) {
      const tr = real[i];
      const ti = imag[i];
      real[i] = real[j];
      imag[i] = imag[j];
      real[j] = tr;
      imag[j] = ti;
    }
  }
}

function nextPow2(value) {
  let p = 1;
  while (p < value) p <<= 1;
  return p;
}

function clamp01(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function clampInt(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v | 0;
}

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
