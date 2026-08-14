@echo off
REM ZEX launcher: start the already-built binary directly (no rebuild).
REM Build separately with build.bat (or: npx tauri build --debug --no-bundle).
REM NOTE: keep this file ASCII-only. cmd.exe mis-parses UTF-8 Chinese in .bat files.
cd /d "%~dp0"
title ZEX Launcher

set "BIN=src-tauri\target\debug\zex.exe"

if not exist "%BIN%" (
    echo [ERROR] %BIN% not found.
    echo Build first: run build.bat
    pause
    exit /b 1
)

REM Close the running instance so the new one starts clean.
taskkill /F /IM zex.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul

echo [OK] Starting ZEX...
start "" "%BIN%"
exit /b 0
