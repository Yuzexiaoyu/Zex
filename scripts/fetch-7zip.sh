#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/src-tauri/7zip"
URL="https://github.com/ip7z/7zip/releases/download/26.03/7z2603-extra.7z"
SHA256="191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f"
BSDTAR="/c/Windows/System32/tar.exe"
CURL="/c/Windows/System32/curl.exe"

if [[ ! -x "$BSDTAR" || ! -x "$CURL" ]]; then
  printf '%s\n' 'Windows tar.exe and curl.exe are required.' >&2
  exit 1
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PROXY_ARGS=()
if [[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]]; then
  PROXY_ARGS=(--proxy "${HTTPS_PROXY:-${https_proxy:-}}")
fi
"$CURL" --fail --location --max-time 300 "${PROXY_ARGS[@]}" "$URL" -o "$(cygpath -w "$TMP/extra.7z")"
printf '%s  %s\n' "$SHA256" "$TMP/extra.7z" | sha256sum --check --status
mkdir "$TMP/extracted"
"$BSDTAR" -xf "$(cygpath -w "$TMP/extra.7z")" -C "$(cygpath -w "$TMP/extracted")" x64/7za.exe License.txt readme.txt
mkdir -p "$DEST"
cp "$TMP/extracted/x64/7za.exe" "$DEST/7za.exe"
cp "$TMP/extracted/License.txt" "$TMP/extracted/readme.txt" "$DEST/"
"$DEST/7za.exe" i
printf '%s\n' "7-Zip Extra 26.03 installed in $DEST"
