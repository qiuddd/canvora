@echo off
chcp 936 >nul
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo ============================================
echo   Canvora 启动
echo ============================================
echo.

where npm >nul 2>&1
if errorlevel 1 (
  echo 找不到 npm 命令。请先安装 Node.js 22，装好后重新双击本脚本。
  echo 下载地址：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/4] 首次运行，正在安装依赖，可能需要几分钟...
  call npm install
  if errorlevel 1 (
    echo.
    echo 依赖安装失败，请检查网络后重试。
    echo 如果网络受限，可以先启动代理再运行本脚本。
    echo.
    pause
    exit /b 1
  )
) else (
  echo [1/4] 依赖已就绪
)

if not exist "F:\Canvora\bin\realesrgan-ncnn-vulkan.exe" (
  echo      提示：还没有安装放大工具 Real-ESRGAN，放大功能会失败。
  echo      可运行 node scripts\fetch-tools.mjs --proxy=http://127.0.0.1:7897 自动下载。
)

echo [2/4] 启动后端服务 127.0.0.1:8787
start "Canvora 后端" /D "%ROOT%" cmd /k "npm run dev:backend"

echo [3/4] 等待后端就绪...
set /a tries=0
:waitloop
ping -n 2 127.0.0.1 >nul
set /a tries+=1
node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>&1
if errorlevel 1 (
  if %tries% lss 25 goto waitloop
  echo.
  echo      后端启动超时。请查看 "Canvora 后端" 窗口里的报错。
  echo      常见原因：端口 8787 被占用，或者依赖没有装好。
  echo.
)

echo [4/4] 启动前端并打开浏览器
start "Canvora 前端" /D "%ROOT%" cmd /k "npm run dev:frontend"
ping -n 6 127.0.0.1 >nul
start "" "http://127.0.0.1:5173"

echo.
echo 已启动：
echo   前端界面  http://127.0.0.1:5173
echo   后端管理  http://127.0.0.1:8787    ^(在这里配置 AI 服务商和密钥^)
echo.
echo 关闭方式：双击 关闭.bat，或者直接关掉那两个命令行窗口。
echo.
pause
endlocal
