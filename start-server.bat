@echo off
cd /d "%~dp0"
set PATH=C:\Program Files\nodejs;%PATH%
echo ============================================
echo  avail 検証ランナーを起動します
echo  http://localhost:5178/
echo ============================================
node server.js
echo.
echo サーバーが終了しました。
pause
