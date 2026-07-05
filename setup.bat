@echo off
cd /d "%~dp0"
echo ============================================
echo  dp-reservation セットアップ
echo ============================================
echo.

where node >nul 2>nul
if not errorlevel 1 goto NODE_OK
set PATH=C:\Program Files\nodejs;%PATH%
where node >nul 2>nul
if errorlevel 1 goto NODE_MISSING

:NODE_OK
echo Node.js を検出しました:
node -v
echo.
goto INSTALL

:NODE_MISSING
echo.
echo [エラー] Node.js が見つかりませんでした。
echo https://nodejs.org から Node.js（LTS版）をインストールしてから再実行してください。
echo.
pause
exit /b 1

:INSTALL
echo 依存パッケージをインストールします（npm install）...
echo.
call npm install
if errorlevel 1 goto NPM_FAIL

echo.
echo Playwright用ブラウザ（Chromium）をインストールします...
echo.
call npx playwright install chromium
if errorlevel 1 goto PW_FAIL

echo.
echo ============================================
echo  セットアップ完了！
echo.
echo  動作確認コマンド:
echo    node reserve.js OSA MNL 2026/10/01 2026/10/10
echo.
echo  Web UIを使う場合:
echo    start-server.bat をダブルクリック
echo ============================================
echo.
pause
exit /b 0

:NPM_FAIL
echo.
echo [エラー] npm install に失敗しました。インターネット接続を確認して再実行してください。
echo.
pause
exit /b 1

:PW_FAIL
echo.
echo [エラー] playwright install に失敗しました。インターネット接続・空き容量を確認して再実行してください。
echo.
pause
exit /b 1
