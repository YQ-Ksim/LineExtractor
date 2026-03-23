# LineExtractor Frontend (Pure Frontend)

纯前端线稿提取工具，所有计算都在浏览器本地完成，无后端依赖。

## 核心流程

`RGB Split -> FFT -> High-pass -> IFFT -> K -> Normalize/Contrast/Threshold/Clip/Blur/Sharpen -> Output`

## 性能分层

- Layer1（慢）：`FFT + High-pass + IFFT -> r/g/b edge`
- Layer2（中）：`K algorithm`
- Layer3（快）：`Normalize + Contrast + Threshold + Clip + Blur + Sharpen`

缓存策略：

- 图像加载后缓存 RGB 频域结果（只做一次 FFT）
- Layer1 参数变化才重算 Edge
- Layer2 参数变化才重算 K
- 仅 Layer3 参数变化时：
  - CPU 模式：只重算 Layer3
  - GPU 模式：直接本地 GPU 重渲染

## 功能

- 导出 PNG
- 前后对比滑动条
- 渲染后端切换：
  - `Auto (WebGPU > WebGL2 > CPU)`
  - `WebGPU`
  - `WebGL2`
  - `CPU`

## 本地运行

1. 启动静态服务器（任选其一）：
   - `python -m http.server 8000`
   - `npx serve .`
2. 打开 `http://localhost:8000/index.html`
3. 导入图片或加载 `test.jpg`

## GitHub Pages 自动部署

仓库已包含工作流：`/.github/workflows/deploy-pages.yml`

### 第一次启用步骤

1. 把代码推送到 GitHub 仓库 `main` 分支。
2. 打开仓库 `Settings -> Pages`。
3. `Build and deployment` 的 `Source` 选择 `GitHub Actions`。
4. 再次 push（或手动运行 `Actions -> Deploy To GitHub Pages`）。
5. 部署成功后，访问：
   - `https://<你的用户名>.github.io/<仓库名>/`

### 部署触发规则

- push 到 `main` 自动触发部署
- 支持手动触发 `workflow_dispatch`

## 文件结构

- `index.html`：页面结构
- `styles.css`：UI 样式与对比滑条布局
- `app.js`：参数面板、调度、导出、对比交互、后端切换
- `worker.js`：FFT + 高通 + K + CPU 后处理 + 缓存失效策略
- `gpu_renderer.js`：WebGPU/WebGL2 后处理渲染器
- `.github/workflows/deploy-pages.yml`：GitHub Pages 自动部署工作流
