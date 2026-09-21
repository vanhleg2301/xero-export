@echo off
title Xero Export
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS build from https://nodejs.org and run this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\tsx" (
  echo First run: installing dependencies, this takes a moment...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo Install failed. Take a screenshot of this window and send it to whoever supports this tool.
    pause
    exit /b 1
  )
)

echo.
echo Starting Xero Export... your browser will open automatically.
echo Close this window to stop the app.
echo.
call npm run viewer
pause
