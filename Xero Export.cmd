@echo off
title Xero Export
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Tai ban LTS tai https://nodejs.org roi chay lai file nay.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\tsx" (
  echo Dang cai dat lan dau, vui long doi mot chut...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo Cai dat that bai. Chup man hinh nay gui nguoi ho tro.
    pause
    exit /b 1
  )
)

echo.
echo Dang khoi dong Xero Export... Trinh duyet se tu mo.
echo Dong cua so nay de tat ung dung.
echo.
call npm run viewer
pause
