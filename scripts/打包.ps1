#Requires -Version 5.1
<#
  打包 ZEX 发布压缩包（含自签证书的信任导入文件）。

  产物：release\ZEX-<版本>.zip
    内含：ZEX.exe              —— 已补签的主程序
          mpv\ rtss\ skin\     —— 随包运行时组件：视频播放器 / 帧数 OSD / 播放器皮肤。
                                  必须与 ZEX.exe 同级，解析代码只认这一处
                                  （mpv.rs resolve_mpv、rtss.rs resolve_rtss）
          folder-covers\       —— 文件夹封面的内置候选图（folders.rs resolve_folder_covers），
                                  同样必须与 ZEX.exe 同级
          安装签名（右键以管理员身份运行）.bat / 安装签名.ps1、ZEX.cer —— 用户一次性信任导入
          取消签名.ps1 / 取消签名.bat —— 移除签名的工具（一般无需使用）
          使用说明.txt         —— 首次使用指引（自动生成）
          （-WithSetup 时附带 ZEX_<版本>_x64-setup.exe 安装包）

  用法（等价入口：根目录 pack-release.bat）：
    powershell -ExecutionPolicy Bypass -File scripts\打包.ps1 [-Build] [-WithSetup] [-Unsign]
    -Build       先执行 npx tauri build 再打包（默认：产物已存在则直接打包）
    -WithSetup   把 NSIS 安装包一并放进压缩包
    -Unsign      打包「未签名对照测试版」：压缩包内 ZEX.exe 会移除签名
                 （用于验证未导入信任的电脑首次运行 SmartScreen 弹窗），
                 zip 名为「ZEX-<版本>-未签名测试版.zip」

  说明：Tauri 2.11.5 构建结束后会把 target\release\zex.exe 复位为未签名状态，
  因此本脚本打包前必定先调用 补签.ps1 补签。
#>
param(
  [switch]$Build,       # 强制先 npx tauri build
  [switch]$DebugBuild,
  [switch]$WithSetup,   # 附带 NSIS 安装包（需先 tauri build 生成）
  [switch]$Unsign       # 打包未签名对照测试版（验证新用户首次运行 SmartScreen 弹窗）
)
$ErrorActionPreference = 'Stop'
# Compress-Archive 内部的 Write-Progress 在输出被重定向/管道时会让 PS 5.1 抛
# IndexOutOfRangeException，且进度条无意义——统一静默
$ProgressPreference = 'SilentlyContinue'

function Assert-PackChildPath([string]$Path, [string]$Parent) {
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  $resolvedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $resolvedPath.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "暂存清理路径超出预期目录：$resolvedPath（预期位于 $resolvedParent）"
  }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$conf = Get-Content (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$ver = $conf.version
$profile = if ($DebugBuild) { 'debug' } else { 'release' }
$exe = Join-Path $root "src-tauri\target\$profile\zex.exe"
$setup = Join-Path $root "src-tauri\target\$profile\bundle\nsis\ZEX_${ver}_x64-setup.exe"

$embeddedInputs = @('src-tauri\7zip\7za.exe', 'src-tauri\src\archive.rs', 'src-tauri\build.rs', 'src-tauri\tauri.conf.json')
$embeddingChanged = $false
if (Test-Path $exe) {
  $builtAt = (Get-Item $exe).LastWriteTimeUtc
  foreach ($inputPath in $embeddedInputs) {
    if ((Get-Item (Join-Path $root $inputPath)).LastWriteTimeUtc -gt $builtAt) { $embeddingChanged = $true }
  }
}

# ---- 1. 构建（产物缺失、内嵌组件更新或显式 -Build 时）----
if ($Build -or $embeddingChanged -or -not (Test-Path $exe)) {
  Write-Host "== 构建 npx tauri build =="
  Push-Location $root
  try {
    if ($DebugBuild) { & npx tauri build --debug --no-bundle } else { & npx tauri build }
    if ($LASTEXITCODE -ne 0) { throw "tauri build 失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
} else {
  Write-Host "== 使用现有构建产物：$exe"
}
if (-not (Test-Path $exe)) { throw "未找到 $exe（构建失败？）" }

# ---- 2. 补签主程序（Tauri 构建后 target 内的 exe 会被复位为未签名）----
# -Unsign 模式不动 target 里的签名状态，打包时直接对暂存副本删签名
if ($Unsign) {
  Write-Host "== -Unsign 模式：跳过补签（target 签名状态保持原样）=="
} else {
  Write-Host "== 补签主程序 =="
  & (Join-Path $PSScriptRoot '补签.ps1') -Exe $exe
}

# ---- 3. 组装暂存目录 ----
$staging = Join-Path $env:TEMP ("zex-pack-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
  Copy-Item $exe (Join-Path $staging 'ZEX.exe')

  # 随包运行时组件：平铺到 ZEX.exe 同级。这几样不内嵌进 exe（mpv.exe 单个 117 MB），
  # 而解析代码已去掉开发树兜底，所以漏带 = 对应功能直接不可用
  # （folder-covers = 文件夹封面候选图，见 folders.rs get_folder_cover_presets）
  foreach ($name in @('mpv', 'rtss', 'skin', 'folder-covers')) {
    $from = Join-Path $root "src-tauri\$name"
    if (-not (Test-Path $from)) {
      throw "缺少随包组件 src-tauri\$name（mpv/rtss/skin 可先运行 scripts\fetch-<name>.sh）"
    }
    Copy-Item $from (Join-Path $staging $name) -Recurse
  }
  # RTSS 的运行时产物不跟着分发：Profiles\* 是本机的 OSD 配置（新机首启由 RTSS 按
  # ProfileTemplates 重建，EnableStat 等项 ZEX 启动时会重写，见 rtss.rs），
  # mainwnd.dibcache 是 RTSS 窗口位图缓存（3 MB 纯垃圾）。空 Profiles\ 目录要留着
  $stagedProfiles = Join-Path $staging 'rtss\Profiles'
  Assert-PackChildPath -Path $stagedProfiles -Parent $staging
  Remove-Item -LiteralPath $stagedProfiles -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $stagedProfiles | Out-Null
  Remove-Item (Join-Path $staging 'rtss\mainwnd.dibcache') -Force -ErrorAction SilentlyContinue

  Copy-Item (Join-Path $PSScriptRoot '安装签名（右键以管理员身份运行）.bat') $staging
  Copy-Item (Join-Path $PSScriptRoot '安装签名.ps1') $staging
  Copy-Item (Join-Path $PSScriptRoot 'cert\ZEX.cer') $staging
  Copy-Item (Join-Path $PSScriptRoot '取消签名.bat') $staging
  Copy-Item (Join-Path $PSScriptRoot '取消签名.ps1') $staging

  $readme = @'
ZEX 使用说明（第一次使用请看这里）
====================================

1. 本软件是签名版，但你的电脑还不认识这个签名，所以需要一次授权：
   双击 安装签名（右键以管理员身份运行）.bat
   - 如果弹出「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」（只需这一次）
   - 弹出用户账户控制(UAC) → 点「是」
   - 看到「ZEX 信任证书安装完成」→ 按回车关闭
2. 双击 ZEX.exe 开始使用。
   注意：mpv、rtss、skin 三个文件夹必须和 ZEX.exe 待在同一个目录里 ——
   它们分别是视频播放器、帧数 OSD、播放器皮肤，只把 ZEX.exe 拖走这些功能就没了。
   （folder-covers 是文件夹封面的内置候选图，同上；缺了只是换封面时没有内置图可选）
3. 以后更新版本无需再操作；换新电脑时重复第 1 步。
4. 附带的「取消签名.bat」可移除 ZEX.exe 的签名（一般无需使用，双击运行即可，
   完成后按任意键关闭）。
'@
  if ($Unsign) {
    $readme = "【未签名测试版】仅用于验证未导入信任的电脑首次运行时的 SmartScreen 弹窗；正式发布请使用正式压缩包。`n`n" + $readme
  }
  $readme | Out-File -FilePath (Join-Path $staging '使用说明.txt') -Encoding utf8

  if ($Unsign) {
    Write-Host "== 移除暂存副本签名（未签名对照测试版）=="
    & (Join-Path $PSScriptRoot '取消签名.ps1') -Exe (Join-Path $staging 'ZEX.exe')
  }

  if ($WithSetup) {
    if (Test-Path $setup) {
      Copy-Item $setup $staging
    } else {
      Write-Warning "未找到安装包 $setup，已跳过（可先运行 npx tauri build）"
    }
  }

  # ---- 4. 压缩 ----
  $releaseDir = Join-Path $root 'release'
  New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
  $buildTag = if ($DebugBuild) { '-debug' } else { '' }
  $zipName = if ($Unsign) { "ZEX-${ver}${buildTag}-未签名测试版.zip" } else { "ZEX-${ver}${buildTag}.zip" }
  $zip = Join-Path $releaseDir $zipName
  if (Test-Path $zip) {
    # 旧包可能被预览窗格/解压软件占用，重试几次并给出明确提示
    for ($i = 1; $i -le 5; $i++) {
      try { Remove-Item $zip -Force -ErrorAction Stop; break }
      catch {
        if ($i -eq 5) { throw "无法覆盖 $zip —— 旧压缩包正被其他程序占用（资源管理器预览窗格、7-Zip 等），请关闭后重试" }
        Start-Sleep -Seconds 1
      }
    }
  }
  Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal

  # ---- 5. 校验展示 ----
  Write-Host ""
  Write-Host "== 压缩包内容及签名校验 =="
  $sig = Get-AuthenticodeSignature (Join-Path $staging 'ZEX.exe')
  if ($Unsign) {
    Write-Host "  ZEX.exe        $($sig.Status)（预期：未签名对照测试版）"
  } else {
    Write-Host ("  ZEX.exe        {0}  ({1})" -f $sig.Status, $sig.SignerCertificate.Subject)
  }
  foreach ($probe in @('mpv\mpv.exe', 'rtss\RTSS.exe', 'skin\scripts', 'folder-covers')) {
    $full = Join-Path $staging $probe
    $size = if (Test-Path $full) {
      $item = Get-Item $full
      $bytes = if ($item.PSIsContainer) {
        (Get-ChildItem $full -Recurse -File | Measure-Object Length -Sum).Sum
      } else { $item.Length }
      "{0,8:N1} MB" -f ($bytes / 1MB)
    } else { '  缺失！' }
    Write-Host ("  {0,-14} {1}" -f $probe, $size)
  }
  if ($WithSetup -and (Test-Path $setup)) {
    $sig2 = Get-AuthenticodeSignature $setup
    Write-Host ("  setup.exe      {0}  ({1})" -f $sig2.Status, $sig2.SignerCertificate.Subject)
  }
  $zipSize = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host ""
  Write-Host "打包完成：$zip（$zipSize MB）"
} finally {
  Assert-PackChildPath -Path $staging -Parent $env:TEMP
  if ([System.IO.Path]::GetFileName($staging) -notlike 'zex-pack-*') { throw "异常暂存目录：$staging" }
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
