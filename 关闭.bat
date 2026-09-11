@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Canvora 关闭
echo ============================================
echo.
echo 这会关掉本机正在运行的 Canvora 后端与前端。
echo 如果有放大/补帧任务在跑，会被中断。
echo.
choice /c YN /n /m "确定关闭吗？(Y/N) "
if errorlevel 2 (echo 已取消 & timeout /t 2 >nul & exit /b 0)

echo.
echo [1/3] 通知后端正常退出（会清理正在运行的任务状态）
curl -s -X POST http://127.0.0.1:8787/api/shutdown >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] 关闭占用 8787（后端）和 5173（前端）的进程
for %%P in (8787 5173) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr ":%%P" ^| findstr "LISTENING"') do (
    taskkill /F /T /PID %%A >nul 2>&1
    if not errorlevel 1 echo      已关闭端口 %%P 上的进程 %%A
  )
)

echo [3/3] 清理残留的 ffmpeg / realesrgan / rife 子进程
taskkill /F /IM ffmpeg.exe >nul 2>&1
taskkill /F /IM realesrgan-ncnn-vulkan.exe >nul 2>&1
taskkill /F /IM rife-ncnn-vulkan.exe >nul 2>&1
echo      已清理

echo.
echo 已关闭。重新启动请双击 启动.bat。
timeout /t 3 >nul
endlocal
