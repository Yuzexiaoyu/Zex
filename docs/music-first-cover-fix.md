音乐库首次进入封面占位修复
==========================

日期：2026-11-01。

[已验证 E1、E2] 冷缓存首次进入音乐库时，旧实现先播放行入场，再等待封面 fetch/blob；LIFO 队列还让后挂载的滚动缓冲区图片抢先。浏览器复现中，单列与多列分别出现 42、112 帧可见空封面。修复后正常冷入、延迟解码和单张 1200ms 慢图场景的可见空封面帧均为 0。

[已验证 E3] 修复包含以下变化：

- 首屏只等待实际可见行的图片取得来源并完成 decode，再启动原有列间入场。原时长、错峰、位移参数保留。
- 可视图片使用 high 优先级，overscan 使用 low。缓存按活跃引用的最高优先级出队，同级仍采用 LIFO；动态改变优先级不重新取图、不清除已就绪图片。
- 首次准备期间保留布局、隐藏行并暂停入场；滚动立即结束准备，之后不重播。
- 缺失封面显示图标；图片长期无响应时约 2500ms 后放行，后续成功仍自然显示。
- 复用游戏库的可视图片准备逻辑，并处理零尺寸布局和异步错误状态；统计页的缩略、缓存与版本方案继续保留。

[已验证 E1、E2] 浏览器结果：

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 单列正常冷入 | 42 帧有空封面，最多同时 7 个 | 0 帧 |
| 多列正常冷入 | 112 帧有空封面，最多同时 42 个 | 0 帧 |
| 首屏最后一张开始前插队的缓冲图片，单列/多列 | 24 / 48 张 | 0 / 0 张 |
| 暖缓存再次进入 | 0 空帧 / 0 新请求 | 保持 0 / 0 |
| 延迟 decode / 单张 1200ms 慢图 | 本轮基线未单测 | 0 可见空封面帧 |
| 缺失图片 | 本轮基线未单测 | 正常行显示，缺失项为图标 |
| 永久未响应图片 | 本轮基线未单测 | 约 2595ms 放行，无永久等待 |
| 卸载取消 / 提前滚动 | 本轮基线未单测 | 未释放引用 0、排队 0；提前滚动后入场启动 0 |

[已验证 E2、E4] 音乐专项 8 个场景、28 项单测通过；游戏库启动与文件夹封面回归通过；统计页 5 个场景通过，中段回访仍为 0 次新增请求。专项与统计回归都确认运行期间源码没有变化。

证据：

| ID | 文件与定位 |
| --- | --- |
| E1 | [修复前复现](D:/ZEX/docs/verification/music-first-cover-before.json)，`single/multi.coldSummary`、`overscanBeforeLastVisible`；基线三个模块存于 `docs/verification/music-first-cover-baseline-source` |
| E2 | [修复后结果](D:/ZEX/docs/verification/music-first-cover-after.json)、[专项脚本](D:/ZEX/scripts/music-first-cover.test.mjs)，8 场景及源码 SHA-256 |
| E3 | [MusicView.tsx](D:/ZEX/src/views/MusicView.tsx) 的 `introImagesReady`、`preparingCovers`；[gridImages.ts](D:/ZEX/src/utils/gridImages.ts) 的 `prepareVisibleImages`；[cover-cache.ts](D:/ZEX/src/utils/cover-cache.ts) 的 `request/setPriority/pump`；[CoverImg.tsx](D:/ZEX/src/components/CoverImg.tsx) |
| E4 | [28 项单测](D:/ZEX/docs/verification/music-first-cover-unit.log)、[游戏库回归](D:/ZEX/docs/verification/music-first-cover-game-compat.log)、[统计兼容结果](D:/ZEX/docs/verification/stats-image-fix-music-compat-results.json) |
| E5 | [Release 构建](D:/ZEX/release/music-first-cover-build.log)、[签名与打包](D:/ZEX/release/music-first-cover-package.log)、[ZIP 校验](D:/ZEX/docs/verification/music-first-cover-package.json) |
| E6 | [部署记录](D:/ZEX/docs/verification/music-first-cover-deployment.json)、[替换前清单](D:/ZEX/release/music-first-cover-install-before.json)、[替换后清单](D:/ZEX/release/music-first-cover-install-after.json) |

[已验证 E5、E6] 已更新 [ZEX-0.1.0.zip](D:/ZEX/release/ZEX-0.1.0.zip)，64,990,638 字节、1430 个条目，CRC 通过。仅替换 `F:\ZEX-0.1.0\ZEX.exe` 并恢复启动，签名为 `Valid`。本次未创建旧 EXE 或旧 ZIP 备份。替换前后、重启之前，3481 个其他文件（含 2084 个 data 文件）及目录清单一致。

[已验证 E5、E6] ZIP 内、构建目录与 F 盘 EXE 的 SHA-256 一致：
`571541DADF75C357B4973BA09E17C9FEF40153C36AAAB72190DDC342A34FF516`。
ZIP SHA-256：
`4C1EE260179083ACDFB6DA7F8077F00CAE1C7EB6B20A17CAE92F285BBFB03DD1`。

覆盖：单列、多列、冷/暖缓存、解码延迟、慢图、缺失、超时、卸载、滚动取消、优先级和共享组件均已验证。安装版完成启动检查；原生 WebView2 首次音乐页的逐帧采集未执行。

[边界 E1、E2] 帧数属于 Chrome 156、真实 React 组件与模拟 IPC/HTTP 图片的测试结果；正常冷图设置了 35ms HTTP 延时，保留浏览器缓存、没有请求拦截。永久缺失图与超过超时的图仍显示占位，零空帧结论适用于成功加载的正常、延迟解码和单慢图测试。

重放命令（构建与浏览器测试分开运行）：

```powershell
Set-Location -LiteralPath 'D:\ZEX'
node --test scripts/stats-preload.test.mjs scripts/cover-cache.test.mjs
$env:PLAYWRIGHT_MODULE = 'file:///C:/Users/20457/AppData/Local/OpenAI/Codex/runtimes/cua_node/2b841c3d44b123ec/bin/node_modules/playwright/index.mjs'
$env:PLAYWRIGHT_CHANNEL = 'chrome'
node scripts/music-first-cover.test.mjs
node scripts/startup-animation.test.mjs
$env:ZEX_STATS_FIX_OUTPUT = 'stats-image-fix-music-compat'
node scripts/stats-image-regression.mjs
npx tauri build --no-bundle
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/打包.ps1
```
