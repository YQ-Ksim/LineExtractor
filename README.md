# LineExtractor Frontend

纯前端线稿提取与区域二值化工具，所有计算均在浏览器本地完成，无后端依赖。

## 功能

- 频域高通线稿提取（RGB 多通道 + K 算法）
- 分层缓存（Layer1/Layer2/Layer3）
- WebGPU / WebGL2 / CPU 渲染切换（线稿模式）
- 线稿引导区域分割 + 区域排序二值化（纯前端 Worker）
- PNG 导出

## 新增区域算法

流程：

1. 线稿二值化 + 膨胀，作为区域扩散屏障
2. 非线稿区域距离变换
3. 网格局部极值种子 + 连通域补种子
4. 屏障约束区域生长，得到 Label Map
5. 计算区域平均灰度
6. 构建区域邻接图（RAG）
7. `score_i = Σ_{j∈N_i}(G_j - G_i)` 评分
8. 按 score 排序，取 Top p% 区域置黑，其余置白

## 本地运行

1. 启动静态服务器（任选其一）
   - `python -m http.server 8000`
   - `npx serve .`
2. 打开 `http://localhost:8000/index.html`
3. 导入图片或加载 `test.jpg`

## GitHub Pages 自动部署

仓库已包含工作流：`/.github/workflows/deploy-pages.yml`
