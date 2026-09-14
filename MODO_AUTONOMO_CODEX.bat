@echo off
setlocal
chcp 65001 >nul
title Ativar Modo Autônomo Codex - Oracle PC

echo.
echo ============================================================
echo   Ativando Modo Autônomo Total (Estilo Codex) na Oracle
echo ============================================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ativar-modo-autonomo-oracle.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
pause
exit /b %EXIT_CODE%
