@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap-windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Nao foi possivel iniciar. Confira a mensagem acima e tente novamente.
  if not defined CI pause
  exit /b 1
)
