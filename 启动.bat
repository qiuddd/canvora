@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (echo 依赖安装失败 & pause & exit /b 1)
)
start "Canvora 后端" cmd /k "npm run dev:backend"
timeout /t 2 /nobreak >nul
start "Canvora 前端" cmd /k "npm run dev:frontend"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5173"
endlocal
