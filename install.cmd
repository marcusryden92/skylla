@echo off
rem skylla one-click setup: deps + PATH + shortcut. Safe to re-run.
cd /d "%~dp0"

where node >nul 2>nul || (echo ERROR: node is required ^(nodejs.org^) & pause & exit /b 1)

echo installing dependencies...
where pnpm >nul 2>nul && (call pnpm install) || (call npm install)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
echo done. Use "skylla" in a NEW terminal, or double-click Skylla.lnk
pause
