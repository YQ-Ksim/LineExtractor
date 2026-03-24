# LineExtractor Frontend

纯前端线稿提取与区域排序二值化工具，所有计算都在浏览器本地完成。

## 功能

- 频域线稿提取（RGB + 高通 + K）
- 线稿引导区域分割 + 区域评分排序二值化
- 分层缓存与实时调参
- WebGPU / WebGL2 / CPU 渲染切换
- PNG 导出

## 区域算法要点

1. 使用 Layer3 线稿作为引导（黑底白线）
2. 分割前先对白线做二值化（阈值可调）
3. 二值线稿可做降噪（开运算半径、最小连通面积可调）
4. 白线膨胀后作为区域扩散屏障
5. 区域生长得到 Label Map，构建 RAG
6. 按 `score_i = Σ(G_j - G_i)` 排序，Top p% 区域置黑

## 本地运行

1. 启动静态服务器：
   - `python -m http.server 8000`
   - `npx serve .`
2. 打开 `http://localhost:8000/index.html`

## GitHub Pages

仓库已包含自动部署工作流：`/.github/workflows/deploy-pages.yml`
