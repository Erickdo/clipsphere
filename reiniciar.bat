@echo off
chcp 65001 >nul
title ClipSphere
cd /d "%~dp0"
echo Cerrando ClipSphere anterior...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 >nul
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%ProgramFiles%\nodejs;%PATH%"
echo Modelos de Ollama instalados: > ollama-modelos.txt
ollama list >> ollama-modelos.txt 2>&1
node --watch-path=lib --watch-path=server.js --watch-path=prompts server.js --open
pause
