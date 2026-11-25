@echo off
rem %~dp0 = this script's directory, so the repo works wherever it's cloned
node "%~dp0src\index.js" %*
