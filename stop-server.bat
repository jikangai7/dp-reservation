@echo off
echo ポート5178を使っているプロセスを探しています...
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :5178 ^| findstr LISTENING') do (
  echo プロセスID %%p を終了します...
  taskkill /PID %%p /F
  set FOUND=1
)
if "%FOUND%"=="0" (
  echo ポート5178で動いているプロセスは見つかりませんでした。
)
pause
