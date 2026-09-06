@echo off
setlocal
chcp 65001 >nul
title Controle Remoto Antigravity - Oracle PC

echo.
echo ============================================================
echo   Status do Controle Remoto Antigravity na Oracle
echo ============================================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\gerenciar-controle-remoto-oracle.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
pause
exit /b %EXIT_CODE%
