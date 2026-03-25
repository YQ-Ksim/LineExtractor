# LineExtractor Frontend

纯前端线稿提取与线稿约束分割工具。所有计算均在浏览器本地完成，无后端依赖。

## 功能

- 频域线稿提取（RGB + 高通 + K + 后处理）
- 线稿引导区域排序二值化
- Felzenszwalb 图分割（`O(E log E)`）
- WebGPU / WebGL2 / CPU 渲染切换
- PNG 导出

## 当前区域分割流程（Felzenszwalb）

1. 使用 Layer3 线稿（黑底白线）并二值化得到线稿掩膜
2. 线稿降噪 + 膨胀，得到约束边界
3. 建立像素图（4 邻接）
4. 边权：
   - `w(u,v) = ||Iu - Iv|| + lambda * crossLine(u,v)`
   - 当边跨线稿时，加入较大惩罚 `lambda`
5. Felzenszwalb 合并：
   - 按边权从小到大遍历
   - 阈值函数：`T(C) = k / |C|`
6. 最小区域合并（`minSize`）
7. 区域邻接评分并按 Top p% 输出黑白二值图

## 关键参数

- `felzK`：分割粗细控制（小更细，大更粗）
- `felzMinSize`：最小区域大小
- `linePenalty`：跨线稿惩罚系数（越大越不易跨线）

## 本地运行

1. 启动静态服务器：
   - `python -m http.server 8000`
   - `npx serve .`
2. 打开 `http://localhost:8000/index.html`

## GitHub Pages

仓库已包含部署工作流：`.github/workflows/deploy-pages.yml`
