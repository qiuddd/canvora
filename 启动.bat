@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Canvora 启动
echo ============================================

if not exist node_modules (
  echo [1/4] 首次运行，正在安装依赖（可能需要几分钟）...
  call npm install
  if errorlevel 1 (echo 依赖安装失败，请检查网络后重试 & pause & exit /b 1)
) else (
  echo [1/4] 依赖已就绪
)

if not exist F:\Canvora\bin\realesrgan-ncnn-vulkan.exe (
  echo      提示：还没有安装放大工具 Real-ESRGAN，放大功能会失败。
  echo      运行 node scripts/fetch-tools.mjs --proxy=http://127.0.0.1:7897 可自动下载。
)

echo [2/4] 启动后端服务（127.0.0.1:8787）
start "Canvora 后端" cmd /k "cd /d %~dp0 && npm run dev:backend"

echo [3/4] 等待后端就绪...
set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
set /a tries+=1
curl -s -o nul http://127.0.0.1:8787/api/health
if errorlevel 1 (
  if %tries% lss 20 goto waitloop
  echo      后端启动超时，请看"Canvora 后端"窗口里的报错。
)

echo [4/4] 启动前端并把浏览器打开
start "Canvora 前端" cmd /k "cd /d %~dp0 && npm run dev:frontend"
timeout /t 4 /nobreak >nul
start "" "http://127.0.0.1:5173"

echo.
echo 已启动：
echo   前端界面  http://127.0.0.1:5173
echo   后端状态  http://127.0.0.1:8787   （可以在这里查看状态和关闭后端）
echo.
echo 关闭方式：双击 关闭.bat，或直接关掉那两个命令行窗口。
echo.
pause
endlocal
