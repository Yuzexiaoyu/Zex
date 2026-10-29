@echo off
rem ZEX certificate trust installer - double click, or right-click Run as administrator
rem The Chinese texts live in 安装签名.ps1 which requests elevation itself.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0安装签名.ps1"