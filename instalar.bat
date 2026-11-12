@echo off
chcp 65001 >nul
title ClipSphere - Instalador
echo.
echo  ===== ClipSphere: instalando herramientas =====
echo.
where winget >nul 2>&1 || (
  echo  [!] A esta PC le falta "winget" ^(Instalador de aplicacion de Microsoft^).
  echo      Sin el no se pueden instalar los programas.
  echo.
  echo      1. Se abrira la Microsoft Store en "Instalador de aplicacion".
  echo      2. Dale a Obtener o Actualizar.
  echo      3. Reinicia la PC y vuelve a abrir instalar.bat
  echo.
  start "" "ms-windows-store://pdp/?productid=9NBLGGH4NNS1"
  pause
  exit /b 1
)
where node >nul 2>&1 || (
  echo  - Instalando Node.js LTS...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
)
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
where yt-dlp >nul 2>&1 || (
  echo  - Instalando yt-dlp...
  winget install -e --id yt-dlp.yt-dlp --accept-source-agreements --accept-package-agreements
)
where ffmpeg >nul 2>&1 || (
  echo  - Instalando ffmpeg...
  winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements
)
where py >nul 2>&1 || where python >nul 2>&1 || (
  echo  - Instalando Python para Whisper...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
)
set "PATH=%LOCALAPPDATA%\Programs\Python\Launcher;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
echo  - Instalando Whisper (para videos sin subtitulos)...
py -3 -m pip install --upgrade whisper-ctranslate2 || python -m pip install --upgrade whisper-ctranslate2
echo  - Actualizando yt-dlp a la ultima version...
yt-dlp -U >nul 2>&1
echo.
set "FALTA="
where node >nul 2>&1 || if not exist "%ProgramFiles%\nodejs\node.exe" set "FALTA=%FALTA% Node.js"
where yt-dlp >nul 2>&1 || set "FALTA=%FALTA% yt-dlp"
where ffmpeg >nul 2>&1 || set "FALTA=%FALTA% ffmpeg"
if defined FALTA (
  echo  Casi listo. Reinicia la PC y abre iniciar.bat
  echo  Si ClipSphere dice que falta algo ^(%FALTA% ^), ejecuta instalar.bat otra vez.
) else (
  echo  Listo. Ahora abre iniciar.bat
)
echo.
pause
