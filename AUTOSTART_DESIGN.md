# 开机自启功能设计计划书 v2

> 状态:设计稿(已联网审查,待评审后实施)
> 涉及:设置页开关 + 注册表 Run 键 + 静默启动到托盘 + 单实例保护 + 手柄唤起联动
> v2 变更:①自启行为可选(驻留托盘 / 直接显示)②手柄唤起保证 ③联网审查修正

## 1. 需求

1. 设置页新增「开机自启」开关,开启后 Windows 登录时 ZEX 自动启动
2. **自启行为可选**:驻留托盘(推荐,后台照常记录与预热)或直接显示主窗口
3. **保证自启后能被手柄唤起**(西瓜键 / PS logo 键)

## 2. 现状盘点(可复用能力)

| 现状 | 说明 |
|---|---|
| `winreg` + HKCU 先例 | 西瓜键功能已写 `HKCU\...\GameBar`(lib.rs:5519),自启走 `HKCU\...\CurrentVersion\Run` 同模式,**零新依赖** |
| 托盘体系 | setup 建托盘(lib.rs:6844),窗口显示时托盘隐藏、收托盘时亮 |
| 设置页行模式 | chips [关/开] + `data-settings-row` + `rows` 数组(手柄导航),条件行有现成样板(播放引擎 mpv/external 的 `...(cond ? [...] : [])`,SettingsView.tsx:169) |
| 后端命令样板 | `set_guide_button_enabled`(lib.rs:5533):落库 + 注册表联动 + 返回同步结果,照搬 |
| 手柄唤起链路 | 轮询是 Rust 线程(gamepad::spawn_guide_watch / spawn_ps),**与窗口可见性无关**;`guide_raise`(lib.rs:6710)对 hidden 窗口(静默启动即此状态)满足唤起条件;`show_main_window`(lib.rs:6692)含 unminimize+show+**set_focus**+恢复手柄导航 |
| 托盘唤回流程 | `tray-restore` 事件 → 前端恢复 contentVisible → 回调 show,可被单实例/手柄唤起复用 |

**缺失**:无单实例保护(自启后手动双开会互抢 SQLite、互杀 mpv);西瓜键/PS 键唤起默认关。

## 3. 方案决策

### 3.1 自启机制:注册表 Run 键(不引入 autostart 插件)

- `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → 值名 `ZEX` → REG_SZ `"<exe绝对路径>" --autostart`(驻留托盘)或 `"<exe>" --autostart --show-window`(直接显示)
- 用户级,无需管理员权限;NSIS `installMode: currentUser`(tauri.conf.json:52)更新不失效
- **联网审查结论**:官方 `tauri-plugin-autostart` 在 Windows 底层同样写 Run 键、同样通过 `Builder::new().args([...])` 传启动参数——与手写殊途同归;插件跨平台抽象对本应用(仅 Windows)无收益,维持自实现(~25 行)
- **已知真实世界坑(审查所得,方案已覆盖)**:
  - exe 被移动 → 自启失效 → 第三方项目用「启动自愈」解决(Recopy #25 同款)→ 本方案 3.4 已有
  - Run 键可能被杀软/清理工具删掉(plugins-workspace #771「autostart removed after one boot」)→ 设置页**读注册表为准**显示真实状态,不会误报「已开启」
  - 卸载时应清理 Run 键(tauri #12422)→ 打包阶段检查 NSIS 卸载脚本补 `DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZEX"`
  - MSIX 包需特殊适配 → 本应用用 NSIS,不涉及
- 备选:任务计划程序(schtasks)支持开机延迟,但需权限区分、过重,放弃

### 3.2 启动行为分支:`--autostart` / `--show-window` 参数 + `visible: false`

```
判定(进程参数):
  无 --autostart        → 手动启动 → 显示窗口(现状)
  --autostart           → 驻留托盘:窗口不显示 + tray.set_visible(true)
  --autostart --show-window → 直接显示:窗口显示 + 托盘隐藏(与手动启动等价)
```

- `tauri.conf.json` 窗口 `visible` 改 `false`;setup 里按上表分支 show
- `visible:false` + setup show 时机在首帧合成前:手动启动无黑闪、无行为差异(Tauri「启动到托盘」推荐写法)
- mpv 预热线程(300ms 延迟)照常跑,两种模式都受益

### 3.3 单实例保护(必做)

- 官方 `tauri-plugin-single-instance = "2"`,**必须第一个注册插件**(插件生效要求)+ `#[cfg(desktop)]`
- 审查确认:无 JS API → **无需 capabilities 配置**;回调 `|app, _args, _cwd|`
- 第二实例回调 → `emit("tray-restore", "")` → 已有实例走既有唤回流程(恢复内容区 + show + set_focus)
- **审查修正**:官方文档示例在回调里直接 `set_focus()`,社区踩过「show 了但不 focus」的坑(ActivityWatch #208)。走 `tray-restore` 前端流程可同时规避 focus 与 contentVisible 空白帧问题,已确认 `show_main_window` 含 set_focus(lib.rs:6696)
- 顺带修复现状「手动双开」隐患

### 3.4 后端命令

```rust
const AUTOSTART_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "ZEX";

// 读:以注册表为权威(防外部改动/清理/备份恢复后不一致)
#[tauri::command]
fn get_autostart_enabled() -> bool { /* Run 键 ZEX 值存在 */ }

// 写:落库两个设置 + 按 (enabled, show) 重写注册表;返回注册表同步是否成功
#[tauri::command(async)]
fn set_autostart(state: State<'_, AppState>, enabled: bool, show: bool) -> AppResult<bool> {
    // 1. INSERT OR REPLACE settings('autostart_enabled') / ('autostart_show_window')
    // 2. enabled ? 写 "exe" --autostart[ --show-window] : 删值(NotFound 忽略)
    // 3. Ok(注册表是否成功),失败只告警(与西瓜键同语义)
}
```

- 落库目的:设置导出/导入一致性(导入/清除数据**不**联动注册表,系统行为不被数据操作静默改变;显示以注册表为准)
- **启动自愈**:setup 里读 Run 值 → 指向的 exe 不存在 → 用 `current_exe` + 当前库中行为设置重写(修复 exe 移动,Recopy #25 同款)

### 3.5 手柄唤起保证(需求 3)

**技术链路已确认成立**:自启驻留托盘时窗口 hidden → `guide_raise` 的「前台可见→不响应」判断不成立 → emit tray-restore 唤起 ✓;轮询线程与窗口可见性无关 ✓。

**唯一缺口**:`guide_button_enabled` / `ps_button_enabled` **默认关**。

设计:
- 选「驻留托盘」时,若西瓜键与 PS 键唤起**都未开启** → **自动开启 PS 键唤起**(HID 直读、零系统副作用、不涉及 Game Bar 注册表),并弹出提示说明。西瓜键不自动开(联动 Game Bar 注册表,静默改变系统行为越界)
- 设置页「自启方式」行副文案注明:「驻留托盘时自动开启 PS 键唤起;西瓜键唤起需在『手柄』设置中开启」
- 用户主动关闭手柄唤起 → 不拦,行内提示「自启驻留托盘时将无法用手柄唤起」

### 3.6 设置页 UI

- 新「启动」section,插在「库」之后、「关于」之前——行号 16/17,零侵入现有 0-15 行
- 行 16:「开机自启」chips [关/开];副文案:「开机后自动启动 ZEX」
- 行 17(条件行,仅自启开启时渲染,复用引擎条件行模式):「自启方式」chips [驻留托盘 / 显示窗口]
  - 驻留托盘副文案:「驻留系统托盘,后台照常记录与预热;PS logo 键 / 托盘图标唤回」
  - 显示窗口副文案:「开机直接显示主窗口,与手动启动一致」
- 手柄:rows 数组按现有条件行模式插入,自动获得导航
- 状态初始化:mount 时读 `get_autostart_enabled` + 库中 `autostart_show_window`

## 4. 联网审查结论汇总

| 审查点 | 结论 | 对方案的影响 |
|---|---|---|
| 手写 Run 键 vs tauri-plugin-autostart | 殊途同归,插件在 Windows 也是写 Run 键,同样用启动参数 | 维持自实现,零新依赖 |
| exe 移动后自启失效 | 真实踩坑(Recopy #25),启动自愈是社区实践 | 已有,3.4 |
| Run 键被系统/杀软清理 | 真实踩坑(plugins-workspace #771) | 读注册表为准 + 自愈重写 |
| 卸载清理 Run 键 | tauri #12422 需求 | 打包阶段补 NSIS 清理 |
| single-instance 用法 | 必须第一个注册 + #[cfg(desktop)],无 capabilities | 实施步骤修正 |
| 单实例 focus 坑 | 社区踩过 show 不 focus(ActivityWatch #208) | 走 tray-restore 前端流程,含 set_focus |
| MSIX | 需特殊适配 | 本应用 NSIS,不涉及 |

## 5. 实施步骤

1. `Cargo.toml` 加 `tauri-plugin-single-instance = "2"`(**Builder 链第一个注册**,`#[cfg(desktop)]`)
2. `tauri.conf.json` 窗口 `visible` → `false`
3. `lib.rs`:
   - 辅助函数 `autostart_registry_enabled` / `apply_autostart_registry(enabled, show)` / 自愈 `repair_autostart_registry`
   - 命令 `get_autostart_enabled` / `set_autostart(state, enabled, show)` + invoke_handler 注册
   - `.plugin(single_instance)`(第一个)+ setup 启动行为分支(见 3.2)+ Run 值自愈 + 托盘初始可见性
4. `src/api/index.ts`:`isAutostartEnabled()` / `setAutostart(enabled, show)` / `getAutostartShowWindow()`
5. `SettingsView.tsx`:「启动」section(行 16/17,条件行)+ rows 数组 + 初始化/切换函数 + 驻留托盘时的手柄唤起联动提示
6. 编译(debug)验证
7. 打包验收:NSIS 卸载清理 Run 键

## 6. 验收标准

| # | 场景 | 预期 |
|---|---|---|
| 1 | 手动启动 | 窗口正常显示,托盘隐藏,无黑闪(现状不变) |
| 2 | 开自启 + 驻留托盘 | Run 键 `ZEX = "…\zex.exe" --autostart`;重启后驻留托盘无窗口 |
| 3 | 开自启 + 直接显示 | Run 键带 `--show-window`;重启后直接显示窗口 |
| 4 | 自启状态下再双击 exe | 已有实例唤起,无第二窗口/托盘 |
| 5 | 关自启 | Run 键 ZEX 值删除 |
| 6 | 驻留托盘时按 PS logo 键 | 唤起主窗口(自动开启 PS 键唤起,若两开关原先都关) |
| 7 | 移动 exe 后启动 | Run 值自动指向新路径 |
| 8 | 注册表被手动删除 | 设置页显示「关」,重新开启即可 |
| 9 | 手柄导航 | 行 16/17 可聚焦,左右切 chips |
| 10 | 备份恢复/清除数据 | 注册表不动,设置页显示注册表真实状态 |

## 7. 风险

- `visible:false` 影响所有启动路径 → setup 分支必须覆盖全部三种情况(托盘菜单窗是独立动态窗,不受影响)
- 注册表写入失败 → 与西瓜键同策略:返回 false,前端提示 + 回滚 UI
- 自动开 PS 键唤起是唯一「代用户改设置」的点 → 仅限「驻留托盘」模式 + 全关时触发 + 明确提示,可在评审时拍板是否改为纯提示
