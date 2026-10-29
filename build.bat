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

REM Link the runtime components (mpv / RTSS / player skin / folder cover presets) next to
REM the debug exe. The dev-tree fallback is gone - resolve_mpv / resolve_rtss / resolve_skin /
REM resolve_folder_covers now only look beside the exe, exactly like the shipped portable
REM layout. Junctions cost nothing (no copy, no admin rights) and are rebuilt after a cargo clean.
for %%D in (mpv rtss skin folder-covers) do (
    if not exist "src-tauri\target\debug\%%D" (
        mklink /J "src-tauri\target\debug\%%D" "src-tauri\%%D" >nul 2>&1
    )
)

echo.
echo Build complete! Run start.bat to launch.
pause
exit /b 0

:failed
echo.
echo [FAILED] Build error - see the messages above.
pause
exit /b 1
