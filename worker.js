const EPS = 1e-8;
const INF_DIST = 1e9;

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
      grayOriginal[grayRow + x] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
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
  state.seg = {
    lineMask: new Uint8Array(totalPix),
    barrier: new Uint8Array(totalPix),
    tempU8: new Uint8Array(totalPix),
    dist: new Float32Array(totalPix),
    labels: new Int32Array(totalPix),
    queue: new Int32Array(totalPix),
    visited: new Uint8Array(totalPix),
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
      output = lineGuidedRegionBinarize(tone, params);
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
    segLineThreshold: clampNumber(params.segLineThreshold, 0.01, 0.99, 0.55),
    segDilateRadius: clampNumber(params.segDilateRadius, 0, 8, 1),
    segSeedSpacing: clampNumber(params.segSeedSpacing, 2, 64, 8),
    segSeedMinDist: clampNumber(params.segSeedMinDist, 0, 64, 1.2),
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
  const gray = state.grayOriginal;
  const seg = state.seg;

  // Layer3 line sketch is "black background + white lines",
  // so white pixels are treated as segmentation barriers.
  buildLineMask(tone, seg.lineMask, params.segLineThreshold, n);
  dilateBinary(seg.lineMask, seg.barrier, seg.tempU8, width, height, Math.round(params.segDilateRadius));
  computeChamferDistance(seg.barrier, seg.dist, width, height, n);

  const seedSpacing = Math.max(2, Math.round(params.segSeedSpacing));
  const seedMinDist = params.segSeedMinDist;
  let seedCount = placeGridSeeds(seg.dist, seg.barrier, seg.labels, width, height, seedSpacing, seedMinDist);
  seedCount = ensureSeedPerComponent(seg.dist, seg.barrier, seg.labels, seg.visited, seg.queue, width, height, n, seedCount);
  seedCount = propagateLabels(seg.barrier, seg.labels, seg.queue, width, height, n, seedCount);

  if (seedCount <= 0) {
    return grayscaleToRgba(tone);
  }

  const stats = computeRegionStatsAndCompact(seg.labels, gray, width, height, n, seedCount);
  const regionCount = stats.regionCount;
  if (regionCount <= 0) return grayscaleToRgba(tone);

  const adjacency = buildRegionAdjacency(seg.labels, width, height, regionCount);
  const score = computeRegionScore(adjacency, stats.meanGray, regionCount);
  const blackRegion = chooseTopRegions(score, regionCount, params.regionTopPercent);

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 1) {
    let c = 255;
    if (seg.barrier[i]) {
      c = 255;
    } else {
      const id = seg.labels[i];
      if (id > 0 && blackRegion[id]) c = 0;
    }
    const base = i * 4;
    out[base] = c;
    out[base + 1] = c;
    out[base + 2] = c;
    out[base + 3] = 255;
  }
  return out;
}

function buildLineMask(tone, outMask, lineThreshold, n) {
  for (let i = 0; i < n; i += 1) {
    outMask[i] = tone[i] >= lineThreshold ? 1 : 0;
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

function computeChamferDistance(barrier, dist, width, height, n) {
  for (let i = 0; i < n; i += 1) {
    dist[i] = barrier[i] ? 0 : INF_DIST;
  }

  const d1 = 1.0;
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
    if (labels[i] > 0) {
      queue[tail++] = i;
    }
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

  // Fallback for rare residual unlabeled pixels.
  let maxLabel = seedCount;
  for (let i = 0; i < n; i += 1) {
    if (!barrier[i] && labels[i] === 0) {
      maxLabel += 1;
      labels[i] = maxLabel;
    }
  }
  return maxLabel;
}

function computeRegionStatsAndCompact(labels, gray, width, height, n, maxLabel) {
  const size = new Int32Array(maxLabel + 1);
  const sumGray = new Float64Array(maxLabel + 1);

  for (let i = 0; i < n; i += 1) {
    const id = labels[i];
    if (id > 0) {
      size[id] += 1;
      sumGray[id] += gray[i];
    }
  }

  const remap = new Int32Array(maxLabel + 1);
  let regionCount = 0;
  for (let id = 1; id <= maxLabel; id += 1) {
    if (size[id] > 0) {
      regionCount += 1;
      remap[id] = regionCount;
    }
  }

  const meanGray = new Float32Array(regionCount + 1);
  if (regionCount === 0) {
    return { regionCount, meanGray };
  }

  for (let id = 1; id <= maxLabel; id += 1) {
    const mapped = remap[id];
    if (!mapped) continue;
    meanGray[mapped] = sumGray[id] / Math.max(1, size[id]);
  }

  for (let i = 0; i < n; i += 1) {
    const id = labels[i];
    if (id > 0) labels[i] = remap[id];
  }

  return { regionCount, meanGray };
}

function buildRegionAdjacency(labels, width, height, regionCount) {
  const adjacency = Array.from({ length: regionCount + 1 }, () => new Set());

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      const a = labels[idx];
      if (a <= 0) continue;

      if (x + 1 < width) {
        const b = labels[idx + 1];
        if (b > 0 && b !== a) {
          adjacency[a].add(b);
          adjacency[b].add(a);
        }
      }

      if (y + 1 < height) {
        const b = labels[idx + width];
        if (b > 0 && b !== a) {
          adjacency[a].add(b);
          adjacency[b].add(a);
        }
      }
    }
  }
  return adjacency;
}

function computeRegionScore(adjacency, meanGray, regionCount) {
  const score = new Float32Array(regionCount + 1);
  for (let i = 1; i <= regionCount; i += 1) {
    let s = 0;
    for (const j of adjacency[i]) {
      s += meanGray[j] - meanGray[i];
    }
    score[i] = s;
  }
  return score;
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
