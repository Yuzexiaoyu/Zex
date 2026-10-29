#Requires -Version 5.1
<#
  生成 ZEX 自签名代码签名证书（方案 A：零成本分发签名）
  在脚本所在目录运行 PowerShell：
    .\gen-dev-cert.ps1                         # 已存在则直接显示指纹，不重建
    .\gen-dev-cert.ps1 -Force -PfxPassword xxx # 重建（旧证书丢失/泄露时用），非交互可传密码

  产物（scripts\cert\）：
    ZEX.cer            -> 公钥证书，随包分发给用户（可进 git）
    ZEX-signing.pfx    -> 私钥备份，绝不能进 git、绝不能外发！

  注意事项：
  * 自签发证书有效期上限 3 年（Windows 限制）。到期后需要用 -Force 重建，
    且所有用户需重新运行一次 安装签名（右键以管理员身份运行）.bat。
  * 私钥留在本机 Cert:\CurrentUser\My，构建时由 tauri 自动签名。
#>
param(
  [switch]$Force,
  [string]$PfxPassword
)

$ErrorActionPreference = 'Stop'
$certDir = Join-Path $PSScriptRoot 'cert'

function Find-ExistingCert {
  Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -eq 'CN=ZEX' } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1
}

$cert = Find-ExistingCert
if ($cert -and -not $Force) {
  Write-Host "已存在签名证书，未重新生成。"
  Write-Host "  指纹: $($cert.Thumbprint)"
  Write-Host "  到期: $($cert.NotAfter)"
  Write-Host "请把指纹填入 src-tauri/tauri.conf.json 的 bundle.windows.certificateThumbprint"
  Write-Host "如需重建请加 -Force。"
  exit 0
}

if ($cert) { Remove-Item ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force }

$notAfter = (Get-Date).AddYears(3).AddDays(-1)
$cert = New-SelfSignedCertificate `
  -Subject 'CN=ZEX' `
  -Type CodeSigningCert `
  -KeyAlgorithm RSA `
  -KeyLength 4096 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter $notAfter `
  -FriendlyName 'ZEX code signing' `
  -CertStoreLocation 'Cert:\CurrentUser\My'

New-Item -ItemType Directory -Force -Path $certDir | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $certDir 'ZEX.cer') | Out-Null

if ($PfxPassword) {
  $sec = ConvertTo-SecureString $PfxPassword -AsPlainText -Force
} else {
  $sec = Read-Host -AsSecureString -Prompt 'pfx 备份密码（请用强密码；直接回车=空密码，有泄露风险）'
}
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $certDir 'ZEX-signing.pfx') -Password $sec | Out-Null

Write-Host ''
Write-Host '证书已生成：'
Write-Host "  指纹(Thumbprint): $($cert.Thumbprint)"
Write-Host "  有效期至        : $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "  公钥证书        : $certDir\ZEX.cer（分发给用户，可进 git）"
Write-Host "  私钥备份        : $certDir\ZEX-signing.pfx（自行备份，不要提交 git）"
Write-Host ''
Write-Host '下一步：把上方指纹填入 src-tauri/tauri.conf.json 的 bundle.windows.certificateThumbprint'
