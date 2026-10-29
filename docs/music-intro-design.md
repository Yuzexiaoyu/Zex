# 音乐库入场：列间错拍、行内波纹

2026-10-29，Asia/Shanghai。

[已核实] 单列使用 120ms；多列按以下节奏入场，列间错峰、行内依次推进。列数仍随窗口宽度适配。E1：[MusicView 的 INTRO_COLUMNS、musicIntro](../src/views/MusicView.tsx)，E3：[实测配置](verification/music-intro-design-results.json)。

| 列 | 单项时长 | 起步延迟 | 每行追加延迟 | 起点位移 x/y |
| --- | ---: | ---: | ---: | --- |
| 1 | 104ms | 0ms | 10ms | -3 / 6px |
| 2 | 120ms | 22ms | 12ms | -1 / 8px |
| 3 | 136ms | 44ms | 9ms | 1 / 7px |
| 4 | 112ms | 66ms | 11ms | 3 / 6px |

[已核实] 动作由轻微上移、向原位聚拢和淡入组成，曲线为 `cubic-bezier(0.16, 1, 0.3, 1)`。静止状态保留单位变换；不改变文字尺寸与列表定位。已删除上一版额外添加的 `prefers-reduced-motion` 入场禁用规则，保留用户要求的动画。E2：[music-row-reveal 样式](../src/index.css)，E6：[修正后浏览器验证](verification/music-intro-visibility-results.json)。

[已核实] 首屏结束计时按实际成员最晚的「延迟 + 时长」再留 48ms，异步载入曲目后才开始；滚动会结束入场，重新滚回不重播。E1：[introEnd、onListScroll](../src/views/MusicView.tsx)，E3：[交互验证](verification/music-intro-design-results.json)。

[已核实] 8 项浏览器检查通过，页面脚本错误为 0。正常布局中每个首屏成员均收到 `animationend`，没有 `animationcancel`；动画前后虚拟定位容器尺寸及位置一致。E3：[完整结果](verification/music-intro-design-results.json)。

覆盖：4/3/2/1 列多列布局、单列布局、滚动打断及不重播、异步加载、减少动态效果。浏览器使用真实 MusicView 和 CSS、模拟 Tauri IPC；原生 WebView2 中的逐项交互未执行。

[已核实] 修正后上述 8 项重新通过；浏览器模拟 `prefers-reduced-motion: reduce` 时仍触发并完成音乐库入场，页面脚本错误为 0。此前检查把禁用动画视为预期，现已纠正。仅删除这条 CSS 规则，没有修改 Windows 设置。E6：[最终验证结果](verification/music-intro-visibility-results.json)。系统的 `ClientAreaAnimation` 读取为 `false`，实际原生 WebView2 的媒体查询值未读取；因此系统偏好对原生表现的影响属于推断。E7：[只读系统偏好记录](verification/music-intro-system-preferences.json)。

[已核实] 140ms 时刻预览使用测试曲目并暂停动画，不代表静止状态的透明度。E3：[入场中段截图](verification/music-intro-design-preview.png)。

[已核实] `npx tauri build --no-bundle` 成功；完整 ZIP 已生成并签名，发布者 `CN=ZEX`，签名状态 `Valid`。E4：[构建日志](verification/music-intro-design-build.txt)、[打包日志](verification/music-intro-design-package.txt)。

[已核实] 13:58 已替换 F 盘 EXE 并重启；旧版备份为 `F:\ZEX-0.1.0\ZEX.exe.bak-20261029-135826`。ZIP 内、构建目录、F 盘 EXE 哈希一致；替换前后、重启前的 1,940 个用户数据文件差异为 0。E5：[部署记录](verification/music-intro-design-deployment.json)。

[已核实] 14:08 修正版本构建、签名、打包成功并替换 F 盘 EXE，进程启动通过；原生界面逐项交互未执行。新 EXE 的 SHA256 为 `62B9C87B955F54955DB0A61A0584740799AC17EBC931E92B9C8AEFE93E86AD15`，与 ZIP 内、F 盘文件一致，签名 `Valid`；1,940 个数据文件差异为 0。旧版备份 `F:\ZEX-0.1.0\ZEX.exe.bak-20261029-140805`。E8：[构建](verification/music-intro-visibility-build.txt)、[打包](verification/music-intro-visibility-package.txt)、[部署记录](verification/music-intro-visibility-deployment.json)。
