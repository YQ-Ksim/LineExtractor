const MAX_BLUR_RADIUS = 6;
const GL_VERTEX_SHADER = `#version 300 es
precision highp float;
const vec2 POS[3] = vec2[](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
out vec2 vUv;
void main() {
  vec2 pos = POS[gl_VertexID];
  vUv = vec2(pos.x * 0.5 + 0.5, 1.0 - (pos.y * 0.5 + 0.5));
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;
const GL_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uKMap;
uniform vec2 uSize;
uniform float uKMin;
uniform float uKMax;
uniform float uNormalize;
uniform float uContrast;
uniform float uThreshold;
uniform float uClipMin;
uniform float uClipMax;
uniform float uBlur;
uniform float uSharpen;

in vec2 vUv;
out vec4 outColor;

float postBasic(float raw) {
  float v = raw;
  if (uNormalize > 0.5) {
    v = (v - uKMin) / max(uKMax - uKMin, 1e-6);
  }
  v = clamp((v - 0.5) * uContrast + 0.5, 0.0, 1.0);
  if (v < uThreshold) {
    v = 0.0;
  }
  if (v <= uClipMin) {
    v = 0.0;
  } else if (v >= uClipMax) {
    v = 1.0;
  } else {
    v = (v - uClipMin) / max(uClipMax - uClipMin, 1e-6);
  }
  return clamp(v, 0.0, 1.0);
}

float toneAt(ivec2 center, int radius, ivec2 size) {
  float sum = 0.0;
  float count = 0.0;

  for (int dy = -6; dy <= 6; dy++) {
    if (abs(dy) > radius) continue;
    for (int dx = -6; dx <= 6; dx++) {
      if (abs(dx) > radius) continue;
      ivec2 coord = clamp(center + ivec2(dx, dy), ivec2(0), size - ivec2(1));
      float raw = texelFetch(uKMap, coord, 0).r;
      sum += postBasic(raw);
      count += 1.0;
    }
  }

  if (count < 1.0) {
    float raw = texelFetch(uKMap, center, 0).r;
    return postBasic(raw);
  }
  return sum / count;
}

void main() {
  ivec2 size = ivec2(max(uSize.x, 1.0), max(uSize.y, 1.0));
  ivec2 center = ivec2(vUv * vec2(size));
  center = clamp(center, ivec2(0), size - ivec2(1));

  int blurRadius = int(clamp(floor(uBlur + 0.5), 0.0, 6.0));
  float base = toneAt(center, blurRadius, size);

  if (uSharpen > 0.0001) {
    float soft = toneAt(center, 1, size);
    base = clamp(base + uSharpen * (base - soft), 0.0, 1.0);
  }

  outColor = vec4(base, base, base, 1.0);
}
`;
const WGSL_SHADER = `
struct Params {
  v0: vec4<f32>, // kMin, kMax, normalize, contrast
  v1: vec4<f32>, // threshold, clipMin, clipMax, blur
  v2: vec4<f32>, // sharpen, width, height, reserved
  v3: vec4<f32>, // reserved
};

@group(0) @binding(0) var kMap: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: Params;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VSOut {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0)
  );
  var out: VSOut;
  out.pos = vec4<f32>(pos[index], 0.0, 1.0);
  out.uv = vec2<f32>(pos[index].x * 0.5 + 0.5, 1.0 - (pos[index].y * 0.5 + 0.5));
  return out;
}

fn post_basic(raw: f32) -> f32 {
  let k_min = params.v0.x;
  let k_max = params.v0.y;
  let normalize_on = params.v0.z;
  let contrast = params.v0.w;
  let threshold = params.v1.x;
  let clip_min = params.v1.y;
  let clip_max = params.v1.z;

  var v = raw;
  if (normalize_on > 0.5) {
    v = (v - k_min) / max(k_max - k_min, 1e-6);
  }
  v = clamp((v - 0.5) * contrast + 0.5, 0.0, 1.0);
  if (v < threshold) {
    v = 0.0;
  }

  if (v <= clip_min) {
    v = 0.0;
  } else if (v >= clip_max) {
    v = 1.0;
  } else {
    v = (v - clip_min) / max(clip_max - clip_min, 1e-6);
  }

  return clamp(v, 0.0, 1.0);
}

fn load_k(coord: vec2<i32>, dims: vec2<i32>) -> f32 {
  let max_c = dims - vec2<i32>(1, 1);
  let c = clamp(coord, vec2<i32>(0, 0), max_c);
  return textureLoad(kMap, c, 0).x;
}

fn tone_at(center: vec2<i32>, radius: i32, dims: vec2<i32>) -> f32 {
  var sum = 0.0;
  var count = 0.0;

  for (var dy = -6; dy <= 6; dy = dy + 1) {
    if (abs(dy) > radius) {
      continue;
    }
    for (var dx = -6; dx <= 6; dx = dx + 1) {
      if (abs(dx) > radius) {
        continue;
      }
      let raw = load_k(center + vec2<i32>(dx, dy), dims);
      sum = sum + post_basic(raw);
      count = count + 1.0;
    }
  }

  if (count < 1.0) {
    return post_basic(load_k(center, dims));
  }
  return sum / count;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let width = max(1, i32(params.v2.y));
  let height = max(1, i32(params.v2.z));
  let dims = vec2<i32>(width, height);
  let blur = i32(clamp(round(params.v1.w), 0.0, 6.0));
  let sharpen = params.v2.x;

  let fx = clamp(i32(uv.x * f32(width)), 0, width - 1);
  let fy = clamp(i32(uv.y * f32(height)), 0, height - 1);
  let center = vec2<i32>(fx, fy);

  var base = tone_at(center, blur, dims);
  if (sharpen > 1e-4) {
    let soft = tone_at(center, 1, dims);
    base = clamp(base + sharpen * (base - soft), 0.0, 1.0);
  }

  return vec4<f32>(base, base, base, 1.0);
}
`;
export class HybridGpuRenderer {
    canvas;
    backend;
    ready;
    kReady;
    width;
    height;
    kRange;
    gl;
    glProgram;
    glTexture;
    glUniforms;
    device;
    wgpuContext;
    wgpuFormat;
    wgpuPipeline;
    wgpuUniformBuffer;
    wgpuBindGroup;
    wgpuTexture;
    wgpuTextureWidth;
    wgpuTextureHeight;
    wgpuUniformData;
    constructor() {
        this.canvas = document.createElement("canvas");
        this.canvas.width = 1;
        this.canvas.height = 1;
        this.backend = "cpu";
        this.ready = false;
        this.kReady = false;
        this.width = 1;
        this.height = 1;
        this.kRange = { min: 0, max: 1 };
        this.gl = null;
        this.glProgram = null;
        this.glTexture = null;
        this.glUniforms = null;
        this.device = null;
        this.wgpuContext = null;
        this.wgpuFormat = null;
        this.wgpuPipeline = null;
        this.wgpuUniformBuffer = null;
        this.wgpuBindGroup = null;
        this.wgpuTexture = null;
        this.wgpuTextureWidth = 0;
        this.wgpuTextureHeight = 0;
        this.wgpuUniformData = new Float32Array(16);
    }
    async initialize(preference) {
        this.destroy();
        if (preference === "cpu") {
            return { available: false, backend: "cpu", reason: "forced-cpu" };
        }
        const tryList = pickTryList(preference);
        for (const backend of tryList) {
            if (backend === "webgpu") {
                const ok = await this.initWebGpu();
                if (ok)
                    return { available: true, backend: this.backend, reason: "" };
            }
            else {
                const ok = this.initWebGl2();
                if (ok)
                    return { available: true, backend: this.backend, reason: "" };
            }
        }
        this.destroy();
        return { available: false, backend: "cpu", reason: "gpu-unavailable" };
    }
    isReady() {
        return this.ready;
    }
    hasKMap() {
        return this.kReady;
    }
    resetKMap() {
        this.kReady = false;
        this.kRange = { min: 0, max: 1 };
    }
    ensureSize(width, height) {
        if (this.width === width && this.height === height)
            return;
        this.width = width;
        this.height = height;
        this.canvas.width = width;
        this.canvas.height = height;
        if (this.backend === "webgpu" && this.device && this.wgpuContext && this.wgpuFormat) {
            this.wgpuContext.configure({
                device: this.device,
                format: this.wgpuFormat,
                alphaMode: "opaque",
            });
        }
    }
    uploadKMap(floatBuffer, width, height, kRange) {
        if (!this.ready)
            return false;
        this.ensureSize(width, height);
        this.kRange = {
            min: Number.isFinite(kRange.min) ? kRange.min : 0,
            max: Number.isFinite(kRange.max) ? kRange.max : 1,
        };
        if (this.backend === "webgl")
            return this.uploadKMapWebGl(floatBuffer, width, height);
        if (this.backend === "webgpu")
            return this.uploadKMapWebGpu(floatBuffer, width, height);
        return false;
    }
    render(params) {
        if (!this.ready || !this.kReady)
            return 0;
        const started = performance.now();
        if (this.backend === "webgl") {
            this.renderWebGl(params);
        }
        else if (this.backend === "webgpu") {
            this.renderWebGpu(params);
        }
        return performance.now() - started;
    }
    destroy() {
        if (this.gl && this.glTexture) {
            this.gl.deleteTexture(this.glTexture);
        }
        if (this.gl && this.glProgram) {
            this.gl.deleteProgram(this.glProgram);
        }
        this.gl = null;
        this.glProgram = null;
        this.glTexture = null;
        this.glUniforms = null;
        this.device = null;
        this.wgpuContext = null;
        this.wgpuFormat = null;
        this.wgpuPipeline = null;
        this.wgpuUniformBuffer = null;
        this.wgpuBindGroup = null;
        this.wgpuTexture = null;
        this.wgpuTextureWidth = 0;
        this.wgpuTextureHeight = 0;
        this.ready = false;
        this.kReady = false;
        this.backend = "cpu";
    }
    initWebGl2() {
        const gl = this.canvas.getContext("webgl2", {
            alpha: false,
            antialias: false,
            preserveDrawingBuffer: true,
        });
        if (!gl)
            return false;
        const program = createProgram(gl, GL_VERTEX_SHADER, GL_FRAGMENT_SHADER);
        if (!program)
            return false;
        const texture = gl.createTexture();
        if (!texture)
            return false;
        gl.useProgram(program);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.uniform1i(gl.getUniformLocation(program, "uKMap"), 0);
        this.gl = gl;
        this.glProgram = program;
        this.glTexture = texture;
        this.glUniforms = {
            size: gl.getUniformLocation(program, "uSize"),
            kMin: gl.getUniformLocation(program, "uKMin"),
            kMax: gl.getUniformLocation(program, "uKMax"),
            normalize: gl.getUniformLocation(program, "uNormalize"),
            contrast: gl.getUniformLocation(program, "uContrast"),
            threshold: gl.getUniformLocation(program, "uThreshold"),
            clipMin: gl.getUniformLocation(program, "uClipMin"),
            clipMax: gl.getUniformLocation(program, "uClipMax"),
            blur: gl.getUniformLocation(program, "uBlur"),
            sharpen: gl.getUniformLocation(program, "uSharpen"),
        };
        this.backend = "webgl";
        this.ready = true;
        this.kReady = false;
        return true;
    }
    async initWebGpu() {
        const navGpu = navigator.gpu;
        if (!navGpu)
            return false;
        try {
            const adapter = await navGpu.requestAdapter();
            if (!adapter)
                return false;
            const device = await adapter.requestDevice();
            const context = this.canvas.getContext("webgpu");
            if (!context)
                return false;
            const format = navGpu.getPreferredCanvasFormat();
            context.configure({
                device,
                format,
                alphaMode: "opaque",
            });
            const shaderModule = device.createShaderModule({ code: WGSL_SHADER });
            const pipeline = device.createRenderPipeline({
                layout: "auto",
                vertex: {
                    module: shaderModule,
                    entryPoint: "vs_main",
                },
                fragment: {
                    module: shaderModule,
                    entryPoint: "fs_main",
                    targets: [{ format }],
                },
                primitive: {
                    topology: "triangle-list",
                },
            });
            const gpuBufferUsage = globalThis.GPUBufferUsage;
            if (!gpuBufferUsage)
                return false;
            const uniformBuffer = device.createBuffer({
                size: 64,
                usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
            });
            this.device = device;
            this.wgpuContext = context;
            this.wgpuFormat = format;
            this.wgpuPipeline = pipeline;
            this.wgpuUniformBuffer = uniformBuffer;
            this.wgpuBindGroup = null;
            this.backend = "webgpu";
            this.ready = true;
            this.kReady = false;
            return true;
        }
        catch {
            return false;
        }
    }
    uploadKMapWebGl(floatBuffer, width, height) {
        const gl = this.gl;
        if (!gl || !this.glTexture || !this.glProgram)
            return false;
        try {
            gl.useProgram(this.glProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.glTexture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, floatBuffer);
            this.kReady = true;
            return true;
        }
        catch {
            this.kReady = false;
            return false;
        }
    }
    uploadKMapWebGpu(floatBuffer, width, height) {
        if (!this.device || !this.wgpuPipeline || !this.wgpuUniformBuffer)
            return false;
        const gpuTextureUsage = globalThis.GPUTextureUsage;
        if (!gpuTextureUsage)
            return false;
        if (!this.wgpuTexture || this.wgpuTextureWidth !== width || this.wgpuTextureHeight !== height) {
            this.wgpuTexture = this.device.createTexture({
                size: { width, height, depthOrArrayLayers: 1 },
                format: "r32float",
                usage: gpuTextureUsage.TEXTURE_BINDING | gpuTextureUsage.COPY_DST,
            });
            this.wgpuTextureWidth = width;
            this.wgpuTextureHeight = height;
            this.wgpuBindGroup = this.device.createBindGroup({
                layout: this.wgpuPipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: this.wgpuTexture.createView() },
                    { binding: 1, resource: { buffer: this.wgpuUniformBuffer } },
                ],
            });
        }
        this.device.queue.writeTexture({ texture: this.wgpuTexture }, floatBuffer, { bytesPerRow: width * 4 }, { width, height, depthOrArrayLayers: 1 });
        this.kReady = true;
        return true;
    }
    renderWebGl(params) {
        const gl = this.gl;
        if (!gl || !this.glProgram || !this.glUniforms || !this.glTexture || !this.kReady)
            return;
        const clipMin = Math.min(params.clipMin, params.clipMax);
        const clipMax = Math.max(params.clipMin, params.clipMax);
        const blur = clampNumber(params.blur, 0, MAX_BLUR_RADIUS, 0);
        const sharpen = clampNumber(params.sharpen, 0, 10, 0);
        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this.glProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.glTexture);
        gl.uniform2f(this.glUniforms.size, this.width, this.height);
        gl.uniform1f(this.glUniforms.kMin, this.kRange.min);
        gl.uniform1f(this.glUniforms.kMax, this.kRange.max);
        gl.uniform1f(this.glUniforms.normalize, params.normalize ? 1 : 0);
        gl.uniform1f(this.glUniforms.contrast, clampNumber(params.contrast, 0, 10, 1));
        gl.uniform1f(this.glUniforms.threshold, clampNumber(params.threshold, 0, 1, 0));
        gl.uniform1f(this.glUniforms.clipMin, clipMin);
        gl.uniform1f(this.glUniforms.clipMax, clipMax);
        gl.uniform1f(this.glUniforms.blur, blur);
        gl.uniform1f(this.glUniforms.sharpen, sharpen);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    renderWebGpu(params) {
        if (!this.device || !this.wgpuContext || !this.wgpuPipeline || !this.wgpuBindGroup || !this.wgpuUniformBuffer) {
            return;
        }
        if (!this.kReady)
            return;
        const clipMin = Math.min(params.clipMin, params.clipMax);
        const clipMax = Math.max(params.clipMin, params.clipMax);
        const blur = clampNumber(params.blur, 0, MAX_BLUR_RADIUS, 0);
        const sharpen = clampNumber(params.sharpen, 0, 10, 0);
        this.wgpuUniformData.fill(0);
        this.wgpuUniformData[0] = this.kRange.min;
        this.wgpuUniformData[1] = this.kRange.max;
        this.wgpuUniformData[2] = params.normalize ? 1 : 0;
        this.wgpuUniformData[3] = clampNumber(params.contrast, 0, 10, 1);
        this.wgpuUniformData[4] = clampNumber(params.threshold, 0, 1, 0);
        this.wgpuUniformData[5] = clipMin;
        this.wgpuUniformData[6] = clipMax;
        this.wgpuUniformData[7] = blur;
        this.wgpuUniformData[8] = sharpen;
        this.wgpuUniformData[9] = this.width;
        this.wgpuUniformData[10] = this.height;
        this.device.queue.writeBuffer(this.wgpuUniformBuffer, 0, this.wgpuUniformData.buffer);
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.wgpuContext.getCurrentTexture().createView(),
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: "clear",
                    storeOp: "store",
                },
            ],
        });
        pass.setPipeline(this.wgpuPipeline);
        pass.setBindGroup(0, this.wgpuBindGroup);
        pass.draw(3);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
}
function pickTryList(preference) {
    if (preference === "webgpu")
        return ["webgpu"];
    if (preference === "webgl")
        return ["webgl"];
    if (preference === "cpu")
        return ["cpu"];
    return ["webgpu", "webgl"];
}
function createProgram(gl, vertexSource, fragmentSource) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    if (!vs || !fs)
        return null;
    const program = gl.createProgram();
    if (!program)
        return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        gl.deleteProgram(program);
        return null;
    }
    return program;
}
function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader)
        return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}
function clampNumber(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    if (n < lo)
        return lo;
    if (n > hi)
        return hi;
    return n;
}
