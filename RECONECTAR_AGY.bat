@echo off
setlocal
chcp 65001 >nul
title Recuperar login Agy - NumIA Gemini Server

echo.
echo ============================================================
echo   Recuperar login Google do Agy na Oracle
echo ============================================================
echo.
echo Use este assistente quando a API informar GEMINI_AUTH_REQUIRED
echo ou quando a sessao Google do servidor deixar de funcionar.
echo.
echo Nenhuma chave do NumIA, arquivo, volume ou configuracao de
echo faturamento sera alterada.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\reconectar-agy.ps1"
set "NUMIA_EXIT=%ERRORLEVEL%"

echo.
if not "%NUMIA_EXIT%"=="0" (
  echo A recuperacao terminou com erro. Leia a mensagem acima.
) else (
  echo Recuperacao concluida.
)
echo.
pause
exit /b %NUMIA_EXIT%
