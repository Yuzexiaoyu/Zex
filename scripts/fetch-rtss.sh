#!/usr/bin/env bash
# 从本机 RTSS 官方安装包提取随包分发的 RTSS 到 src-tauri/rtss/（便携布局，exe 同级）。
#
# 为什么吃本地安装包而不是自动拉：RTSS 官方包发布在 Guru3D（Cloudflare 拦截脚本
# 下载），没有稳定的直链。用法: scripts/fetch-rtss.sh <RTSSSetup7xx.exe 路径>
#
# 裁剪原则：只保留帧数 OSD + 限帧所需运行文件。录屏链（SaveMedia/EncoderServer/
# libmfxsw/Codec/Plugins）与文档（SDK/Doc/Redist）全部裁掉。
#
# 两个必须保留的坑（2026-08-19 实测踩过）：
#   1. ProfileTemplates/ 是首启配置模板 —— 裁掉后 RTSS 首次初始化生成 Profiles\Config
#      时 Skin= 为空，之后每次启动弹 "failed to load, reverting to default skin"。
#   2. Localization/ + Help/ 是 RTSS UI 的多语言文本与帮助系统，皮肤加载器初始化依赖。
#
# 运行模式实测约束（见 src-tauri/rtss/VERSION）：
#   便携运行、注册表零写入、配置落 <exe 同级>/Profiles/、RTSS 自我保护不可杀。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/src-tauri/rtss"
SEVENZ="/c/Program Files/7-Zip/7z.exe"

if [ -x "$DEST/RTSS.exe" ]; then
  echo "[fetch-rtss] 已存在: $DEST/RTSS.exe（更新版本请先删目录）"
  exit 0
fi

SRC="${1:-}"
if [ -z "$SRC" ]; then
  echo "[fetch-rtss] 用法: $0 <RTSS 官方安装包路径>" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "[fetch-rtss] 找不到安装包: $SRC" >&2
  exit 1
fi
if [ ! -x "$SEVENZ" ]; then
  echo "[fetch-rtss] 找不到 $SEVENZ —— 需要 7-Zip 解 NSIS 安装包（winget install 7zip.7zip）" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[fetch-rtss] 解包 $(basename "$SRC")（排除 SDK 目录）..."
"$SEVENZ" x -y -o"$TMP" "$(cygpath -w "$SRC" 2>/dev/null || echo "$SRC")" -xr'!SDK' > /dev/null

mkdir -p "$DEST/Profiles"
# 白名单精确落文件，不用通配符 —— 防止未来安装包新增文件悄悄塞进来
cp "$TMP/RTSS.exe" "$TMP/RTSS.dat" "$TMP/RTSSHooks.dll.copy" "$TMP/RTSSHooks64.dll.copy" \
   "$TMP/RTSSHooksLoader.exe" "$TMP/RTSSHooksLoader64.exe" \
   "$TMP/RTUI.dll" "$TMP/RTMUI.dll" "$TMP/RTFC.dll" \
   "$TMP/DesktopOverlayHost.exe" "$TMP/DesktopOverlayHost64.exe" "$TMP/DesktopOverlayHostLoader.exe" \
   "$DEST/"
# 安装器里 hook dll 是 .copy 后缀，落地改回正式名
mv "$DEST/RTSSHooks.dll.copy" "$DEST/RTSSHooks.dll"
mv "$DEST/RTSSHooks64.dll.copy" "$DEST/RTSSHooks64.dll"
cp -r "$TMP/Fonts" "$TMP/Skins" "$TMP/Vulkan" "$TMP/Localization" "$TMP/ProfileTemplates" "$TMP/Help" "$DEST/"

# 模板微调（RTSS 首次初始化 Profiles/Config 时的默认值）：
#   UpdateCheckingPeriod=3 -> 0  禁更新检查（RTSS 不再联网查版本、不弹更新提示）
#   StartupViaTaskScheduler=1 -> 0  不通过计划任务自启
sed -i 's/UpdateCheckingPeriod\t\t= 3/UpdateCheckingPeriod\t\t= 0/' "$DEST/ProfileTemplates/Config"
sed -i 's/StartupViaTaskScheduler\t\t= 1/StartupViaTaskScheduler\t\t= 0/' "$DEST/ProfileTemplates/Config"

# 生成 VERSION 说明（来源审计 + 裁剪原则 + 运行模式实测约束）
RTSS_EXE_WIN="$(cygpath -w "$DEST/RTSS.exe" 2>/dev/null || echo "$DEST/RTSS.exe")"
RTSS_VER="$(powershell.exe -NoProfile -Command "(Get-Item '$RTSS_EXE_WIN').VersionInfo.FileVersion" 2>/dev/null | tr -d '\r' || echo unknown)"
SRC_HASH="$(sha256sum "$SRC" | awk '{print $1}')"
cat > "$DEST/VERSION" <<EOF
RTSS 便携发行版（随 ZEX 分发）
================================================================

版本    : $(basename "$SRC" .exe)（RTSS.exe 文件版本 $RTSS_VER）
来源    : 官方安装包 $(basename "$SRC")
          sha256 = $SRC_HASH
提取日期: $(date +%F)
许可    : freeware —— RivaTuner Statistics Server 为免费软件，
          官方授权随第三方软件捆绑分发（MSI Afterburner 即先例）。

裁剪说明（本目录只含帧数 OSD / 限帧所需运行文件，约 5.6 MB）:
  保留  RTSS.exe RTSS.dat RTSSHooks.dll RTSSHooks64.dll
        RTSSHooksLoader.exe RTSSHooksLoader64.exe
        RTUI.dll RTMUI.dll RTFC.dll
        DesktopOverlayHost.exe DesktopOverlayHost64.exe DesktopOverlayHostLoader.exe
        Fonts/ Skins/ Vulkan/ Profiles/(运行时生成)
  裁掉  录屏链: SaveMedia*/EncoderServer*/libmfxsw*/Codec/Plugins/Plugins64
        文档:   SDK/ Help/ ProfileTemplates/ Localization/(无中文) Doc/ Redist/
        安装器: \$PLUGINSDIR/ \$R0/ Uninstall.exe.nsis

运行模式（已实测验证）:
  - 便携：从任意目录直接运行 RTSS.exe，无需安装，无 UAC
  - 注册表零写入（HKLM/HKCU 均无新增键）
  - 共享内存 RTSSSharedMemoryV2 正常创建（帧数 OSD 数据源就绪）
  - 配置按文件落在 <RTSS.exe 所在目录>/Profiles/（Global / <exe>.cfg）
  - RTSS 有自我保护（taskkill 拒绝、隐藏自身 PEB 路径）：
    ZEX 只负责启动与复用，绝不尝试结束 RTSS

更新方式: 删除本目录后运行 scripts/fetch-rtss.sh <新安装包路径>
EOF

echo "[fetch-rtss] 完成 -> $DEST"
du -sh "$DEST"
