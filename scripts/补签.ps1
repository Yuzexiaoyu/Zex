#Requires -Version 5.1
<#
  补签 ZEX 二进制（自签代码签名）。

  背景：tauri build 的 certificateThumbprint 默认签名对主二进制有缺陷——
  日志显示 "Successfully signed" 但产物实际没有签名（Tauri 2.11.5 实测）；
  且 patch（写入 bundle 类型信息）发生在 beforeBundleCommand 之后，会抹掉提前做的签名。
  因此本脚本通过 bundle.windows.signCommand 被调用——时机在 patch 之后、NSIS 打包之前，
  签名结果保留在最终产物与安装器内嵌副本中。

  调用方式：
  1. 自动：tauri.conf.json 的 bundle.windows.signCommand（tauri build 时对每个
     待签二进制调用一次，路径通过 %1 传入）
  2. 手动（发布前）：powershell -ExecutionPolicy Bypass -File scripts\补签.ps1

  校验标准：签名写入且指纹匹配即为成功。Status 显示 UnknownError 属预期
  （自签链停在不受信根，用户导入 ZEX.cer 后变 Valid）；NotSigned 为失败。
#>
param(
  [string]$Exe
)
$ErrorActionPreference = 'Stop'

# 从本机证书存储取 CN=ZEX 的最新代码签名证书（轮换自动跟随，无需改配置）
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -eq 'CN=ZEX' } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1
if (-not $cert) { throw '未在 Cert:\CurrentUser\My 找到 CN=ZEX 的代码签名证书，请先运行 scripts\gen-dev-cert.ps1' }
$thumb = $cert.Thumbprint

# 找最新版 signtool（Windows Kits）
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'x64\signtool.exe') } |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
  Select-Object -First 1
if (-not $signtool) { throw '未找到 signtool.exe（需要 Windows SDK 或 VS Build Tools）' }

if (-not $Exe) { $Exe = Join-Path $PSScriptRoot '..\src-tauri\target\release\zex.exe' }
$Exe = $Exe.Trim('"')   # 防御：若调用方把引号一起传进来
if (-not (Test-Path $Exe)) { throw "找不到 $Exe，请先运行 npx tauri build" }
$Exe = (Resolve-Path $Exe).Path

& $signtool sign /sha1 $thumb /fd sha256 /tr http://timestamp.digicert.com /td sha256 $Exe
if ($LASTEXITCODE -ne 0) { throw "signtool sign 失败（exit $LASTEXITCODE）" }

$sig = Get-AuthenticodeSignature $Exe
if ($sig.Status -eq 'NotSigned') { throw '签名校验失败：产物仍为 NotSigned' }
if ($sig.SignerCertificate.Thumbprint -ne $thumb) {
  throw "签名证书指纹不符：实际 $($sig.SignerCertificate.Thumbprint)，预期 $thumb"
}

Write-Host "补签完成：$Exe"
Write-Host "  发布者: $($sig.SignerCertificate.Subject)"
Write-Host "  状态  : $($sig.Status)（UnknownError=链停在自签根，用户导入后即 Valid）"
Write-Host "  时间戳: $([bool]$sig.TimeStamperCertificate)"
