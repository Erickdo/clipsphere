@echo off
chcp 65001 >nul
title ClipSphere
cd /d "%~dp0"
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>&1 || (
  echo No encuentro Node.js. Ejecuta primero instalar.bat
  pause
  exit /b 1
)
node --watch-path=lib --watch-path=server.js --watch-path=prompts server.js --open
pause
