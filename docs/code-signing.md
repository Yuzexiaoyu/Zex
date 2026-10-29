# ZEX 代码签名（自签名方案 A）

## 背景

ZEX 未做代码签名，用户从网上下载后 Windows SmartScreen 会弹「Windows 已保护你的电脑」。
商业证书（OV 约 ¥700/年）能解决，但零成本方案是**自签名证书 + 用户一次性导入信任**：

- 开发者本地生成自签名代码签名证书，`tauri build` 时自动给 `ZEX.exe` 和 NSIS 安装包签名；
- 用户首次运行 `安装签名（右键以管理员身份运行）.bat`（需要一次管理员授权），把证书导入本机「受信任的发布者」；
- 之后所有用该证书签名的 ZEX 版本（含以后每次更新）在本机**直接放行**，SmartScreen 与
  Win11 智能应用控制（Smart App Control）都不会再拦。

> 代价：每位用户每台电脑需要跑一次 `安装签名（右键以管理员身份运行）.bat`。面向陌生大众分发时请改用商业
> OV 证书（填入 `bundle.windows.certificateThumbprint` 即可，流程完全一样）。

## 文件清单

| 文件 | 用途 | 是否进 git |
|---|---|---|
| `scripts/gen-dev-cert.ps1` | 开发者：生成/重建签名证书 | ✅ |
| `scripts/补签.ps1` | 补签主二进制（构建 hook + 手动发布用） | ✅ |
| `scripts/打包.ps1` + 根目录 `pack-release.bat` | 一键打包发布 zip（`release\ZEX-<版本>.zip`） | ✅ |
| `scripts/安装签名.ps1` + `安装签名（右键以管理员身份运行）.bat` | 用户端：一次性导入信任 | ✅ |
| `scripts/取消签名.bat` + `scripts/取消签名.ps1` | 移除签名的工具（一般无需使用） | ✅ |
| `scripts/cert/ZEX.cer` | 公钥证书（随发布包带给用户） | ✅ |
| `scripts/cert/ZEX-signing.pfx` | 私钥备份，**绝不能外发/入库** | ❌（.gitignore 已排除） |
| `src-tauri/tauri.conf.json` | 签名配置（thumbprint + 时间戳 + 补签 hook） | ✅ |

## 开发者发布流程

1. 首次：`.\scripts\gen-dev-cert.ps1`（生成证书；签名时脚本按 CN=ZEX 自动匹配证书，无需把指纹写入配置）。
   `scripts\cert\` 下的 `ZEX.cer` 和 `安装签名.*` 一起放进发布包。
2. 每次发布：`npx tauri build`。
   - **NSIS 安装包**：`tauri.conf.json` 的 `bundle.windows.signCommand` 已让 Tauri
     在打包阶段调用 `scripts\补签.ps1` 签名——`ZEX_xxx-setup.exe` 及其内嵌的
     `ZEX.exe` 均带签名，无需额外操作。
   - **便携包**：Tauri 构建结束后会把 `target\release\zex.exe` 复位为未签名版本，
     打包 zip 前需手动补签一次：
     `powershell -ExecutionPolicy Bypass -File scripts\补签.ps1`
3. 发布包根目录需要：`ZEX.exe`（带签名）、`安装签名（右键以管理员身份运行）.bat` + `安装签名.ps1` + `ZEX.cer`、
   以及 `取消签名.bat` + `取消签名.ps1`（一般无需使用，跑 `pack-release.bat` 自动组装）。
4. 验证签名是否成功：
   ```powershell
   Get-AuthenticodeSignature .\ZEX.exe        # Status 需为 UnknownError（导入信任前）或 Valid
   Get-AuthenticodeSignature .\ZEX_*-setup.exe
   ```
   `UnknownError` 是预期行为（自签链停在不受信根），说明签名本身有效；
   `NotSigned` 才是失败。也可用 `signtool verify /v` 检查时间戳。

## 给最终用户的一页说明（放入发布包 `使用说明.txt`）

```
ZEX 使用说明（第一次使用请看这里）
====================================

1. 本软件是签名版，但你的电脑还不认识这个签名，所以需要一次授权：
   双击 安装签名（右键以管理员身份运行）.bat
   - 如果弹出「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」（只需这一次）
   - 弹出用户账户控制(UAC) → 点「是」
   - 看到「ZEX 信任证书安装完成」→ 按回车关闭
2. 双击 ZEX.exe 开始使用。
3. 以后更新版本无需再操作；换新电脑时重复第 1 步。
4. 附带的「取消签名.bat」可移除 ZEX.exe 的签名（一般无需使用，双击运行即可）。
```

为什么需要管理员：导入系统级信任存储必须提权，一次即可，可放心（证书内容只有
"信任 ZEX 发布者"这一个用途）。导入过程为静默操作，不会再弹出其他窗口。

## 证书轮换（每 3 年一次）

自签发证书 Windows 限制有效期 3 年（`gen-dev-cert.ps1` 已按上限生成）。
到期前的处理：

1. 运行 `.\scripts\gen-dev-cert.ps1 -Force -PfxPassword 新密码` 重建证书；
2. 把新指纹更新到 `tauri.conf.json` 的 `bundle.windows.certificateThumbprint`；
3. 重新构建发布，并**通知所有用户重新运行一次 安装签名（右键以管理员身份运行）.bat**。

### 避免轮换的替代方案（可选）

生成一张 3 年期的自签根证书，用它签发 1 年期的代码签名叶子证书；用户只导入根证书。
叶子到期时换发新叶子（签名身份不变），用户端无需任何操作。目前未采用，若轮换成本
难以接受再升级为此结构。

## 常见问题

- **tauri build 已配置签名但 target\release\zex.exe 没签名？** Tauri 2.11.5 的行为：
  默认 `certificateThumbprint` 签名路径对主二进制"假成功"（日志显示成功、产物无签名），
  且 patch 步骤会重写二进制、抹掉提前做的签名。已改用 `bundle.windows.signCommand`
  完全接管签名（时机在 patch 之后、NSIS 打包之前，实测安装器及其内嵌 exe 均带签名）；
  Tauri 构建结束后会把 target 目录的主 exe 复位，发布前手动跑一次
  `补签.ps1` 即可。
- **安装签名（右键以管理员身份运行）.bat 被 SmartScreen 拦？** 它是未签名脚本，每台机器仅第一次会拦，
  点「更多信息→仍要运行」即可（这一步之后它就不再弹）。
- **为什么不用 EV/OV？** 微软 2024 年起已取消 EV 证书的 SmartScreen 即时信誉特权，
  任何证书首次发布都要积累信誉；自签 + 信任导入是唯一零成本的确定性免弹方案，
  代价是用户要做一次导入。
- **私钥安全**：`ZEX-signing.pfx` 只作备份，正常构建不依赖它（私钥在开发机的
  证书存储里）。不要把 pfx 发给任何人，不要放网盘公开链接。
