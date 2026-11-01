音乐库首入预渲染优化
====================

日期：2026-11-01。

[已验证 E1、E2] 将音乐库的首屏布局、封面加载、解码与绘制移到后台。预热完成后，点击音乐库直接启动原有行入场；如果立即点击而后台尚未准备好，会保留当前页，并提升目标封面的请求优先级。

[已验证 E2] 生产 React 运行时的成对结果：

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 单列：点击到首个动画事件 | 138.8ms | 13.2ms |
| 多列：点击到首个动画事件 | 431.8ms | 18.3ms |
| 单列/多列：点击后新增封面请求 | 36 / 93 | 0 / 0 |
| 单列/多列：点击后新增曲目查询 | 1 / 1 | 0 / 0 |
| 首次导航的准备等待帧 | 有等待 | 0 |
| 正常封面的空图帧 | 0 | 0 |

[已验证 E1–E3] 实现内容：

- 新增 `MusicSurface` 常驻透明层，保留真实布局与图片节点；仍使用虚拟列表，仅挂载视口与缓冲区。
- 图片在隐藏期间完成 decode，并给合成层两帧绘制后发布 readiness。Chrome trace 已记录隐藏音乐子树的 Paint。
- 预热和动画分离。隐藏页不播放入场；实际进入后才以当前视口为起点播放原有错峰，并保留筛选和滚动位置。
- `usePresentedView` 同时处理音乐和统计页的准备交接；用 ref 记录已呈现页，省去切页后的整树额外 state 重渲染。
- 曲目与歌单在途请求去重；就绪状态绑定当前数据引用、布局和加载终态。旧回调不能释放新数据；空库与失败均有可结束的状态。
- 隐藏音乐页不注册音乐焦点组、右摇杆目标、排序菜单或 Esc 拦截；切走时关闭 portal、清理拖拽和高亮任务。
- 修复常驻初始空数据造成的过期 `scrollend` 回调，以及取消高亮 rAF 后未清零的问题。
- 本次进入已经展示后，入场期间刷新数据也不会重新隐藏整表。

证据索引：

| ID | 文件与定位 |
| --- | --- |
| E1 | [MusicSurface.tsx](D:/ZEX/src/components/MusicSurface.tsx)、[MusicView.tsx](D:/ZEX/src/views/MusicView.tsx)、[usePresentedView.ts](D:/ZEX/src/utils/usePresentedView.ts)、[App.tsx](D:/ZEX/src/App.tsx) |
| E2 | [生产基线](D:/ZEX/docs/verification/music-prerender-production-before.json)、[最终结果](D:/ZEX/docs/verification/music-prerender-production-after.json)、[对比及源码哈希](D:/ZEX/docs/verification/music-prerender-production-summary.json)、[测试脚本](D:/ZEX/scripts/music-prerender.test.mjs) |
| E3 | [store](D:/ZEX/src/store/index.ts) 的 `prepareMusicPresentation/loadTracks/loadPlaylists`、[38 项单测](D:/ZEX/docs/verification/music-prerender-unit.log)、[音乐 store 单测](D:/ZEX/scripts/music-store.test.mjs)、[SortMenu](D:/ZEX/src/components/SortMenu.tsx)、[focus](D:/ZEX/src/gamepad/focus.ts)、[scrollTarget](D:/ZEX/src/gamepad/scrollTarget.ts) |
| E4 | [原封面 8 场景](D:/ZEX/docs/verification/music-first-cover-prerender-compat.json)、[统计切页](D:/ZEX/docs/verification/music-prerender-transition-compat.log)、[统计生命周期](D:/ZEX/docs/verification/music-prerender-lifecycle-compat.log)、[游戏库](D:/ZEX/docs/verification/music-prerender-game-compat.log) |
| E5 | [Release 构建](D:/ZEX/release/music-prerender-build.log)、[签名打包](D:/ZEX/release/music-prerender-package.log)、[ZIP 校验](D:/ZEX/docs/verification/music-prerender-package.json) |
| E6 | [部署记录](D:/ZEX/docs/verification/music-prerender-deployment.json)、[替换前清单](D:/ZEX/release/music-prerender-install-before.json)、[替换后清单](D:/ZEX/release/music-prerender-install-after.json)、[最终汇总](D:/ZEX/docs/verification/music-prerender-final-summary.json) |

[已验证 E2–E4] 38 项单测、7 个最终预渲染场景、8 个原封面场景、8 个统计切页场景，以及统计生命周期和游戏库启动回归通过。预渲染场景包括单列、多列、延迟解码、取消导航、隐藏缩放、空库、入场中刷新；真实指针操作还验证了高亮恢复与切页取消 rAF 后重新高亮。等待音乐交接时，45 张可视封面的优先级均为 high。

[已验证 E4] 自动连续切页测试增加了隐藏样式已经生效的检查，避免同一个渲染机会中移除又重加同名动画而没有真实离开；三次完整 `animationend` 的原断言保留并通过。

覆盖清单：

| 范围 | 状态 |
| --- | --- |
| 后台布局、解码、Paint、500 曲目的虚拟化 | 已验证 E2 |
| 首次导航无新增图片请求/曲目查询/空图 | 已验证 E2 |
| 取消、缩放、空库、错误终态、旧回调拒绝 | 已验证 E2、E3 |
| 隐藏交互隔离、portal、手柄、Esc、高亮恢复 | 已验证 E2、E3 |
| 途中刷新及既有音乐/统计/游戏库兼容 | 已验证 E2–E4 |
| Release、签名 ZIP、仅替换 F 盘 EXE、启动 | 已完成 E5、E6 |
| 安装版 WebView2 首入逐帧耗时 | 未采集 |

[边界 E2] 数字来自 Chromium 156.0.8078.74、Node v24.14.0、production React 19.2.8 和模拟 IPC/HTTP 图像的固定样本。测试确认 Vite PROD 与 React 生产运行时，缓存开启、无请求拦截。基线和优化版均在启动后停留约 1 秒再首次导航；真实机器耗时随磁盘、CPU 和后台准备进度变化。完整首屏逐行显现仍包含原有错峰延迟，不等同于资源等待时间。安装版 WebView2 的精确毫秒值未测量。

[已验证 E5、E6] 已更新 [ZEX-0.1.0.zip](D:/ZEX/release/ZEX-0.1.0.zip)，64,994,263 字节、1430 个条目，CRC 通过。仅替换 `F:\ZEX-0.1.0\ZEX.exe` 并恢复启动，进程响应正常；本次没有备份旧 EXE 或旧 ZIP。替换前后、重启之前，3481 个其他文件（含 2084 个 data 文件）及目录清单完全一致。

[已验证 E5、E6] 签名 `Valid`。ZIP 内、构建目录与 F 盘 EXE 的 SHA-256 一致：
`673E793D07256D8A30BF7E0C6F9672722419DE7F2E9F14D509582B5B3AE06B67`。
ZIP SHA-256：
`D7E83E55C05F66D32D8829F23A4FAA827B01017241D1D8B26233BA482EB99068`。
