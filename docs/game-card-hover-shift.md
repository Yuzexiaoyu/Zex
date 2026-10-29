# 游戏封面取消悬停时的收尾微移

2026-10-29，Asia/Shanghai。

[已核实] 旧样式下，卡片和封面的 `transform` 在取消悬停后从矩阵切回 `none`；主网格存在小数像素尺寸，测量卡片宽度为 153.75px。E1：[原样式测量](verification/game-hover-transform-before.json)。

[推断] 收尾的图层切换和重新采样造成视觉微移，而非游戏库重新排版。E1 中收尾前后的卡片坐标及尺寸一致；E2 的旧样式回放在缩放接近 1 时仍出现明显像素变化。

[已核实] 卡片现在保持单位变换；封面在缩小、静止和放大时均保持相同的 3D 变换路径，并用 `will-change: transform` 稳定绘制层。悬停倍率仍为 1.06，过渡仍为 0.35 秒。E3：[src/index.css](../src/index.css)，[修改后测量](verification/game-hover-transform-after.json)。

[已核实] 真实封面、1366×900 窗口下，对比退出悬停后第 320ms 的接近单位缩放帧与结束帧。旧样式回放在 DPR=1 时，22,698 个采样像素中有 4,681 个像素的通道差值超过 2，最大差值 59。E2：[旧样式像素对比](verification/game-hover-original-pixels.json)。

[已核实] 修改后四种 DPR 下，收尾帧与结束帧均无通道差值超过 2 的像素；悬停前与恢复后同样通过该检查。保留了原始像素计数，没有声称所有截图逐字节一致。E4：[修改后像素对比](verification/game-hover-fixed-pixels.json)。

| Chrome deviceScaleFactor | 收尾/结束最大通道差值 | 悬停前/恢复后最大通道差值 | 超过 2 的像素数 |
| --- | ---: | ---: | ---: |
| 1 | 2 | 2 | 0 |
| 1.25 | 0 | 0 | 0 |
| 1.5 | 1 | 0 | 0 |
| 2 | 1 | 2 | 0 |

[已核实] 21 项游戏库回归检查通过，覆盖 4×3 文件夹、窗口缩放、跨行排序、拖入拖出、滚动、锚点跟随、Esc 关闭；页面脚本错误为 0。E5：[回归记录](verification/game-hover-library-regression.json)。

[未验证] 原生 WebView2 中的逐项鼠标操作、其他显卡驱动和系统 DPI 配置，列入人工复核项。E4 使用 Chrome 的 deviceScaleFactor 模拟像素比例；E5 的 Tauri IPC 使用模拟接口。

[已核实] 最终源代码通过 `npx tauri build --no-bundle`；完整 ZIP 已重新生成并签名，发布者 `CN=ZEX`，签名状态 `Valid`。E6：[桌面构建日志](verification/game-hover-desktop-build.txt)、[打包日志](verification/game-hover-package.txt)。

[已核实] 13:13 已更新 `D:\ZEX\release\ZEX-0.1.0.zip`（63,142,641 字节），仅替换 F 盘安装版的 `ZEX.exe` 并重启。旧程序备份为 `F:\ZEX-0.1.0\ZEX.exe.bak-20261029-131348`。ZIP 内、构建目录、F 盘的新 EXE 哈希一致；替换前后、重启前的 1,936 个用户数据文件差异为 0。重启后进程保持运行，原生界面逐项操作未执行。E6：[部署与数据校验记录](verification/game-hover-deployment.json)。
