游戏库与影视库切页优化
======================

日期：2026-11-01。

[已验证 E1] 游戏库保持按需挂载。实测正常切回首张完整卡片约 36–46ms，未发现值得增加常驻页面的收益。影视库采用有上限的首屏图片预热，不常驻页面或详情 DOM。

[已验证 E1] 最终生产 React 浏览器测试：

| 场景 | 首次完整影视首屏：前→后 | 空图帧：前→后 | 首屏关键图片新请求：前→后 |
| --- | --- | --- | --- |
| 1280×900、6 部 | 107.7→72.2ms | 5→0 | 7→0 |
| 1920×900、120 部 | 208.0→37.9ms | 27→0 | 21→0 |
| 后台缩放后进入 | 207.1→38.2ms | 27→0 | 21→0 |
| 数据到达立即进入 | 1021.6→354.2ms | 158→51 | 17→17 |

[已验证 E1] 所有场景首次进入均无重复影视查询；两库离开后都卸载。正常、宽屏和后台缩放场景返回游戏库没有新增游戏图片请求。立即进入场景没有预热时间，仍可能短暂显示占位；其耗时也受模拟 HTTP/1 队列影响。

[已验证 E2、E3] 实现：

- 用独立返回 null 的 `SeriesImageWarmup` 组件承载数据订阅，不因影视数据更新重渲染整棵 App。
- 共享原有默认 Hero 选择规则；只预热默认背景和首屏估算海报，最多 32 个来源。
- 后台空闲时 low 优先级、2 路预热；请求进入影视库时改为 high、4 路。缩放、数据版本改变或卸载时停止尚未开始的旧任务。
- 复用原生 Image 和浏览器缓存，保留上限为 32 张、按原始像素估算的 64 MiB；失败或超时不永久占用队列。
- 首屏海报 eager/high，其他海报保持 lazy/low。详情图片只在实际聚焦/悬停后准备。
- `ensureSeriesLoaded` 复用启动数据；显式 `loadSeries` 在查询期间收到刷新要求时合并后续查询，避免删除、元数据或播放状态更新被旧请求吞掉。

[已验证 E3] TypeScript 检查、39 项单测、4 个影视/游戏配对场景、游戏库启动回归和统计页 5 个兼容场景通过。统计页中段回访仍无重复请求。

证据：

| ID | 文件 |
| --- | --- |
| E1 | [紧凑对比摘要](D:/ZEX/docs/verification/library-entry-summary.json)、[基线](D:/ZEX/docs/verification/library-entry-before.json)、[最终结果](D:/ZEX/docs/verification/library-entry-after.json)、[基准脚本](D:/ZEX/scripts/library-entry-benchmark.mjs) |
| E2 | [预热组件](D:/ZEX/src/components/SeriesImageWarmup.tsx)、[预热 hook](D:/ZEX/src/utils/useSeriesImageWarmup.ts)、[首屏选择](D:/ZEX/src/utils/seriesImages.ts)、[Image 缓存](D:/ZEX/src/utils/preloadImages.ts)、[store](D:/ZEX/src/store/index.ts) |
| E3 | [单测](D:/ZEX/release/library-optimization-unit.log)、[图片预热测试](D:/ZEX/scripts/image-warmup.test.mjs)、[查询合并测试](D:/ZEX/scripts/series-store.test.mjs)、[游戏兼容](D:/ZEX/release/library-entry-game-compat.log)、[统计兼容](D:/ZEX/release/library-entry-stats-compat.log) |
| E5 | [Release 构建](D:/ZEX/release/library-entry-build.log)、[签名打包](D:/ZEX/release/library-entry-package.log)、[ZIP 校验](D:/ZEX/docs/verification/library-entry-package.json) |
| E6 | [部署验证](D:/ZEX/docs/verification/library-entry-deployment.json)、[最终汇总](D:/ZEX/docs/verification/library-entry-final-summary.json) |

[已验证 E1] 只保存紧凑摘要和必要计数，不再落完整逐帧数组。历史基线保留；最终 harness 为新组件和 ensure 接口作了适配，摘要明确记录前后测试脚本的差异。

[边界 E1] 测试使用生产 React 19.2.8、Chrome 156、实际 SeriesView/GameView/store/CSS，以及模拟 IPC/PNG。没有挂载完整 App 的音乐、统计和设置层，不是安装版 WebView2 的逐帧计时。32 张与 64 MiB 是本机预热缓存的保留上限，不保证所有高分辨率原图同时驻留。完整动画时长不等同于图片等待时间。

覆盖：默认 Hero、首屏预热、窗口缩放、立即进入、数据查询复用/刷新、失败重试、并发/取消/缓存预算、退出卸载、游戏与统计兼容已检查；原生逐帧性能未采集。

[已验证 E4] Git 百万行问题的原因和处理见 [变更量审计](D:/ZEX/docs/git-change-size-audit.md)。此前新增 1,308,317 行中，99.70% 是验证产物；原始 JSON、PNG、冻结源码仍留本机，仅排除出 Git 新增文件。源码、测试、Markdown 报告与小型 fixture 继续可见。

[已验证 E5、E6] Release 构建与打包成功，新 [ZEX-0.1.0.zip](D:/ZEX/release/ZEX-0.1.0.zip) 为 64,995,233 字节、1430 个条目，CRC 通过。仅替换 F 盘 EXE 并恢复启动，签名 Valid。未备份旧 EXE；替换前后、重启之前的 3481 个其他文件（含 2084 个 data 文件）与目录清单一致。

[已验证 E5、E6] ZIP 内、Release 与 `F:\ZEX-0.1.0\ZEX.exe` 的 SHA-256 一致：
`4BD74ED7FE0A4A89B29F290870612F7932B51E0772A546C7C2F76B511102B0DE`。
ZIP SHA-256：`284D5D7A3BD607CEB333A292BDF308B8D68F0319039E12B0590592C30420257D`。
