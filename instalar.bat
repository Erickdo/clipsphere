@echo off
chcp 65001 >nul
title ClipSphere - Instalador
echo.
echo  ===== ClipSphere: instalando herramientas =====
echo.
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
echo  Listo. Ahora abre iniciar.bat
echo.
pause
