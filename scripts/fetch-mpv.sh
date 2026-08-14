#!/usr/bin/env bash
# 拉取随包分发的 mpv（Windows x86_64）到 src-tauri/resources/mpv/。
#
# 两个坑：
#  1. 解压必须用 C:/Windows/System32/tar.exe —— 那个是 bsdtar/libarchive，原生支持 7z。
#     PATH 里 Git 自带的 GNU tar 排在前面且**不支持 7z**，直接调 `tar` 会失败。
#  2. shinchiro 的包里除了 mpv.exe 还有 doc/、installer/ 等一堆用不上的东西，
#     只挑运行必需的落地，否则安装包白白胖十几 MB。
set -euo pipefail

REPO="shinchiro/mpv-winbuild-cmake"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/mpv"
BSDTAR="/c/Windows/System32/tar.exe"

if [ -x "$DEST/mpv.exe" ]; then
  echo "[fetch-mpv] 已存在: $DEST/mpv.exe"
  exit 0
fi

if [ ! -x "$BSDTAR" ]; then
  echo "[fetch-mpv] 找不到 $BSDTAR —— 需要 Windows 自带的 bsdtar 来解 7z" >&2
  exit 1
fi

echo "[fetch-mpv] 查询 $REPO 最新 release ..."
ASSET_URL=$(curl -sS --max-time 60 "https://api.github.com/repos/$REPO/releases/latest" | python -c "
import json,sys
r = json.load(sys.stdin)
# 要 mpv-x86_64-<date>-git-<sha>.7z：排除 -dev-（只有头文件和 lib）和 -v3-（要求 AVX2 的 CPU）
for a in r['assets']:
    n = a['name']
    if n.startswith('mpv-x86_64-') and n.endswith('.7z') and '-dev-' not in n and '-v3-' not in n:
        print(a['browser_download_url'])
        break
")

if [ -z "$ASSET_URL" ]; then
  echo "[fetch-mpv] 没在 release 里找到 mpv-x86_64 包" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[fetch-mpv] 下载 $(basename "$ASSET_URL") ..."
curl -sSL --max-time 600 -o "$TMP/mpv.7z" "$ASSET_URL"

echo "[fetch-mpv] 解压 ..."
mkdir -p "$TMP/x"
"$BSDTAR" -xf "$(cygpath -w "$TMP/mpv.7z" 2>/dev/null || echo "$TMP/mpv.7z")" -C "$TMP/x"

SRC=$(dirname "$(find "$TMP/x" -name mpv.exe -print -quit)")
if [ -z "$SRC" ] || [ ! -f "$SRC/mpv.exe" ]; then
  echo "[fetch-mpv] 包里没找到 mpv.exe" >&2
  exit 1
fi

mkdir -p "$DEST"
# mpv.exe 是静态链接的，同级 DLL（vulkan-1/d3dcompiler 等）按需带上；doc/installer/mpv.com 一律不要
cp "$SRC/mpv.exe" "$DEST/"
find "$SRC" -maxdepth 1 -name '*.dll' -exec cp {} "$DEST/" \;

echo "[fetch-mpv] 完成 -> $DEST"
ls -la "$DEST"
