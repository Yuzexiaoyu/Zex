@echo off
REM ZEX build: compile frontend (dist) + Rust backend + bundle resources
REM into target\debug. Run once after code changes, then start.bat just launches.
REM NOTE: keep this file ASCII-only. cmd.exe mis-parses UTF-8 Chinese in .bat files.
cd /d "%~dp0"
title ZEX Build

echo ==========================================
echo   ZEX - build latest code (debug)
echo ==========================================
echo.

REM Close the running app first, otherwise the exe is locked and the build fails.
taskkill /F /IM zex.exe >nul 2>&1
ping -n 2 127.0.0.1 >nul

echo Building frontend + app, please wait...
echo.
call npx tauri build --debug --no-bundle
if errorlevel 1 goto :failed

echo.
echo Build complete! Run start.bat to launch.
pause
exit /b 0

:failed
echo.
echo [FAILED] Build error - see the messages above.
pause
exit /b 1
