# Canvora 回归记录

日期：2026-09-11

## 已验证

- [x] `npm install` 成功，依赖审计无漏洞。
- [x] `npm run typecheck` 全 workspace 通过。
- [x] `npm run build` 前端构建通过。
- [x] 后端仅监听 `127.0.0.1:8787`，`GET /api/health` 返回 `ok: true`。
- [x] 工作区接口可以创建 `bin/models/luts/cache/thumbs/projects/logs` 目录。
- [x] 前端可以添加节点、拖动节点、生成基础 SVG 连线。

## 待后续阶段验证

- [ ] 使用桌面图片和视频进行真实导入、ffprobe、缩略图和 proxy 回归。
- [ ] 云端 AI 生成、首尾帧和任务恢复（等待用户配置自己的 API）。
- [ ] Real-ESRGAN/RIFE 二进制处理（需要下载工具并验证本机驱动）。
- [ ] 时间轴、变速、贴图、调色和 ffmpeg 导出。
