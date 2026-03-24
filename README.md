# LineExtractor Frontend

纯前端线稿提取工具，所有计算都在浏览器本地完成，无后端依赖。

## 核心流程

`RGB Split -> FFT -> High-pass -> IFFT -> K -> Normalize/Contrast/Threshold/Clip/Blur/Sharpen -> Output`

## 参数说明

- `K` 算法参数已固定为默认公式，不再提供可调项：
  - `K = (R² + G² + B²) / [256 (R + G + B)]`
- 可调参数仅保留：
  - FFT / Filter
  - Post Processing

## 默认参数

- FFT / Filter
  - `R 半径`: `160`
  - `高通类型`: `Butterworth`
  - `Butterworth 阶数`: `2`
  - `高通强度`: `0.80`
- Post Processing
  - `Normalize`: 勾选
  - `Contrast`: `0.80`
  - `Threshold`: `0.15`
  - `Clip Min`: `0.01`
  - `Clip Max`: `1.00`
  - `Blur`: `0`
  - `Sharpen`: `0.35`

## 本地运行

1. 启动静态服务器（任选其一）
   - `python -m http.server 8000`
   - `npx serve .`
2. 打开 `http://localhost:8000/index.html`
3. 导入图片或加载 `test.jpg`

## GitHub Pages 自动部署

仓库包含工作流：`/.github/workflows/deploy-pages.yml`

首次启用步骤：

1. 推送代码到 `main` 分支。
2. 打开仓库 `Settings -> Pages`。
3. `Source` 选择 `GitHub Actions`。
4. 再次 `push` 或手动运行 `Actions -> Deploy To GitHub Pages`。

## 文件结构

- `index.html`: 页面结构
- `styles.css`: UI 样式
- `app.js`: 参数面板、调度、导出、后端切换
- `worker.js`: FFT + 高频 + K + CPU 后处理 + 缓存策略
- `gpu_renderer.js`: WebGPU/WebGL2 后处理渲染器
- `.github/workflows/deploy-pages.yml`: GitHub Pages 自动部署
