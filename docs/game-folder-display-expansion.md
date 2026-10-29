# 游戏库文件夹：4 列 × 3 排

2026-10-28，Asia/Shanghai。

[已核实] 浮层宽度 602px，封面宽度 134px；内容区最高 648px，常规窗口完整显示 4 列 × 3 排。第 13 个游戏起内部滚动；窗口高度不足时优先保持浮层在窗口内。E1：[组件尺寸](../src/components/GameFolderPopover.tsx)，E2：[内容区高度](../src/index.css)，E6：[浏览器测量结果](verification/game-folder-layout-results.json)。

[已核实] 拖入浮层时优先命中当前浮层，避免误放进被遮住的文件夹；拖到浮层边缘时滚动内容区。调整游戏库列数后，浮层跟随文件夹卡片重新定位。E5：[GameGrid.onDragPointerMove](../src/components/GameGrid.tsx)，E6：[交互检查](verification/game-folder-layout-results.json)。

[已核实] 浏览器检查共 21 项通过，页面脚本错误为 0；使用真实 React 组件和 CSS，Tauri IPC 使用模拟接口。E6：[完整结果](verification/game-folder-layout-results.json)。

| 覆盖项目 | 检查数 | 结果 |
| --- | ---: | --- |
| 六组窗口尺寸、左右锚点、四列、卡片宽度、三排完整可见 | 6 | 通过 |
| 浮层保持打开时缩放窗口 | 1 | 通过 |
| 浅色主题布局 | 1 | 通过 |
| 0、1、5、6、12、13 个成员，滚动阈值 | 6 | 通过 |
| 跨行排序、拖入插入、边缘滚动、拖出到主网格 | 4 | 通过 |
| 内部滚轮不带动主网格 | 1 | 通过 |
| 调整主网格列数后跟随锚点 | 1 | 通过 |
| Esc 关闭 | 1 | 通过 |

[未验证] 原生 WebView 中逐项交互、真实数据库中的拖拽写入；列入人工复核项，未执行。上述交互检查只验证前端行为与 IPC 参数。E6 的 `backend` 字段记录测试边界。

[已核实] 布局截图使用测试数据。E6：[4 列 × 3 排截图](verification/game-folder-layout.png)。

[已核实] `npx tauri build --no-bundle` 成功，随后生成完整 ZIP，签名为 `Valid`、发布者 `CN=ZEX`。E7：[构建日志](verification/game-folder-desktop-build.txt)、[打包日志](verification/game-folder-package.txt)。

[已核实] 13:07 已更新 `D:\ZEX\release\ZEX-0.1.0.zip`（63,142,533 字节），只替换 F 盘安装版的 `ZEX.exe`，并重新启动。旧版备份为 `F:\ZEX-0.1.0\ZEX.exe.bak-20261028-130717`。ZIP 内、构建目录、F 盘的新版 EXE SHA256 均为 `2CE73F4B24FB2A0F5633C5B05BEE3A030FDC64B8651861D099130E1E9285005D`。E8：[部署记录](verification/game-folder-deployment.json)。

[已核实] 替换前与替换后、重启前，用户数据均为 1,936 个文件，路径、长度、SHA256 对比差异为 0；重启后进程保持运行。原生界面逐项操作仍未执行。E8：[数据校验及启动结果](verification/game-folder-deployment.json)。
