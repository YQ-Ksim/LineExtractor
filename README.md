# LineExtractor

LineExtractor is a pure frontend web app for line extraction and line-guided region binarization.
All computation runs in the browser. No backend service is required.

## Features

- Frequency-domain line extraction: RGB FFT + high-pass filter + K map + post-processing
- Line-guided region binarization: Felzenszwalb-based segmentation with optional Watershed/CRF
- Real-time parameter tuning with layered caching strategy
- Optional rendering acceleration: WebGPU / WebGL2 / CPU
- PNG export
- Bilingual UI: Chinese and English, switchable with one button

## Quick Start

```bash
npm install
npm run build
```

Then run a static server, for example:

```bash
python -m http.server 8000
```

Open `http://localhost:8000/index.html`.

## Build Structure

- Source code: `src/`
- TypeScript compile output: `build/`
- Static deployment entry files: project root (`index.html`, `app.js`, `worker.js`, `gpu_renderer.js`)

## Deployment

GitHub Pages workflow file:

- `.github/workflows/deploy-pages.yml`

The workflow installs dependencies, builds TypeScript, packages static files, then deploys to Pages.

---

# LineExtractor（中文说明）

LineExtractor 是一个纯前端网页工具，用于线稿提取与线稿引导的区域二值化。
所有计算均在浏览器本地完成，不依赖后端。

## 核心功能

- 频域线稿提取：RGB FFT + 高通滤波 + K 图 + 后处理
- 线稿引导区域二值化：基于 Felzenszwalb 分割，可选 Watershed/CRF
- 参数实时调节，分层缓存优化性能
- 可选渲染后端：WebGPU / WebGL2 / CPU
- 导出 PNG
- 中英双语界面，一键切换

## 本地运行

```bash
npm install
npm run build
python -m http.server 8000
```

访问 `http://localhost:8000/index.html`。
