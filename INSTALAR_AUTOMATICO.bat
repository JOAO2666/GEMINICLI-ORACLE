@echo off
setlocal
chcp 65001 >nul
title Instalador NumIA Gemini Server

echo.
echo ============================================================
echo   Instalador automatico - NumIA Gemini Server na Oracle
echo ============================================================
echo.
echo Este assistente NAO cria recursos e NAO altera o faturamento
echo da Oracle. Use somente uma VM que esteja marcada como Always Free.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\instalar-oracle.ps1"
set "NUMIA_EXIT=%ERRORLEVEL%"

echo.
if not "%NUMIA_EXIT%"=="0" (
  echo A instalacao terminou com erro. Leia a mensagem acima.
) else (
  echo Instalacao concluida.
)
echo.
pause
exit /b %NUMIA_EXIT%
