# 音乐库预渲染：最终 production 浏览器验证

2026-11-01。实际 React 19.2.8 / Chromium 156.0.8078.74。`NODE_ENV=production`、Vite `isProduction`、浏览器 `import.meta.env.PROD` 均确认生产模式；React 开发 `act` 导出不存在。

## 成对测量

同一脚本、同一环境；启动停留游戏页约 1 秒后首次进入音乐库。修复前读取冻结源码，修复后读取最终源码。每场景测量一次；曲目 IPC 与图片内容使用固定样本，HTTP 请求、解码、React 布局和 Paint 均实际执行。曲目总数 500。

| 首次进入 | 修复前动画开始 | 修复后动画开始 | 缩短 | 修复后采样帧数 |
| --- | ---: | ---: | ---: | ---: |
| 单列 | 138.8 ms | 13.2 ms | 90.5% | 2 |
| 多列 | 431.8 ms | 18.3 ms | 95.8% | 2 |

首次导航新增封面请求从单列 36 / 多列 93 降为 0；新增曲目 IPC 从 1 降为 0。准备就绪后导航没有再次套用封面准备门禁；首屏空封面帧为 0。动画开始的毫秒数与帧数均直接记录，未设强制低于某毫秒的通过条件。

## 覆盖

| 场景 | 结果 |
| --- | --- |
| single | 单列首次、滚动、暖再入、统计页切换通过 |
| multi | 多列首次、真实隐藏 Paint、虚拟化、右键菜单退出清理通过 |
| decode | 额外 70 ms 解码延迟；后台完成后切入不再等待资源 |
| cancel | 请求音乐但尚显示旧页时，可视封面已全部提升为 high；取消导航后迟到完成不会重新打开音乐库 |
| resize | 隐藏期间从 1280 扩至 1920；首次进入完整封面 |
| empty | 空库正常放行，无封面请求、无错误 |
| refresh | 第一条入场动画 `elapsedTime=0` 时更新 tracks；后续帧不再准备隐藏，已显现列表不整体消失 |

所有场景浏览器错误列表为空。额外真实指针回归：初始 tracks 为空、异步载入后，`scrollend` 恢复高亮 `opacity=1`；指针移动排队高亮帧后切页，返回后再次移动，高亮位置由 `0px` 移至 `108px`。这些检查仅通过 DOM、真实指针与公开 store 操作，未读取组件内部 ref。

## 证据

- `music-prerender-production-before.json`：冻结基线、源码哈希、逐帧数据。
- `music-prerender-production-after.json`：最终 7 场景、逐帧数据、隐藏 Paint、指针与更新回归。
- `music-prerender-production-summary.json`：完整 `finalSourceHashes`、`baselineSourceHashes` 和 7 场景摘要；最终运行 `sourceUnchangedDuringAfter=true`。
- `../../scripts/music-prerender.test.mjs`：测试脚本。

测量使用 Vite 生产模式服务器与生产 React，尚非打包发布文件或安装版 WebView2。包含测试采样与浏览器调度开销；所有首屏行开始可见的时间还包含原有错峰入场动画延迟。安装与发布验证由主任务记录。
