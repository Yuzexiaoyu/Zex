统计页滚动图片修复记录
======================

日期：2026-11-01。基线：`2ff13af29d4a2ff2746474aa604ad6056000bd9b`。原始[审查报告](D:/ZEX/docs/stats-scroll-image-audit.md)与原始测量文件保留。

[已验证 E9–E17] 已实现缩略图、稳定文件版本、跨行缓存、失败冷却、异步预热及晚到恢复。33 项单元测试通过（预热 16、缓存 8、Rust 9）；核心浏览器回归 5/5、缓存组件浏览器场景 8/8、切页场景 8/8 通过，生命周期和图库动画回归通过。前端生产构建、原生调试和 Release 构建成功；已生成 ZIP，并按用户要求仅替换 F 盘 EXE、恢复启动。

[已验证 E9；基线 E3] 同样采用 112 个游戏、6 个影视、132 个音乐条目，完整遍历后回访 `4700px` 中段，DPR 1 和 2 均没有新增 HTTP 请求和 fetch 调用。基线同类回访为 30 次完整 200、10,513,755 字节；本次为 0 次、0 字节。游戏/音乐仍重建节点，但复用原 blob；6 行影视仍常驻。

| 验收项 | 最终结果 | 证据 |
| --- | --- | --- |
| DPR 1/2 中段回访 | HTTP 0、fetch 0；复用同一逻辑 URL 与 blob | E9 `scenarios[0/1].middleRevisit` |
| 游戏 1920×620 原图缩略 | 223×72 / 446×144 / 669×216；保持比例、不放大、不改原图 | E10 |
| 800ms 慢图 | 超时暂时不可用 26 张，最终 0；成功后全部可见 | E9 `timeoutPresentation`、`final` |
| 三个缺失来源，三轮往返 | 合计 3 次 404，每个来源 1 次 | E9 `missing.requests` |
| 同行仅修改封面版本 | 行保留，blob 和采样像素更新 | E9 `versionUpdate` |
| 当前 CSP，三次挂载 | 1 fetch、1 HTTP、3 load、0 error/violation | E9 `csp` |
| 滚动副作用 | 无新增统计查询，无入场重播，无页面错误 | E9、E13 |
| 1500 条虚拟列表、手柄与切页 | 虚拟化、最后一行定位、滚动位置、托盘恢复与入场动画通过 | E13 |

[已验证 E10] 后端新增 `covers.rs`。统计 URL 带 `thumb=stats&h=72|144|216&v=文件版本`，按需等比缩小，宽上限为所选高度的 4 倍。不透明图采用 JPEG quality 85，带透明通道的图采用 PNG。缩略图缓存在 `data/covers/.stats-thumbnails-v1`，上限 64 MiB / 2000 条；生成新版时清理该来源旧版本，超限淘汰较早生成文件。同源并发生成合并；协议读取和解码移到后台，普通图与缩略图共享最多 2 个执行中的 worker。

[已验证 E10] `get_stats` 完成 Steam 封面、归档来源选择后，按当前 covers 目录下的文件名计算版本，兼容安装目录搬迁。版本为纳秒 mtime + 文件大小，统计查询只读取元数据；缩略变体有独立 ETag。匹配实际版本时返回 immutable；旧版本请求返回当前缩略图并要求重新验证。304 分支不读取图像内容，仍检查元数据。

[实现取舍 E10] 文件版本没有逐张计算内容哈希，避免统计刷新读取全部大图。正常覆盖文件会更新版本；内容未变但 mtime 改变也会生成新版本。外部工具同时保留 mtime 和大小的改写不在该失效契约内。

[已验证 E11] `CoverImg` 接入统计行，压缩字节缓存上限 800 条 / 32 MiB，6 路并发、LIFO 排队、同 URL 在途去重。发布 blob 前先固定全部活跃引用，最后一个引用释放后重新检查预算。换源立即清除旧 blob；完整 URL（含版本和尺寸）作为缓存键。缺失、网络失败与损坏图使用 30 秒冷却、最多 800 条失败记录；统计行失败时显示占位，其他调用方保留原 URL 兜底。

[已验证 E11、E12] 图片用 `data-cover-source` 保存逻辑 URL，`data-cover-status` 表示加载状态；CSP 已允许 covers fetch 和 blob 图片。预热等待异步 src，区分逻辑 URL 与 blob。400ms 超时仅放行页面，晚到成功仍更新占位。初始 DOM 变化先重新测量，旧解码不能提前提交就绪；无效布局暂停计时。预热就绪后，新滚动行不触发全页扫描或显式解码。

[已验证 E13] 既有测试中“慢图超时后永久保留占位”的断言已改为成功后恢复；图片换源断言改为检查逻辑 URL 和实际加载结果。其余切页、入场、虚拟化和手柄行为继续验证。

证据索引：

| ID | 文件 / 定位 |
| --- | --- |
| E9 | [核心结果](D:/ZEX/docs/verification/stats-image-fix-results.json)、[请求明细](D:/ZEX/docs/verification/stats-image-fix-requests.json)、[回归脚本](D:/ZEX/scripts/stats-image-regression.mjs)；`complete=true`、`sourceUnchangedDuringRun=true`，11 个源码哈希前后及最终一致 |
| E10 | [covers.rs](D:/ZEX/src-tauri/src/covers.rs:27)、[stats.rs](D:/ZEX/src-tauri/src/stats.rs:250)、[后端验证与源码哈希](D:/ZEX/docs/verification/stats-cover-backend-verification.json)、[9 项测试日志](D:/ZEX/docs/verification/stats-cover-backend-tests.txt) |
| E11 | [cover-cache.ts](D:/ZEX/src/utils/cover-cache.ts:34)、[CoverImg.tsx](D:/ZEX/src/components/CoverImg.tsx:16)、[缓存单测](D:/ZEX/scripts/cover-cache.test.mjs)、[8 个浏览器场景结果](D:/ZEX/docs/verification/cover-cache-browser-results.json) |
| E12 | [statsPreload.ts](D:/ZEX/src/utils/statsPreload.ts:19)、[StatsCovers.tsx](D:/ZEX/src/components/StatsCovers.tsx:51)、[16 项预热测试](D:/ZEX/docs/verification/stats-image-fix-preload.log) |
| E13 | [生命周期](D:/ZEX/docs/verification/stats-image-fix-lifecycle.log)、[切页](D:/ZEX/docs/verification/stats-image-fix-transition.log)、[图库动画](D:/ZEX/docs/verification/stats-image-fix-startup.log) |
| E14 | [前端构建](D:/ZEX/docs/verification/stats-image-fix-build.log)、[原生调试构建](D:/ZEX/docs/verification/stats-image-fix-native-build.log)、[最终汇总](D:/ZEX/docs/verification/stats-image-fix-summary.json) |
| E15 | [Release 构建](D:/ZEX/release/stats-image-fix-release-build.log)、[签名打包](D:/ZEX/release/stats-image-fix-package.log)、[ZIP 校验](D:/ZEX/docs/verification/stats-image-fix-package.json) |
| E16 | [部署验证](D:/ZEX/docs/verification/stats-image-fix-deployment.json)、[替换前清单](D:/ZEX/release/stats-image-fix-install-before.json)、[替换后清单](D:/ZEX/release/stats-image-fix-install-after.json) |
| E17 | [安装版启动后的缩略图校验](D:/ZEX/docs/verification/stats-image-fix-native-startup.json) |

[已验证 E9] 浏览器测试使用 Chrome 156.0.8078.74、Node v24.14.0、1600×950 窗口，HTTP 缓存开启，没有请求拦截；测试当前 React 组件和当前 CSP，统计 IPC 与缩略图 HTTP 响应为模拟数据，像素为合成图。后端真实缩略生成由独立 Rust 测试验证，未把浏览器镜像当作原生协议实测。

[已验证 E10、E14] Windows 的 Rust 测试程序初次启动出现 `0xc0000139`，给生成的测试 EXE 临时嵌入 Common Controls v6 manifest 后，9 项测试通过；生产构建配置未修改。原生 `cargo build` 成功。构建日志仍有增量缓存锁清理、链接器消息和前端分包大小提示。

[已验证 E13] 一次与生产构建并行的兼容性复测出现页面状态丢失/超时，日志保存在 `stats-image-fix-*-concurrent-build.log`。相同最终源码在构建结束后逐个重跑全部通过。[推断] 并行构建/开发服务器干扰导致该次失败，未进一步确认具体重载触发点；最终验收采用独立重跑结果。

[已验证 E15、E16] 便携包为 [ZEX-0.1.0.zip](D:/ZEX/release/ZEX-0.1.0.zip)，64,989,214 字节，1430 个条目，CRC 通过。ZIP 内 EXE、Release EXE 与 `F:\ZEX-0.1.0\ZEX.exe` 的 SHA-256 一致：`634BDE06A67D6059C4EFBFF2B9DBA32EA5A698040DE39E399C358AFC8F4FDAF1`；签名 `Valid`、发布者 `CN=ZEX`。ZIP SHA-256：`3DE55CE216AF7C05A18DA8F011D877FCBDB668138EFC5B69F3753070272877AF`。

[已验证 E16] 旧实例通过主窗口线程的 `WM_QUIT` 退出，由 Tao `LoopDestroyed` 触发 Tauri 退出清理。按用户最新要求，没有单独复制备份旧 EXE。替换前后、重启之前共 3346 个其他文件（含 1949 个 data 文件）及目录清单完全一致。随后恢复启动，新进程 32268 存活、响应正常。

[已验证 E17] 安装版启动后的只读检查发现 131 个新增缩略图，合计 2,696,549 字节，图像均可验证且符合所选尺寸上限。这证明安装版实际产生了新缩略文件；未测原生中段滚动的请求次数或逐帧时序。程序运行后的正常缓存与数据库变化不属于替换前后静态清单比较范围。

[未完成清理] 用户提出不备份旧 EXE 前，打包阶段已创建旧 ZIP 副本 `D:\ZEX\release\backups\stats-image-fix-20261101-152304\ZEX-before-fix.zip`。随后尝试删除该任务副本，自动审批拒绝，仅返回 `blocked by policy`。该旧 ZIP 仍保留；没有额外旧 EXE 文件备份。

覆盖与边界：

| 范围 | 状态 |
| --- | --- |
| 缩略尺寸、比例、版本、搬迁目录、304、缺失、并发生成、磁盘预算 | 已验证，E10 |
| 跨挂载缓存、换源、并发、引用保护、释放与淘汰、失败冷却 | 已验证，E11 |
| 异步来源、晚到成功、旧解码、DOM 变动、无效布局、清理 | 已验证，E12 |
| 完整遍历与中段复用、版本像素更新、慢图、缺图、CSP | 已验证，E9 |
| 切页动画、虚拟化、手柄、托盘恢复、既有图库兼容 | 已验证，E13 |
| 前端生产构建、原生调试和 Release 构建 | 已执行并成功，E14、E15 |
| 安装版启动与真实缩略图生成 | 已通过基本验证，E16、E17 |
| 安装版 WebView2 协议次数、实际文件读取、逐帧闪烁、GPU/解码耗时 | 未测量，后续实机验收 |
| ZIP、签名、CRC、三处 EXE 哈希、F 盘单文件替换与恢复启动 | 已完成，E15、E16 |
| 此次旧 ZIP 副本清理 | 自动审批拒绝删除，副本仍保留 |

[边界 E9–E11] 零重复请求结论适用于本次数据量和缓存状态；缓存被其他页面挤出后仍可能重新读取。缓存保存压缩字节，不能保证浏览器永久保留解码位图。本次没有测量修复后的实际 WebView2 解码时间、GPU 内存或真实图库的全程帧率。

可重放命令（先构建，结束后逐个运行浏览器测试；新回归会重写新修复结果，不覆盖旧审查基线）：

```powershell
Set-Location -LiteralPath 'D:\ZEX'
npm run build
cargo build --manifest-path src-tauri/Cargo.toml
node --test scripts/stats-preload.test.mjs scripts/cover-cache.test.mjs
$env:PLAYWRIGHT_MODULE = 'file:///C:/Users/20457/AppData/Local/OpenAI/Codex/runtimes/cua_node/2b841c3d44b123ec/bin/node_modules/playwright/index.mjs'
$env:PLAYWRIGHT_CHANNEL = 'chrome'
node scripts/cover-cache-browser.test.mjs
node scripts/stats-image-regression.mjs
node scripts/stats-lifecycle.test.mjs
node scripts/stats-transition.test.mjs
node scripts/startup-animation.test.mjs
```

[已验证 E10] Rust 测试的编译、实际执行命令及 Windows manifest 处理步骤见后端验证 JSON；该步骤作用于生成的测试二进制。
