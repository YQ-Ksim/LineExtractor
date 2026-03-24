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

  if (width <= 0 || height <= 0) {
    throw new Error("图像尺寸无效");
  }

  const rgba = new Uint8ClampedArray(message.data);
  const padW = nextPow2(width);
  const padH = nextPow2(height);
  const totalPad = padW * padH;
  const totalPix = width * height;

  const rSpatial = new Float32Array(totalPad);
  const gSpatial = new Float32Array(totalPad);
  const bSpatial = new Float32Array(totalPad);

  for (let y = 0; y < height; y += 1) {
    const srcRow = y * width * 4;
    const dstRow = y * padW;
    for (let x = 0; x < width; x += 1) {
      const src = srcRow + x * 4;
      const dst = dstRow + x;
      rSpatial[dst] = rgba[src];
      gSpatial[dst] = rgba[src + 1];
      bSpatial[dst] = rgba[src + 2];
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
  if (!state.ready) {
    throw new Error("图像尚未初始化");
  }

  const needRgba = options.needRgba !== false;
  const needKMap = Boolean(options.needKMap);
  const forceKMap = Boolean(options.forceKMap);
  const params = sanitizeParams(rawParams);

  const started = performance.now();
  let layer1Ms = 0;
  let layer2Ms = 0;
  let layer3Ms = 0;
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
    output = postprocess(params);
    layer3Ms = performance.now() - s;
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
  };

  if (safe.clipMin > safe.clipMax) {
    safe.clipMax = safe.clipMin;
  }
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

function postprocess(params) {
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

  return grayscaleToRgba(current);
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
