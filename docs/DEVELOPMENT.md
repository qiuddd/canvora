# Canvora 开发与维护说明

## 当前可运行能力

- `npm install` 安装 workspace 依赖。
- `npm run dev` 同时启动后端 `127.0.0.1:8787` 和前端 `127.0.0.1:5173`。
- 后端提供健康检查、工作区目录初始化、素材格式识别、内容哈希去重和素材复制接口。
- 前端提供中文四区工作台、浅色/深色主题、提示词/图片/视频节点添加、节点拖动和基础连线。
- Windows 用户可双击 `启动.bat` 启动。

## 目录职责

- `frontend/src/api`：前端唯一后端请求边界。
- `frontend/src/stores`：画布状态；后续时间轴必须建立独立 store。
- `backend/src/workspace.ts`：工作区和素材文件操作。
- `backend/src/server.ts`：本地 HTTP API。
- `shared/types`：前后端共享类型。

## 开发检查

```bash
npm run typecheck
npm run build
npm test
```

后续扩展必须遵守 `AGENTS.md` 的许可证、路径、密钥和 ffmpeg 子进程约束。真实 AI API 不会内置密钥，必须在后续设置页面由用户自行配置。
