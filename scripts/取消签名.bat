@echo off
rem 移除本目录 ZEX.exe 的签名（双击运行，完成后按任意键关闭）。
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0取消签名.ps1"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo 取消签名失败，详见上方输出。
pause
exit /b %RC%