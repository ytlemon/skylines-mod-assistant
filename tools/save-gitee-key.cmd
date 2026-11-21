@echo off
chcp 65001 >nul
title Save Gitee key to local credential store
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0save-gitee-key.ps1"
echo.
pause
