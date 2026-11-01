统计页滚动图片重载审查
======================

审查日期：2026-11-01。源码基线：`2ff13af29d4a2ff2746474aa604ad6056000bd9b`。

[已验证 E1–E3] 滚动回访已加载的行时，虚拟列表重新创建 `<img>`，统计封面继续通过无版本 URL 加载；浏览器镜像复现捕获到重复取图和自动解码。最终中段回访记录为 **30 次重复请求，全部 HTTP 200，响应体合计 10,513,755 字节，19 个 `Decode Image` 事件**。

[已验证 E0、E3] 测试使用当前 React 组件、模拟统计 IPC 和镜像 covers 响应头的 HTTP 服务；Chrome `156.0.8078.74`，Node `v24.14.0`，窗口 `1600×950`。HTTP 缓存保持开启，未使用请求拦截。实际数据形态来自只读数据库快照，图片像素为合成数据。以上数字属于浏览器复现，原生应用中的对应计数尚未测量。

[已验证 E0] 本次产物为审查脚本、证据与报告；生产源码未修改。修复、构建和部署未执行。

[已验证 E1] 三列使用相同的行组件和虚拟化机制，但是否卸载取决于列长度与窗口。本次实际数据形态中游戏、音乐列发生重挂载；影视只有 6 行，在测试窗口内常驻。不能把游戏、音乐的回访结果直接推广为影视列也已复现相同卸载行为。

证据索引：

| ID | 可核对的位置 | 支持的结论 |
| --- | --- | --- |
| E0 | [汇总结果](D:/ZEX/docs/verification/stats-image-review-summary.json)、两套结果的 `environment` / `scope` / `sourceHashes` | 环境、测试边界、完成状态及源码一致性 |
| E1 | [StatsView.tsx:73](D:/ZEX/src/views/StatsView.tsx:73)、[StatsView.tsx:125](D:/ZEX/src/views/StatsView.tsx:125)、[StatsCovers.tsx:83](D:/ZEX/src/components/StatsCovers.tsx:83) | 虚拟行卸载和原生图片节点重建 |
| E2 | [statsImages.ts:4](D:/ZEX/src/utils/statsImages.ts:4)、[media.ts:7](D:/ZEX/src/utils/media.ts:7)、[music.rs:801](D:/ZEX/src-tauri/src/music.rs:801) | 无版本 URL、协商缓存和文件读取分支 |
| E3 | [实际形态复现结果](D:/ZEX/docs/verification/stats-scroll-shape-audit-results.json) 的 `scenarios[0].middleRevisit`、[请求明细](D:/ZEX/docs/verification/stats-scroll-shape-audit-requests.json) | 相同 URL、不同节点、重复响应及自动解码事件 |
| E4 | [数据盘点](D:/ZEX/docs/verification/stats-cover-data-audit.json) 的 `stats_top` / `stats_source` / `stats_top_scope`、[盘点脚本](D:/ZEX/scripts/stats-cover-data-audit.py)、[index.css:2689](D:/ZEX/src/index.css:2689) | 当前统计封面数量、尺寸、压缩字节与呈现尺寸 |
| E5 | [statsPreload.ts:15](D:/ZEX/src/utils/statsPreload.ts:15)、[StatsView.tsx:294](D:/ZEX/src/views/StatsView.tsx:294) | 预热范围、节点引用、触发条件 |
| E6 | [statsPreload.ts:18](D:/ZEX/src/utils/statsPreload.ts:18)、[StatsCovers.tsx:63](D:/ZEX/src/components/StatsCovers.tsx:63)、[主复现结果](D:/ZEX/docs/verification/stats-scroll-audit-results.json) 的 `slow` / `missing` 场景 | 慢图隐藏不恢复、错误状态随卸载丢失 |
| E7 | [CoverImg.tsx:25](D:/ZEX/src/components/CoverImg.tsx:25)、[tauri.conf.json:29](D:/ZEX/src-tauri/tauri.conf.json:29)、主复现结果的 `cacheComponentScenarios` | 现有缓存能力和 CSP 接入约束 |
| E8 | [stats-lifecycle.test.mjs:260](D:/ZEX/scripts/stats-lifecycle.test.mjs:260)、[stats-lifecycle.test.mjs:301](D:/ZEX/scripts/stats-lifecycle.test.mjs:301)、[预热测试日志](D:/ZEX/docs/verification/stats-preload-audit.log)、[滚动审查脚本](D:/ZEX/scripts/stats-scroll-audit.mjs) | 既有测试的覆盖盲点、7 项单测及新增场景 |

[已验证 E1、E2] 重载链条可逐项核对：

1. `useVirtualizer` 使用 `overscan: 3`，只渲染 `getVirtualItems()` 返回的行。移出缓冲区的 `RowCard` 与 `<img>` 从 DOM 删除。
2. 回滚后创建新的图片节点。`getItemKey` 已使用稳定条目 ID；`memo` 按值比较 props，只能跳过仍挂载组件的重渲染，不能保留已卸载节点。
3. `statsCoverSrc(entry)` 调用 `coverSrc(entry.wide_path || entry.cover_path)`，未传入版本。`RowCard` 使用原生 `<img loading="lazy" decoding="async">`，未接入模块级图片缓存。
4. 无版本 covers URL 返回 `Cache-Control: public, no-cache`。这是要求复用前验证，允许存储响应；它不等于 `no-store`。
5. `If-None-Match` 匹配时返回 304，在 `fs::read` 之前结束；否则同步 `fs::read` 并返回完整响应。304 分支仍执行路径检查与元数据读取，不能称为零文件系统访问。
6. 字节缓存和已解码位图属于不同层。即使重新请求得到 304、或者压缩字节命中缓存，新节点仍可能需要浏览器解码。

[已验证 E3] 实际形态场景先按 `940px` 步长遍历完整列表并等待图片加载，再进行往返，最后回到已访问的 `4700px` 中段。回访前后逻辑 URL 完全相同，节点标识发生如下变化：

| 列 | 首次访问节点 ID | 回访节点 ID | 本次观察 |
| --- | ---: | ---: | --- |
| 游戏 | 104 | 379 | 图片节点重建 |
| 影视 | 13 | 13 | 6 行常驻，节点保留 |
| 音乐 | 114 | 394 | 图片节点重建 |

[已验证 E3] 中段测量的 30 次响应全部对应此前已请求过的 URL，未携带 `If-None-Match`，因此响应镜像返回完整 200。游戏、音乐各 15 次，合计 10,513,755 字节。整个滚动阶段新增统计查询为 0，新增显式 `HTMLImageElement.decode()` 调用为 0，未重播入场动画，页面错误为空。

[已验证 E3] trace 中 `ImageDecodeTask`、`Decode LazyPixelRef`、`Decode Image` 各有 19 个事件，属于同一解码链条的不同记录口径，不能相加为 57 次。报告采用 `Decode Image` 的 19 个事件，也不把它等同于 19 张不同图片或原生 WebView2 的 GPU 解码次数。

[推断 E2–E4] 大图遍历后的缓存压力使回访更难保持稳定命中，是重载成本的放大因素。具体缓存淘汰时点和原生 WebView2 的容量未测量。重复请求、节点重建和解码事件已经观察到；这些次数随数据和缓存状态变化，不是每次滚动固定发生 30 次请求、19 次解码。

[已验证 E4] 数据盘点使用 `F:\ZEX-0.1.0\data\zex.db`，通过 `mode=ro`、`PRAGMA query_only = ON` 和只读事务读取。排名 SQL 从当前 `get_stats` 提取，并镜像归档去重与 Steam 封面选择。应读取结果中的 `stats_top`；顶层 `media` 只是图库盘点，口径不同。

| 统计列 | 排名封面数 | 文件尺寸 | 压缩文件总字节 | 按原始尺寸计算的 RGBA 总字节 |
| --- | ---: | --- | ---: | ---: |
| 游戏 | 112 | 全部 `1920×620` | 114,157,539 | 533,299,200（约 508.59 MiB） |
| 影视 | 6 | 全部 `1280×720` | 1,224,033 | 22,118,400 |
| 音乐 | 132 | 最大边不超过 256px | 3,152,803 | 34,316,544 |

[已验证 E4] 所选封面均可读取，未发现缺失文件。112 张游戏图中有 10 张渐进式图像。CSS 中宽幅封面高度为 `72px`，原图像素量明显高于呈现所需；单张游戏原图的 `1920 × 620 × 4` 为 4,761,600 字节。

[未验证 E4] RGBA 数字是理论原始尺寸计算值，不是进程、浏览器解码缓存或 GPU 显存实测。渐进式编码对实际闪烁的独立贡献未验证。合成像素场景保持条目数量与常见尺寸，但未复用实际图片内容、编码格式分布或压缩体积。

[已验证 E5、E8] 首屏检查容易漏掉中段问题。`preloadStatsImages` 仅准备视口及下方约一行，闭包保留 `visibleImages` 数组；监听的是 `ResizeObserver`，未注册滚动监听。`StatsView` 的预热 effect 依赖数据和可见库变化，滚动不触发该预热。既有生命周期测试核对切页时保留 DOM、无新增请求与显式解码；远距离滚动部分核对虚拟化及不重播动画，未断言中段回访复用图片。

[推断 E5] 首屏保留的图片引用可能帮助维持资源，导致反复回到顶部时更容易命中；这不保证浏览器永久保留已解码位图。中段行没有同等的预热和引用保留路径，应作为独立回访场景验证。

[已验证 E6] 关联缺陷也有独立复现证据：

- **慢图成功后仍隐藏。** 400ms 超时后 `finish` 提交未完成来源并设置 `ready = true`；之后成功解码只更新 WeakMap，`finish` 不再通知。`RowCard` 继续根据已提交集合设置 `visibility: hidden`。800ms 延迟场景出现 30 张已加载成功但仍隐藏的图片，需重新准备展示结果才能恢复。
- **缺失图重复重试。** `failedSrc` 是 `RowCard` 局部状态，卸载后丢失。诊断场景中三个缺失封面在初次加载及三轮往返中累计产生 12 次 404。当前数据库快照未发现所选文件缺失，此项属于已复现的边界缺陷。

[已验证 E7] 项目已有 `CoverImg` 的模块级 fetch → blob → object URL 缓存，名义预算为 800 条 / 32 MiB，并具有六路并发、LIFO 排队和同 URL 在途去重；统计行没有使用它。缓存保留压缩字节，不能保证浏览器保留解码位图，挂载中的条目也可能使预算暂时超限。

[已验证 E7] 当前签入的 CSP 缺少 `connect-src http://covers.localhost` 和 `img-src blob:`。使用真实 `CoverImg` 组件、三次挂载的浏览器 CSP 诊断结果：

| 诊断 CSP | fetch 调用次数 | 服务端请求数 | 成功 load / error | 观察 |
| --- | ---: | ---: | --- | --- |
| 无 CSP | 1 | 1 | 3 / 0 | 缓存复用 |
| 当前配置 | 3 | 1 | 3 / 0 | 三次 fetch 被 `connect-src` 阻止，退回原生 URL |
| 只补 connect-src | 1 | 1 | 0 / 3 | blob 图片被 `img-src` 阻止 |
| 两项均补齐 | 1 | 1 | 3 / 0 | 缓存复用 |

[已验证 E5、E7] 预热直接读取 `image.src` 并调用 `decode()`，没有等待起初无 `src` 的异步缓存结果，也未观察 `src` 属性变更。缓存组件最终写入 blob URL，而 `unavailableCovers` 按原始逻辑 URL 查找。

[推断 E4、E5、E7] 直接替换图片标签仍需处理 CSP、异步来源和占位状态的契约。112 张游戏原图的压缩总量约 108.87 MiB，高于现有 32 MiB 名义预算；仅调大缓存或添加版本都不能同时解决重复读取与解码成本。

[方案；未执行，依据 E1–E7] 修复顺序与验收条件：

1. 保留虚拟化，为统计封面生成按呈现尺寸与设备 DPR 选择的缩略图，降低压缩字节和像素量。复测完整遍历后的中段请求体积与解码耗时。
2. 给封面和缩略图提供稳定的内容版本；内容变化才更新版本，避免每次渲染使用当前时间。让未变化版本使用现有 immutable 缓存分支，验证覆盖文件后的更新可见性。
3. 接入跨行生命周期的缓存和在途去重，同步补齐相关 CSP 指令。针对缓存淘汰、快速往返和不同版本验证复用及释放。
4. 预热按逻辑来源追踪状态，等待异步 `src`，观察来源变化；将原始 URL 与 blob URL 的展示状态对应起来，验证首次缓存未命中及换图场景。
5. 将 400ms 超时视为暂时占位，晚到成功后恢复展示；对失败来源保留有界重试状态，验证三轮往返的失败请求数。
6. 在安装版 WebView2 中完成同样的中段回访，采集实际协议请求、文件读取与画面时序，再判定修复效果。

[已验证 E0、E3、E6–E8] 两套滚动审查结果均为 `complete: true`。5 个主场景、4 个缓存/CSP 场景和 1 个实际形态场景完成；7 项预热单测通过、失败为 0。两套结果各自的 9 个源码哈希与当前文件一致；数据库盘点脚本、统计 SQL 源文件及实际形态引用的证据哈希也已核对一致。

覆盖清单与待办：

| 范围 | 状态 | 证据或待办 |
| --- | --- | --- |
| 三列虚拟行生命周期、稳定 key、memo、原生图片来源 | 已审查并浏览器复现 | E1、E3；短影视列的常驻边界已区分 |
| covers 的版本、ETag、304 与 `fs::read` 分支 | 已审查源码并镜像响应 | E2；原生调用和实际读盘次数待测 |
| 当前统计排名封面、归档合并与 Steam 来源选择 | 已只读盘点 | E4；这是快照口径 |
| 首屏预热、慢图、失败图 | 已审查并复现 | E5、E6、E8 |
| 模块级图片缓存及 CSP | 已审查并浏览器诊断 | E7；安装版有效 CSP 待核对 |
| 既有生命周期测试的覆盖范围 | 已审查测试源码 | E8；其滚动段没有中段图片复用断言 |
| 实际 WebView2 的逐帧闪烁、GPU 时序与解码缓存淘汰 | 未测量，待办 | 安装版采集 |
| 原生协议调用及磁盘读次数 | 未测量，待办 | 原生计数或跟踪 |
| 修复后回归、构建、安装部署 | 未执行，待办 | 本次任务完成根因审查 |

[已验证 E8] 可重放的审查命令如下；`PLAYWRIGHT_MODULE` 是本机已有 Playwright 的路径：

```powershell
Set-Location -LiteralPath 'D:\ZEX'
$env:PLAYWRIGHT_MODULE = 'file:///C:/Users/20457/AppData/Local/OpenAI/Codex/runtimes/cua_node/2b841c3d44b123ec/bin/node_modules/playwright/index.mjs'
$env:PLAYWRIGHT_CHANNEL = 'chrome'
python scripts/stats-cover-data-audit.py 'F:\ZEX-0.1.0\data' --output 'D:\ZEX\docs\verification\stats-cover-data-audit.json'
$env:ZEX_STATS_AUDIT_MODES = 'current,versioned,slow,missing,pressure'
$env:ZEX_STATS_AUDIT_CACHE_MODES = 'open,config,connect,all'
$env:ZEX_STATS_AUDIT_OUTPUT = 'stats-scroll-audit'
node scripts/stats-scroll-audit.mjs
$env:ZEX_STATS_AUDIT_MODES = 'actual_shape'
$env:ZEX_STATS_AUDIT_CACHE_MODES = ''
$env:ZEX_STATS_AUDIT_OUTPUT = 'stats-scroll-shape-audit'
node scripts/stats-scroll-audit.mjs
node --test scripts/stats-preload.test.mjs
```

[已验证 E0、E8] 机器可读原始结果保存在 `docs/verification`，复现实验会重写对应结果文件。汇总 JSON 是本次已归档的派生摘要；重放后应以新原始结果为准。上面的命令不包含生成汇总 JSON 的步骤。
