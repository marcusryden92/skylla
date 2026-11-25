@echo off
rem skylla one-click setup: deps + PATH + shortcut. Safe to re-run.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo node not found - trying to install via winget...
  where winget >nul 2>nul || (echo ERROR: no winget either. Install node manually from nodejs.org & pause & exit /b 1)
  winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo node installed. Open a NEW terminal and run install.cmd again ^(PATH needs a fresh shell^).
  pause
  exit /b 0
)

echo installing dependencies...
where pnpm >nul 2>nul && (call pnpm install) || (call npm install)

where claude >nul 2>nul
if errorlevel 1 (
  echo installing Claude Code CLI...
  where pnpm >nul 2>nul && (call pnpm add -g @anthropic-ai/claude-code) || (call npm install -g @anthropic-ai/claude-code)
  echo NOTE: run "claude" once in a new terminal to log in before using skylla.
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"

echo.
echo done. Use "skylla" in a NEW terminal, or double-click Skylla.lnk
pause
