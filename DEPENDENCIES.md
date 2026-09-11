# Canvora 依赖与许可证登记

> **规则**：每新增一个第三方依赖，都要**打开它的 LICENSE 文件实际阅读**（不要相信 README 里写的 "open source"），然后登记到本表。
>
> 阶段 0 已安装依赖版本以根目录 `package-lock.json` 为准；本阶段未引入黑名单依赖。
> 只允许 MIT / Apache-2.0 / BSD 系列。GitHub 侧栏显示 `NOASSERTION` / `Other` / 没有许可证的，必须人肉读 LICENSE 文件，读不懂就在交付说明里标出来问用户。
>
> 更新日期：2026-09-11
> 当前状态：**尚未开始编码，下表是规划中的依赖，实际安装后需核对版本号。**

---

## 1. 运行时要引入的依赖

### 1.1 前端

| 包名 | 版本 | 许可证 | 用途 | 状态 |
|---|---|---|---|---|
| `react` | 19.x | MIT | UI 框架 | 待安装 |
| `react-dom` | 19.x | MIT | 渲染 | 待安装 |
| `vite` | 7.x | MIT | 构建工具 | 待安装 |
| `typescript` | 5.x | Apache-2.0 | 类型系统 | 待安装 |
| `zustand` | 5.x | MIT | 状态管理 | 待安装 |
| `tailwindcss` | 4.x | MIT | 样式 | 待安装 |
| `shadcn/ui` | 最新 | MIT | UI 组件（基于 Radix + Tailwind） | 待安装 |
| `konva` | 最新 | MIT | **仅用于时间轴绘制** | 待安装（阶段 6） |
| `react-router` | 7.x | MIT | 路由 | 待安装 |
| `nanoid` | 5.x | MIT | ID 生成 | 待安装 |

**明确不安装**：`tldraw`（自定义许可，生产需付费）、`@xyflow/react`（不必要，画布自研）、任何画布库（Konva 除外，且仅限时间轴）。

### 1.2 后端

| 包名 | 版本 | 许可证 | 用途 | 状态 |
|---|---|---|---|---|
| `fastify` | 最新 | MIT | HTTP 服务 | 待安装 |
| `better-sqlite3` | 最新 | MIT | SQLite 驱动（native，注意预编译产物） | 待安装 |
| `zod` | 最新 | MIT | 参数校验 | 待安装 |

> ⚠️ `better-sqlite3` 是 native 模块，Windows 上可能需要 MSVC 构建工具。安装后**必须实测** `npm install` 能成功；若失败，改用 `node:sqlite`（Node 22 内置，实验性）或纯 JS 的 `sql.js`，并在本表登记实际情况。

### 1.3 本地 AI 二进制（不由 npm 安装，用 `scripts/fetch-tools.mjs` 下载到工作区 `bin/`）

| 工具 | 来源 | 许可证 | 用途 | 状态 |
|---|---|---|---|---|
| `ffmpeg` / `ffprobe` | 用户已装（gyan.dev essentials 7.1） | LGPL/GPL（取决于构建） | 所有媒体处理 | ✅ 已装 |
| `realesrgan-ncnn-vulkan` | Real-ESRGAN 官方 release `v0.2.5.0`，资产 `realesrgan-ncnn-vulkan-20220424-windows.zip`：`https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip` | **BSD-3-Clause** | 图片/视频逐帧放大 | 下载脚本已就绪（`scripts/fetch-tools.mjs`）。**本机实测下载失败（ECONNRESET），需要手动下载 zip 后用 `--from-file=` 安装** |
| `rife-ncnn-vulkan` | nihui/rife-ncnn-vulkan release `20221029`，资产 `rife-ncnn-vulkan-20221029-windows.zip`（内含 `rife-v4.6` 等 11 个模型目录）：`https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip` | **MIT** | 补帧 | 同上 |
| `realcugan-ncnn-vulkan` | nihui/realcugan-ncnn-vulkan release | **MIT** | 动画向放大（可选，先实测效果再决定是否加入） | 暂缓 |

**解压方式（2026-09-11 记录）**：`scripts/fetch-tools.mjs` **没有引入任何 npm 依赖**。zip 解压用 Windows 自带的 PowerShell `Expand-Archive`（脚本通过 `-EncodedCommand` 传入，路径含空格或中文也不会被拆分，不经过 shell 解析），失败时退回系统自带的 `C:/Windows/System32/tar.exe`（bsdtar，能读 zip）。两者都是操作系统自带组件，不涉及第三方许可证，因此无需登记新的依赖行。

---

## 2. 明确禁止使用的依赖（黑名单）

这些项目在调研中被考虑过，**因许可证问题禁止使用**。不要因为"功能更全"就把它们加回来。

| 项目 | 许可证 | 禁止原因 |
|---|---|---|
| [tldraw](https://github.com/tldraw/tldraw) | 自定义 tldraw license | v4 起生产环境必须购买 license key；免费档强制 "made with tldraw" 水印且禁止商用。技术上最契合，但和"不花钱"直接冲突 |
| [Video2X](https://github.com/k4yt3x/video2x) | **AGPL-3.0** | 传染性强，分发应用会要求开源整个 Canvora。改用 Real-ESRGAN + RIFE 自己串流水线，功能等价 |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) | GPL-3.0 | 作为代码依赖会传染。仅当用户自行安装作为外部服务时另议 |
| [ncounterspecialist/twick](https://github.com/ncounterspecialist/twick) | Sustainable Use License v1.0 | 源码可见但非开源（n8n 式许可），商用与再分发受限。GitHub 标 `NOASSERTION` |
| [openvideodev/react-video-editor](https://github.com/openvideodev/react-video-editor) | 自定义 OpenVideo License | 个人/小微组织免费，超出需付费企业许可。GitHub 标 `NOASSERTION` |
| [hero8152/Infinite-Canvas](https://github.com/hero8152/Infinite-Canvas) | 自定义（禁止商用；二次开发须开源并署名） | 用户参考的那篇酷安/博客帖子对应的项目。法律上不可作为代码起点，且作者已宣布停更（2026-08-28）。**只借鉴思路，不复制代码** |
| MotzifyStudio/Motz-Whiteboard | **无 LICENSE 文件** | 无许可证 = 默认保留全部权利，法律上完全不可用 |
| [spacedeck/spacedeck-open](https://github.com/spacedeck/spacedeck-open) | AGPL-3.0 | 且已停止维护约 3 年 |
| `waifu2x-caffe` | MIT | 许可证没问题，但自 2020 年后停更，CUDA 11/cuDNN 8 时代的产物，在新驱动上兼容性风险不值得承担。用 `waifu2x-ncnn-vulkan` 替代 |

---

## 3. 只参考设计、不作为代码依赖的项目

这些项目许可证干净，但基于架构考虑不作为依赖引入。**可以读源码借鉴设计思路，不要复制代码。**

| 项目 | 许可证 | 借鉴什么 |
|---|---|---|
| [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) | **MIT**（已交叉核实：LICENSE 文件 main 与 master 分支、GitHub 侧栏、README 三处一致） | **主要参考**：DOM 节点 + SVG 连线的画布实现、节点类型清单、连线数据模型、拓扑序执行引擎思路、生成配置 UI、视频节点右键抽帧交互 |
| [omni-media/omniclip](https://github.com/omni-media/omniclip) | MIT | **推荐参考**：clip/effect 数据模型、时间轴交互、导出流程 |
| [schahriar/mfx](https://github.com/schahriar/mfx) | MIT | 编解码层实现 |
| [AmitDigga/fabric-video-editor](https://github.com/AmitDigga/fabric-video-editor) | MIT | 时间轴 UI（注意它基于 fabric.js，混用有两套 canvas 上下文的风险） |
| [UnderHear/EaseCut](https://github.com/UnderHear/EaseCut)（npm `easecut-react`） | MIT | 备选时间轴组件，有中文文档，但 star 数少 |
| [elahlabs/elah](https://github.com/elahlabs/elah) | Apache-2.0 | 备选时间轴组件（分层包设计值得参考） |
| [mifi/editly](https://github.com/mifi/editly) | MIT | 声明式视频合成 spec 的设计 |
| [AcademySoftwareFoundation/OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | Apache-2.0 | 时间轴数据模型（影视工业标准，ASWF 托管） |
| [bloc97/Anime4K](https://github.com/bloc97/Anime4K) | MIT | GLSL shader 放大（需 libplacebo，本期不做，列为 P2 可选） |

---

## 4. 许可证核查记录

> 记录重要的核查动作，避免重复劳动、也便于追溯。

| 日期 | 对象 | 核查方式 | 结论 |
|---|---|---|---|
| 2026-09-11 | `basketikun/infinite-canvas` | 直接抓取 `raw.githubusercontent.com/.../main/LICENSE` 与 `.../master/LICENSE`，并抓取 GitHub 仓库页面侧栏 | **MIT License**，版权行 `Copyright (c) 2026 basketikun`。三处来源一致。**可自由修改、可闭源、可商用** |
| 2026-09-11 | `hero8152/Infinite-Canvas` | 直接抓取 LICENSE 文件 | 自定义许可：允许个人及公司自用；**禁止商业用途**；**不得改造成商业产品**；基于该代码的二次开发**必须继续开源并标明原作者**。结论：**不可作为代码起点** |
| 2026-09-11 | `Video2X` | GitHub API `license.spdx_id` | `AGPL-3.0`。**禁止作为分发的 sidecar** |
| 2026-09-11 | `twick` | 阅读 LICENSE.md 全文 | Sustainable Use License v1.0，`Copyright (c) 2025 Kiffer. All rights reserved.`。**非开源，禁用** |
| 2026-09-11 | `openvideodev/react-video-editor` | 阅读 LICENSE 全文 | 自定义 OpenVideo License，含免费档与付费企业档。**禁用** |

**⚠️ 特别提醒**：调研过程中发现，网络上（包括搜索引擎摘要和部分技术文章）存在把这两个同名项目搞混的错误信息，例如声称 `hero8152/Infinite-Canvas` 是 MIT 许可，或声称 `basketikun/infinite-canvas` 是 AGPL-3.0。**以本表记录的、直接读取 LICENSE 文件的结论为准。**

---

## 5. 维护要求

- [ ] 每新增依赖时更新本表
- [ ] 每次 `npm install` 后核对实际安装的版本号，更新「版本」列
- [ ] 每个阶段验收时，通读本表确认没有遗漏或违规项
- [ ] 发现新依赖的 GitHub 侧栏显示 `NOASSERTION` / `Other` / 无许可证时，**必须人肉读 LICENSE 文件**并在本表留下核查记录

---

## 6. 本地 AI 二进制（2026-09-11 实际安装并实测）

| 工具 | 版本 / 资产 | 安装位置 | 许可证 | 实测结果 |
|---|---|---|---|---|
| `realesrgan-ncnn-vulkan` | Real-ESRGAN v0.2.5.0，资产 `realesrgan-ncnn-vulkan-20220424-windows.zip`（43.4 MB） | `F:/Canvora/bin/realesrgan-ncnn-vulkan.exe` | **BSD-3-Clause** | 754×882 图放大 4 倍 → 3016×3528 ✅ |
| `rife-ncnn-vulkan` | nihui/rife-ncnn-vulkan release `20221029`，资产 `rife-ncnn-vulkan-20221029-windows.zip`（431 MB，含多版本模型） | `F:/Canvora/bin/rife-ncnn-vulkan.exe`（模型 `rife-v4.6` 等） | **MIT** | 26.215s/30fps → 26.2s/60fps/1572 帧 ✅ |

获取方式：`node scripts/fetch-tools.mjs --proxy=http://127.0.0.1:7897`（脚本内用 `curl --proxy`，默认代理即 7897）。
两个二进制都不提交到 git，只用脚本获取。
