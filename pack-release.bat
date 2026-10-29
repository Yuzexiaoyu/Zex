@echo off
rem 一键打包 ZEX 发布 zip。用法: pack-release.bat [-Build] [-WithSetup] [-Unsign]
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\打包.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo 打包失败，详见上方输出。
pause
exit /b %RC%