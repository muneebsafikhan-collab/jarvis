@echo off
cd /d "%~dp0"
title JARVIS
echo Starting JARVIS...
start "" cmd /c "timeout /t 2 /nobreak >nul & (start msedge --app=http://127.0.0.1:8765 || start chrome --app=http://127.0.0.1:8765 || start http://127.0.0.1:8765)"
set PY=python
where python >nul 2>nul || set PY=py
:run
%PY% server.py --no-browser
if %errorlevel%==3 goto run
echo.
echo JARVIS stopped. If you see an error above, send a photo of it.
pause
