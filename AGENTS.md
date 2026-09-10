# Canvora 项目约定（AGENTS.md）

> 本文件是本项目的**硬性约定**，与 `PRD.md`（产品需求）和 `TASKS.md`（任务清单）配套使用。
> **每次在本目录开工前先读本文件。** 本文件里的约束优先级高于 PRD 里的实现建议；本文件与 PRD 冲突时以本文件为准，并在交付说明里指出冲突。
>
> 用户级默认约定在 `C:\Users\qiu\.zcode\AGENTS.md`，项目约定在冲突时以本文件为准。

---

## 1. 这个项目是什么

**Canvora** —— 一个跑在用户自己 Windows 笔记本上的**无限画布 + AI 创作 + 视频剪辑**工作台。

- 无限画布：把图片/视频素材摊在可无限拖拽缩放的平面上，节点之间可连线串成 AI 生成流程。
- AI 生成：在画布上直接调用云端 AI 接口生成图片/视频（含首尾帧），结果直接落到画布。
- 本地 AI：用本机 RTX 4060 做图片/视频放大（Real-ESRGAN）和补帧（RIFE）。
- 基础剪辑：多段素材串成一条片子，支持分割、变速、贴图、调色，导出成片与首尾帧。
- **数据全部在本地**，不经过任何第三方服务器（除了用户自己配置的 AI 接口）。

**目标用户只有项目所有者一个人**：非程序员，不写代码。所有界面文案和错误提示用中文。

---

## 2. 技术栈（已定，不要换）

| 层 | 选型 |
|---|---|
| 前端 | React 19 + TypeScript + Vite 7 + zustand + Tailwind CSS 4 + shadcn/ui |
| 画布 | **自研**：绝对定位 DOM 节点 + 单层 SVG 画连线 + 一个祖先容器统一 `transform` |
| 时间轴 | **Konva**（这是 Konva 在本项目的唯一用途） |
| 后端 | Node.js 22 + TypeScript + Fastify |
| 数据库 | SQLite（建议 `better-sqlite3`） |
| 共享类型 | `shared/` 目录，前后端共同引用 |
| 媒体处理 | ffmpeg / ffprobe（子进程调用） |
| 本地 AI | `realesrgan-ncnn-vulkan`（BSD-3）、`rife-ncnn-vulkan`（MIT）（子进程调用） |
| 交付形态 | **本地网页应用**：启动脚本拉起服务，浏览器访问 `127.0.0.1:端口` |

**不引入**：Python、PyTorch、Docker、Rust、tldraw、@xyflow/react、任何画布库（时间轴除外）。

---

## 3. 常用命令（工程建好后填实际值）

```bash
# 安装依赖（根目录执行即可，各子包用 workspace）
npm install

# 开发：同时启动后端与前端
npm run dev

# 只启动后端（默认 127.0.0.1:8787）
npm run dev:backend

# 只启动前端（Vite 默认 5173，配置了代理指向后端）
npm run dev:frontend

# 类型检查（提交前必须全绿）
npm run typecheck

# 单元测试（提交前必须全绿）
npm test

# 构建前端产物
npm run build

# 下载本地 AI 二进制到工作区 bin/
node scripts/fetch-tools.mjs

# 用户日常启动（双击即可）
启动.bat
```

> 如果实际端口或命令与上面不一致，**以真实值为准并回来更新本文件**。

---

## 4. 硬性约束（红线，违反即返工）

### 4.1 许可证红线

**只允许 MIT / Apache-2.0 / BSD 系列许可证的依赖。**

禁止使用（理由见 PRD 6.4）：

| 项目 | 许可证问题 |
|---|---|
| `tldraw` | 自定义许可，生产环境需付费 license key，免费档强制水印且禁商用 |
| `Video2X` | **AGPL-3.0**，传染性强，分发会要求开源整个 Canvora |
| `ComfyUI` | GPL-3.0（作为代码依赖） |
| `ncounterspecialist/twick` | Sustainable Use License（非开源） |
| `openvideodev/react-video-editor` | 自定义商业许可 |
| `hero8152/Infinite-Canvas` | 自定义许可：禁止商用、二次开发须开源署名 |
| MotzifyStudio/Motz-Whiteboard | **无 LICENSE 文件** = 默认保留全部权利，法律上不可用 |

**执行要求：**
1. 每新增一个依赖，**打开它的 `LICENSE` 文件实际阅读**，不要相信 README 里写的"open source"。
2. 登记到 `DEPENDENCIES.md`：包名 | 版本 | 许可证全称 | 用途。
3. GitHub 侧栏显示 `NOASSERTION` / `Other` / 没有许可证 → **必须人肉读 LICENSE 文件**；读不懂就在交付说明里标出来问用户，不要自作主张。

### 4.2 架构红线

- **前端不许出现裸 `fetch`。** 所有后端调用必须经过 `frontend/src/api/`。加 ESLint 规则禁止，只允许从该目录导出。这条是为了将来能低成本套 Tauri 外壳。
- **后端只监听 `127.0.0.1`**，不要监听 `0.0.0.0`。
- **时间轴状态与画布状态必须是两个独立的 store**，不许混在一起。
- **节点组件必须 `React.memo`，且通过 id 精确订阅自己的数据**，不许订阅整个节点数组。
- **画布的所有节点放在一个祖先容器里，统一用一个 CSS `transform`**，不许给每个节点单独做位置变换随缩放重算。

### 4.3 性能红线（用户机器只有 16GB 内存）

- **本地 AI 任务严格串行，同时只允许 1 个。** 混合场景下本地任务要等云端任务结束再开始。
- **视频处理必须分块流式，不许整片载入内存。**
- **画布上同一时刻只允许一个视频节点在播放**，其余用静态缩略图（LOD）；离屏视频必须 pause。
- **不许把 `<video>` 画进 `<canvas>`**。视频一律用 DOM 元素浮在画布上层。
- **不许前端一次性缓存大文件内容**，媒体一律交给浏览器/播放器自己流式读取。

### 4.4 磁盘红线

- **所有大文件目录必须来自用户设置的工作区路径，不许硬编码 `C:` 盘。** 用户 C 盘只剩 66GB。
- **4K 抽帧的中间帧必须用 JPEG（`-q:v 2`）而非 PNG**，且分块处理后立即删除。
- **任何会产生大量中间文件的任务，开始前必须估算空间并检查**，不足则拒绝执行并说明还差多少 GB。

### 4.5 安全红线

- **密钥不许出现在任何会被提交到 git 的文件里。** `secrets.json` 必须在 `.gitignore` 中。
- **写日志前必须经过密钥脱敏函数。** 日志里搜不到任何密钥片段。
- **前端永远不直接持有密钥。** 所有调用 AI 接口的请求从后端发出，前端只发送 provider 标识。
- **绝对不允许私自把用户的图片/视频上传到任何公共图床或第三方存储。** 接口要求公网 URL 时，提示用户自己配置图床。
- **不实现自动更新。** 从远端拉代码覆盖自己是必须避免的行为。

### 4.6 子进程调用红线

- **一律用参数数组 spawn，绝不拼 shell 字符串，绝不走 `cmd /c`。**
- **ffmpeg 的滤镜图一律写入临时文件，用 `-filter_complex_script` 传**，不从命令行拼。多片段时滤镜文本会超过 8KB，且能避开 Windows 转义地狱。
- **取消任务时必须杀整个进程树**（Windows 用 `taskkill /F /T /PID`）。只 kill 直接子进程会留下残余进程继续吃 CPU/显存。
- **Windows 上路径含空格或中文是常态。** 素材存进 `assets/` 时重命名为 `<assetId>.<ext>`，原始文件名存数据库。
- **ffmpeg 滤镜里的 LUT 路径必须用正斜杠**（`file=C:/Canvora/luts/x.cube`）。反斜杠是 ffmpeg 滤镜语法里的转义字符，会导致**静默失败**。
- **`between(t\,3\,8)` 里的逗号必须转义为 `\,`**，走 `-filter_complex_script` 也一样要转义。

### 4.7 不要在脚本里用 `wmic`

Windows 11 Build 26200 已移除 WMIC。取系统信息用 PowerShell `Get-CimInstance` 或 Node 的 `fs.statfs`。

---

## 5. 编码约定

- **全 TypeScript，不用 `.js`。** `any` 要写理由注释。
- **所有面向用户的文字用简体中文。** 错误提示必须是人能看懂的，不许把英文异常堆栈直接甩给用户。错误对象统一带 `message`（中文，给用户）和 `detail`（技术细节，折叠显示）两个字段。
- **界面术语统一**：画布 / 节点 / 连线 / 素材 / 项目 / 工作区 / 序列 / 轨道 / 片段 / 入点 / 出点 / 变速 / 代理文件 / 生成任务。不要用同义词混着叫（对照 PRD 第 4 节术语表）。
- **代码注释只写"代码本身表达不了的约束"**，不要写"这行在做什么"或"我为什么这么改"。例如可以写 `// 必须先插帧再拉长，反过来会插出重复帧`，不要写 `// 设置 speed`。
- **命名**：变量和函数英文，界面文案中文。文件用 kebab-case，组件用 PascalCase。
- **不使用默认导出**（除 React 组件），统一用具名导出，便于重构和类型推导。

---

## 6. 必须写单元测试的地方

不是为了覆盖率，而是这些地方**错了只能靠"导出的视频不对"来发现**，成本极高：

1. **`buildAtempoChain(speed)`** —— 覆盖 0.1、0.2、0.25、0.5、0.75、1、1.5、2、3、4、5、10、15、20。断言因子乘积等于 speed（误差 < 1e-6），且每个因子都在 [0.5, 2.0]。
2. **滤镜图编译器** —— 给定构造好的 EDL，断言生成的滤镜图字符串包含：正确的片段数量、正确的 `setpts` 系数、正确的 `atempo` 链、正确的 `between` 时间窗与转义。
3. **环检测**（节点图拓扑排序）—— 覆盖无环、自环、多节点环。
4. **空间估算函数**（视频放大/抽帧前）—— 覆盖边界值。

其他模块以手动验收为主，按 `TASKS.md` 各任务的「判据」执行。

---

## 7. 协作规则

- **一次只推进一个任务。** 按 `TASKS.md` 顺序做，做完并自测通过再勾选，不要跳着做。
- **每个独立需求完成后创建一个中文 git 提交。** 提交信息说清"改了什么、为什么改"。
- **发布可用版本时打 tag**（如 `v0.1.0-P0`）。
- **发现 PRD 有遗漏或矛盾**：选择开发量更小的那一版实现，用 `// TODO(PRD-MISSING):` 标注，并在交付说明里列出。**不要默默自行发明复杂功能。**
- **不要添加 PRD 第 3 节（明确不做的事）里列出的任何功能**，也不要为它们预留复杂抽象。
- **验证不通过不得声称完成。** 汇报时必须说清哪些验收项通过了、哪些没测。
- **技术取舍自行决定并简要说明理由**，不要抛给用户选择。只有涉及"产品功能怎么设计""要花钱开哪个服务"这类问题才问用户。

---

## 8. 项目结构

```
Canvora/
├── PRD.md                产品需求文档（核心交付物）
├── TASKS.md              分期任务清单
├── AGENTS.md             本文件
├── README.md             给用户看的使用说明
├── DEPENDENCIES.md       依赖与许可证登记（持续维护）
├── .gitignore
├── package.json          workspace 根
├── 启动.bat              用户日常启动入口
├── frontend/             Vite + React 19 + TS
│   └── src/
│       ├── api/          ⚠️ 唯一的前后端边界，不许在别处 fetch
│       ├── canvas/       无限画布
│       ├── timeline/     时间轴与剪辑（Konva）
│       ├── panels/       素材库/任务中心/provider 配置
│       └── stores/       zustand（画布与时间轴分开）
├── backend/              Node 22 + Fastify + TS
│   └── src/
│       ├── routes/       HTTP 接口
│       ├── db/           SQLite 与迁移
│       ├── media/        ffmpeg/probe 封装
│       ├── filtergraph/  ⚠️ 滤镜图编译器（最需要测试）
│       ├── localai/      本地 AI 任务串行队列
│       ├── providers/    ⚠️ AI 服务商适配器，一家一个文件
│       ├── tasks/        任务队列与轮询调度器
│       └── secrets/      密钥加密与脱敏
├── shared/               前后端共用类型与常量
└── scripts/              fetch-tools.mjs 等
```

**工作区（不在仓库里，在用户选的盘上，例如 `F:/Canvora`）：**

```
<工作区>/
├── canvora.db            SQLite
├── secrets.json          加密密钥（.gitignore）
├── logs/                 按天切分，保留 7 天
├── bin/                  ffmpeg / realesrgan / rife
├── models/               AI 模型权重
├── luts/                 .cube 调色文件
├── cache/thumbs/         全局缩略图缓存
└── projects/<projectId>/{assets,proxy,exports,temp}
```

---

## 9. 关键参考

- **画布实现参考**：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)（MIT，6.3k star）—— 只借鉴设计（DOM 节点 + SVG 连线、节点类型、连线模型、执行引擎思路），**不复制代码、不 fork**。
- **时间轴与剪辑参考**：[omni-media/omniclip](https://github.com/omni-media/omniclip)（MIT）—— clip/effect 数据模型、时间轴交互。
- **时间轴数据模型参考**：[OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO)（Apache-2.0）。
- **AI 接口速查表**：PRD 第 14.3 节。
- **ffmpeg 命令集**：PRD 第 14.1 节（含变速、贴图、调色、放大、补帧的现成命令）。

---

## 10. 本文件与 PRD 冲突时怎么办

**以本文件为准**（本文件是踩过坑后定下的约束，PRD 是需求描述）。但必须在交付说明里明确指出冲突点，让用户知道两份文档哪里不一致，以便后续修正 PRD。

---

## 11. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-09-11 | 首版 |
