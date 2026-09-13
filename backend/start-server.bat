@echo off
title PineVision Backend - KEEP THIS WINDOW OPEN
cd /d "%~dp0"
echo Starting PineVision backend...
echo Open http://localhost:5000/ in Chrome once you see "Running on".
echo Close this window (or press Ctrl+C) to stop the server.
echo.
".venv\Scripts\python.exe" app.py
echo.
echo Server stopped. Press any key to close.
pause >nul
