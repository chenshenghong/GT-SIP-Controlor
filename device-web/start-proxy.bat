@echo off
chcp 65001 >nul
title GT-SIP-GW 測試代理
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 Node.js。
  echo 請先安裝 Node.js LTS 版：https://nodejs.org/
  echo 安裝完成後，重新雙擊本檔。
  echo.
  pause
  exit /b 1
)

set "IP=192.168.0.146"
set /p IP=請輸入設備 IP（直接按 Enter 使用 %IP%）:
set "PORT=8080"

echo.
echo ============================================================
echo  代理啟動中…
echo  瀏覽器開：http://localhost:%PORT%/
echo  登入頁「設備位址」留空，帳密 admin / 123456
echo  停止：按 Ctrl + C，或直接關閉這個視窗
echo ============================================================
echo.
node dev-proxy.mjs %IP% %PORT%

echo.
echo （代理已結束）
pause
