#Requires -Version 5.1
<#
  为当前机器导入 ZEX 自签名证书（一次性操作，需要管理员权限）
  完成后本机上所有用该证书签名的 ZEX 版本直接放行：
  SmartScreen 不再弹"已保护你的电脑"，Win11 智能应用控制(Smart App Control)也放行。

  用法：双击同目录的 安装签名（右键以管理员身份运行）.bat（会自动请求管理员权限），或：
        powershell -ExecutionPolicy Bypass -File 安装签名.ps1

  文件组成：安装签名（右键以管理员身份运行）.bat + 安装签名.ps1 + ZEX.cer 三个文件必须
  在同一目录（ZEX.cer 也可放在同目录的 cert\ 子目录，对应仓库 scripts\ 下的布局）。

  实现说明：用 certutil -addstore 导入而不是 Import-Certificate——后者往
  TrustedPublisher/Root 存储写入时会弹 Windows「安全警告」UI，在提权且非交互的
  上下文中直接报 "UI is not allowed in this operation" 而失败（2026-08-27 实测）。
  certutil 静默导入，行为确定。
#>

$ErrorActionPreference = 'Stop'

# 1) 管理员检测，不是管理员则通过 UAC 自提权后重跑
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '需要管理员权限，正在申请……请在弹窗中点"是"。'
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', "`"$PSCommandPath`"")
  exit 0
}

# 2) 找证书：优先脚本同目录，其次覆盖仓库布局 scripts\cert\
$cerPath = Join-Path $PSScriptRoot 'ZEX.cer'
if (-not (Test-Path $cerPath)) {
  $alt = Join-Path $PSScriptRoot 'cert\ZEX.cer'
  if (Test-Path $alt) { $cerPath = $alt }
}
if (-not (Test-Path $cerPath)) {
  Write-Host "找不到 $cerPath" -ForegroundColor Red
  Write-Host '请确认 ZEX.cer 与 安装签名（右键以管理员身份运行）.bat 在同一个文件夹（或 cert 子目录）。'
  Read-Host '按回车关闭'
  exit 1
}

# 3) 用 certutil 静默导入两个信任存储（无 UI、幂等；已存在的同指纹证书自动跳过）
$certutil = (Get-Command certutil.exe -ErrorAction Stop).Source
foreach ($store in 'TrustedPublisher', 'Root') {
  & $certutil -addstore $store $cerPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "certutil -addstore $store 失败（exit $LASTEXITCODE）" }
}

Write-Host ''
Write-Host '============================================'
Write-Host '  ZEX 信任证书安装完成！'
Write-Host '============================================'
Write-Host '  - ZEX 以后所有新版本在本机都直接放行'
Write-Host '  - 只需做这一次（换新电脑才需要重做）'
Write-Host '  - 现在直接双击 ZEX.exe 即可启动'
Write-Host ''
Read-Host '按回车关闭'
