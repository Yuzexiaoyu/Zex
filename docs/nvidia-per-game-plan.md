# ZEX 逐游戏 NVIDIA 设置（Smooth Motion 插帧 + DLSS 覆盖）计划书

建立：2026-09-26

## 目标
在现有「帧数显示 / 锁帧」面板（`FpsSettingsModal`）里新增**第三列**,逐游戏(及全局)配置 NVIDIA 驱动级设置:
- **Smooth Motion** —— 驱动级 AI 插帧,任意 DX11/12/Vulkan 游戏都能开。
- **DLSS 覆盖**(仅对已支持 DLSS 的游戏):SR 预设 / 模型、FG 最新模型、多帧生成(MFG)倍率等。

入口复用现有面板,不新增。

## 探查结论(现状)
**前端** `src/components/FpsSettingsModal.tsx`:1280px 弹窗,横向布局 = 左栏(272px)配置对象列表(全局 + 每游戏 + RTSS 状态)| 右侧 flex 区当前分**两列**:中栏「帧数显示(OSD)」、右栏「锁帧 + 兼容性」。数据模型 `ProfileConfig`(全标量),改任一项即 `patch()`→`rtssWriteProfile(target,cfg)` 落盘;切 target 整份重读。入口在 `GameView.tsx` 的 `showFpsModal`:全局按钮 `setShowFpsModal('')` + 右键菜单 `GameContextMenu`「帧数设置」`setShowFpsModal(gameId)`。

**后端** `src-tauri/src/rtss.rs` + `lib.rs` invoke_handler:`ProfileConfig` 结构体 + `rtss_status/list_targets/read_profile/write_profile/clear_profile/default_profile`。按游戏 exe 名匹配 profile;`game_process_matches` / 真身检测 / `monitor_process` 已能定位真身 exe;启动前 `ensure_osd_ready` 预置(同步门)。

→ NVIDIA 这套与 RTSS **同构**:per-target 配置 + 读写命令 + 启动前应用 + 按 exe 名生效。照抄加一列即可。

## 机制:NVAPI 驱动配置(DRS)
Smooth Motion 与 DLSS 覆盖都是驱动 profile 里的 **per-application 设置**(NVIDIA App / Profile Inspector 写的就是这套),经 NVAPI DRS 读写:
`CreateSession → LoadSettings → FindProfileByName/CreateProfile → CreateApplication(exe) → DRS_SetSetting(id,val) → SaveSettings`。

### 关键 setting ID(已从 Profile Inspector 设置库挖出)
| 功能 | HexSettingID | 取值/说明 |
|---|---|---|
| **Smooth Motion 开关** | `0xB0D384C0` | DWORD 0=关 1=开(AI 插帧主开关) |
| Smooth Motion 生效 API | `0xB0CC0875` | DWORD(限定 DX/Vulkan) |
| **DLSS SR 预设/模型** | `0x10E41DF3` | 0=默认,1..=Preset A/…/K(换 Transformer);另有 `0x00634291`「Preset Override-SR」,实现时核对二者关系 |
| DLSS = DLAA (SR) | `0x10E41DF4` | 强制 DLAA |
| DLSS FG 用最新 DLL/模型 | `0x10E41E03` | 升级帧生成模型 |
| **DLSS 多帧生成倍率(MFG)** | `0x104D6667` | Generation Factor(2/3/4×,RTX 50) |
| DLSS FG 优先级 | `0x10E41DF6` | Prioritization |

> 确切枚举值(预设编号、MFG 倍率的具体数值)实现时对着 Profile Inspector 再核；开关类基本是 0/1。RR(光线重建)预设若要再补挖 ID。

## 设计
### UI:第三列
右侧 flex 区 2 列 → 3 列:中栏 OSD | 右栏 锁帧+兼容 | **新「NVIDIA · 插帧/DLSS」列**。弹窗宽度 1280 适当加宽(约 1500)或三列等分;沿用现成 `Row/Toggle/Chips/Stepper` 组件,风格零成本统一。第三列(按当前 target):
- **Smooth Motion(AI 插帧)** 开关(+ 可选生效 API)。
- **DLSS 覆盖** 分区(带提示「仅对支持 DLSS 的游戏生效」):SR 预设(Chips)、SR 覆盖开关、FG 最新模型、MFG 倍率(Stepper 2–4×)。
- GPU/驱动不支持时整列置灰 + 提示(靠 `nv_status`)。
- target=全局 → 写 DRS Base/Global profile;target=游戏 → 写该游戏真身 exe 的 profile。

### 数据模型 `NvConfig`(Rust struct + TS interface,serde 同 `ProfileConfig` 风格)
`smooth_motion:bool` / `smooth_motion_apis:i32` / `dlss_sr_preset:i32`(0=默认,1..) / `dlss_sr_override:bool` / `dlss_fg_latest:bool` / `dlss_mfg_factor:i32`(0/2/3/4) / `dlss_rr_preset:i32`(可选)。

### 后端:新模块 `src-tauri/src/nvapi.rs`
- 用 `libloading` 载 `nvapi64.dll` + `NvAPI_QueryInterface(魔数)` 取 DRS 函数指针(半公开,Profile Inspector 同源做法);或评估 crate `nvapi`/`nvapi-sys`(多半不覆盖最新 Smooth Motion ID,仍需手绑)。
- 命令(挂 invoke_handler,镜像 rtss 那批):`nv_status()→{supported,gpu,driver}`、`nv_read_profile(target)→NvConfig`、`nv_write_profile(target,NvConfig)`、`nv_clear_profile(target)`。
- target→exe:游戏用真身 exe 名(复用 `game_process_matches`/`monitor_process`/rtss 真身回填);全局用 base profile。

### 启动前应用
`launch_game` 里在 `ensure_osd_ready` 旁边加一手:把该游戏 `NvConfig` 写进 DRS profile(驱动在进程创建时读 profile,必须启动前设好)。

### 前端接线
`api/index.ts` 加 `NvConfig` 接口 + `nvStatus/nvReadProfile/nvWriteProfile/nvClearProfile`;弹窗新增第三列状态 `nvCfg`,切 target 时与 `rtssReadProfile` 一起读,改项即 `nvWriteProfile`,与 RTSS 列互不干扰。

## 实施步骤
1. **NVAPI PoC(风险最高,先做)**:`nvapi.rs` 用 libloading 调 DRS,能读/写某游戏 exe 的 `0xB0D384C0`,用 Profile Inspector 验证 profile 被置位。
2. 定 `NvConfig` + `nv_*` 命令 + api.ts 包装。
3. `FpsSettingsModal` 加第三列(先只放 Smooth Motion 开关,跑通读写闭环)。
4. 补 DLSS 各项 + 支持性置灰 + i18n。
5. `launch_game` 启动前应用。
6. 全链路验证。

## 风险 / 验证
- **NVAPI FFI**:DRS 函数靠 QueryInterface 魔数取,是最大不确定 → PoC 先跑通。
- **确切枚举值**:预设编号 / MFG 倍率数值,对 Profile Inspector 核对。
- **权限**:写 DRS 大概率用户态即可(NVIDIA App/Inspector 都不用管理员),PoC 确认。
- **DLSS 前提**:只对已支持 DLSS 的游戏有效,UI 要讲清(别误以为能给任意游戏加 DLSS —— 那是 Smooth Motion 的活)。
- **与 NVIDIA App 共存**:同写 DRS 库,不冲突。
- **验证**:① NVIDIA App / Profile Inspector 看 profile 是否置位;② 进游戏看 Smooth Motion 指示 / 帧数翻倍;③ 与 RTSS 限帧协同(插帧通常配合限帧)。硬件:本机 RTX 5070 Ti Laptop + 610.74,支持。

## 备选(不写 NVAPI)
ZEX 捆绑 `nvidiaProfileInspector.exe`,用它导入/应用 per-game 配置。省 FFI,但依赖外部 exe、更脆、CLI 能力有限。首选直接 NVAPI。
