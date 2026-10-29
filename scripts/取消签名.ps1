#Requires -Version 5.1
<#
  移除 ZEX 二进制的代码签名（补签.ps1 的逆操作）。

  用途：制作「未签名」对照/测试副本（例如验证新用户首次运行 SmartScreen 弹窗），
  或撤销一次误签。警告：会在磁盘上直接修改文件，如需保留原文件请先复制。

  调用方式：
    powershell -ExecutionPolicy Bypass -File scripts\取消签名.ps1 [-Exe 路径]
  默认目标：src-tauri\target\release\zex.exe
#>
param(
  [string]$Exe
)
$ErrorActionPreference = 'Stop'

# 找最新版 signtool（Windows Kits）
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'x64\signtool.exe') } |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
  Select-Object -First 1
if (-not $signtool) { throw '未找到 signtool.exe（需要 Windows SDK 或 VS Build Tools）' }

if (-not $Exe) { $Exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\zex.exe' }
$Exe = $Exe.Trim('"')   # 防御：若调用方把引号一起传进来
if (-not (Test-Path $Exe)) {
  # 随发布包分发时，脚本与 ZEX.exe 同目录——以那里的 ZEX.exe 为兜底目标
  $local = Join-Path $PSScriptRoot 'ZEX.exe'
  if (Test-Path $local) { $Exe = $local }
}
if (-not (Test-Path $Exe)) { throw "找不到 $Exe（同目录也无 ZEX.exe），请用 -Exe 指定目标" }
$Exe = (Resolve-Path $Exe).Path

$before = Get-AuthenticodeSignature $Exe
if ($before.Status -eq 'NotSigned') {
  Write-Host "无需处理：$Exe 本就未签名（$before.Status）"
  return
}

& $signtool remove /s $Exe
if ($LASTEXITCODE -ne 0) { throw "signtool remove 失败（exit $LASTEXITCODE）" }

$after = Get-AuthenticodeSignature $Exe
if ($after.Status -ne 'NotSigned') {
  throw "移除失败：产物状态仍为 $($after.Status)"
}

Write-Host "已移除签名：$Exe"
Write-Host "  原状态: $($before.Status)（$($before.SignerCertificate.Subject)）→ 现状态: $($after.Status)"
