# Canvora 开发与维护说明

## 界面与使用流程（2026-09-11 改版）

1. 启动后进入**项目入口页**：新建项目，或打开已有项目。
2. 进入项目后是一块**空白的无限画布**。
3. **在画布上点右键**打开节点菜单，所有节点都从这里添加（侧边栏已不再放节点按钮）。
4. 把桌面上的图片/视频**直接拖进画布**即完成导入：文件字节流式上传到后端 → 复制进项目目录 → 登记素材 → 自动建节点。
5. 右侧三个页签：**对话**（DeepSeek）、**素材**（素材库 + 批量处理 + 打组）、**任务**（本地任务队列）。
6. 画布内容和视口按项目保存，刷新后自动回到上次的项目。

## 目录职责

- `frontend/src/api`：前端唯一后端请求边界，所有接口都在这里。
- `frontend/src/canvas/`
  - `ports.ts`：节点端口模型（每个节点类型的输入/输出口），连线校验都读这里。
  - `CanvasNodeView.tsx`：节点渲染，只有标题栏能拖动节点。
  - `node-catalog.ts`：右键菜单的节点清单。
- `frontend/src/components/`：ProjectGate、AssetLibrary、ChatPanel、JobsPanel、CanvasContextMenu、TimelinePanel。
- `frontend/src/stores/`：画布状态与时间轴状态（zustand）。**两个 store 不许混在一起**。
- `backend/src/workspace.ts`：工作区、项目、素材、分组、画布快照。**所有写操作都走 `mutateWorkspace` 串行锁**。
- `backend/src/jobs.ts`：本地批量任务（抽帧 / 图片放大 / 视频放大 / 视频补帧 / 时间轴导出），全局串行。
- `backend/src/chat.ts`：DeepSeek 对话，密钥只在服务端读取。
- `backend/src/media/`：ffmpeg / ffprobe 参数构造与子进程封装（含 HTTP Range 解析，有单测）。
- `backend/src/filtergraph.ts`：变速与滤镜图编译器（有单测）。

## 数据存放

```
<工作区>/                      默认 F:/Canvora
├── canvora-state.json         项目、素材、分组、画布快照
├── jobs.json                  本地任务队列状态
├── secrets.json               AES-256-GCM 加密的密钥（已在 .gitignore）
├── bin/                       本地 AI 工具（需手动下载，见下）
└── projects/<项目ID>/
    ├── assets/                该项目的素材原片
    ├── proxy/ exports/ temp/  预览代理、导出、临时文件
```

## 重要实现约束

- **工作区状态是单文件 JSON**，并发读-改-写会互相覆盖（修过一次真实 bug：刚建的分组被任务写回旧状态冲掉）。
  因此任何修改工作区的代码都必须在 `mutateWorkspace(root, state => ...)` 里做，不要自己 `ensureWorkspace` + `saveState`。
- **素材哈希分块流式计算**，放大后的视频可能几百 MB，整块 `readFile` 会直接吃掉同样大的内存。
- 浏览器里的 `File` 对象**没有** `path` 属性（那是 Electron 专有），上传必须走字节流，不能读本地路径。
- 连线手势的监听在挂载时注册一次并用 ref 读取最新状态；放进 `useEffect([connecting])` 会让快速拖拽丢 pointerup。
- 尾帧导出用「ffprobe 取时长 D → `-ss (D-0.04)` 放在 `-i` 之后」，不要用 `-sseof -0.1`。

## 时间轴剪辑（2026-09-13 重写后）

- **EDL 是顺序 concat 模型**：导出成片 = 主视频轨（第一条视频轨）的片段依序相连，`startAt` 不参与导出，片段之间的空隙会被剪掉；贴图轨片段转换成与主轨片段时间重叠的 `overlays` 条目，时间窗必须换算到**成片输出时间**（空白被剪掉后时间轴时间和成片时间不一致）。
- **素材文件接口必须支持 HTTP Range**（`server.ts` 的 `/api/assets/:id/file`，206 分段传输）。没有 Range 时浏览器把视频当不可 seek 的流（`seekable=[[0,0]]`），预览拖进度条、暂停定位全部失效——v0.0.3 前的真实 bug。
- **预览是混合时钟**：播放时视频片段以 `<video>` 时钟推进播放头（帧级同步）；变速超出 0.25x~4x、图片片段、空隙用真实时间推进并周期纠偏。暂停时把视频 seek 到播放头。`<video>` 只换 src 不重挂载，元数据加载完再定位（`desiredSourceTimeRef`）。
- **图片输入必须 `-loop 1`**：主轨图片片段和贴图输入都按 `-loop 1 -framerate <fps> -t 时长` 传给 ffmpeg，否则整段只有 1 帧（音画错位、贴图淡入淡出全透明）。贴图循环时长以成片总长为上限，否则 overlay 跟随最长输入会在尾部多冻结帧。
- 片段拖动落点由 store 的 `placeWithoutOverlap` 统一钳制：目标位置落在占用区时就近落进能容纳它的空隙，任何操作都不会产生重叠片段。
- 快捷键归属：时间轴展开时**空格 = 播放/暂停、Delete = 删片段**（App 层让位）；时间轴收起时空格仍是画布平移。

## 本地 AI 工具（放大 / 补帧）

`bin/` 下需要 `realesrgan-ncnn-vulkan.exe`（BSD-3）和 `rife-ncnn-vulkan.exe`（MIT）。
本机实测无法从 GitHub release 直接下载（连接被重置），需要先用浏览器手动下载 zip，再离线安装：

```bash
node scripts/fetch-tools.mjs --only=realesrgan --from-file=D:/下载/realesrgan-ncnn-vulkan-20220424-windows.zip
node scripts/fetch-tools.mjs --only=rife --from-file=D:/下载/rife-ncnn-vulkan-20221029-windows.zip
```

没有装工具时，放大/补帧任务会立刻失败并给出中文提示，不会假装成功。界面底部状态栏实时显示工具是否就绪。

## 云端 AI Provider 扩展

云端生成入口统一在 `backend/src/generation.ts`。服务商配置写入工作区 `providers.json`，密钥通过 `secrets.ts` 的 AES-256-GCM 加密存储，适配器只调用 `readSecret`，不得把密钥返回前端或写日志。

目前协议入口包括：`openai-images`、`openai-compatible`、`dashscope-image`、`dashscope-video`、`zhipu-image`、`zhipu-video`、`minimax-video`。新增服务商时应补充 `ProviderPreset`、请求体映射、异步任务状态字段和结果 URL 提取，并为 `url`、`b64_json`、`base64` 三类图片返回做测试。生成结果必须下载到当前项目 `assets/` 后再登记，禁止公共图床中转。

### 服务商与密钥只在本机后台配置

前端**不出现**任何密钥，也不让用户填服务商 ID / 模型 ID：

- 前端只从 `GET /api/providers` 读出名称、协议、能力、模型展示名、启用状态，用 `frontend/src/canvas/generation-options.ts` 按能力筛出可选组合。
- 生成请求只发送 `providerId`、`model`、`params`、`prompt` 和项目内素材 id。
- 服务端在 `assertCapability()` 里再校验一次：服务商必须启用、模型必须存在、模型能力必须匹配 `image` / `video` 方向。前端绕不过这一层。
- `removeProvider()` 会连带删除该服务商的密钥记录，避免遗留孤儿密钥。

### 生成节点的输入与结果

- 上游连进来的图片素材以 `inputs: [{ assetId, kind, role }]` 提交；后端 `resolveInputUrls()` 校验素材属于当前项目、必须是图片，再读文件转成 data URL。
- 生图结果支持 `url` / `b64_json` / `base64` 三种返回；下载有 http(s) 校验和 2GB 上限。
- 视频是异步任务：写入 `tasks.json`（带 `nodeId`），后端每 5 秒轮询一次；前端轮询 `GET /api/tasks`，完成后把结果素材放回画布。
- 结果回画布由前端 `placeGenerationResults()` 负责：在生成节点下方创建结果节点并写入 `sourceNodeId`，同一个素材只放一次（用 `placedAssetsRef` 去重）。

### 本机后台管理页

`backend/src/status-page.ts` 渲染 `GET /` 的管理页面：概览 / 服务商 / 项目 / 素材 / 任务五个页签，用内联脚本调用已有 JSON 接口。页面只做展示和表单提交，业务逻辑一律在后端。密钥输入框是 password 类型，页面只显示尾四位和测试状态。



密钥只在后端读取，前端永远拿不到明文。保存路径：工作区 `secrets.json`（AES-256-GCM + 每工作区独立派生密钥）。
接口：`PUT /api/chat/key` 保存、`POST /api/chat/test` 测试、`POST /api/chat` 对话、`GET /api/chat/status` 查询状态。
模型默认 `deepseek-flash`。

## 开发检查

```bash
npm run typecheck                    # 三个 workspace 全部类型检查
npm run build                        # 前端构建
npm run build --workspace backend    # 后端编译到 dist
npm test                             # 全部 workspace；后端跑的是 dist 里的测试，改完后端要先 build
# 只跑后端源码测试（不依赖 dist）：
node --test --import tsx "backend/src/*.test.ts"
```
