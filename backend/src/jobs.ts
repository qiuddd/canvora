import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, statfs } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { basename, dirname, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Asset, Edl, EdlClip, ExportSettings, Job, JobKind, JobStatus, ToolStatus, WorkspaceState } from '@canvora/shared';
import {
  assetAbsolutePath,
  assetById,
  ensureProjectDirectories,
  ensureWorkspace,
  projectDirectory,
  registerGeneratedAsset,
} from './workspace.js';
import { compileEdl, totalTimelineDuration } from './filtergraph.js';
import { buildFfprobeArgs } from './media/media.js';
import { killProcessTree } from './media/process.js';

/**
 * 本地批量任务队列。
 *
 * 硬约束（见 AGENTS.md 4.3 性能红线）：
 * - 同一工作区同一时刻只跑 1 个本地任务（放大 / 补帧 / 抽帧），其余排队。机器只有 16GB 内存，
 *   两个 realesrgan 并行会直接吃满显存和内存。
 * - 视频任务必须分块流式：每批抽帧 → 处理 → 合回视频段 → 立刻删掉该批中间帧，整片不进内存。
 * - 所有子进程都用参数数组 spawn，绝不拼 shell 字符串、绝不走 cmd /c。
 */

// ── 常量与默认值 ──────────────────────────────────────
/** 单帧 JPEG 的估算体积（PRD E2 第 2 步）。 */
export const FRAME_BYTES_ESTIMATE = 350 * 1024;
/** 每批抽帧数量（PRD E2 第 3 步）。 */
export const DEFAULT_BATCH_FRAMES = 200;
export const DEFAULT_UPSCALE_MODEL = 'realesrgan-x4plus';
export const DEFAULT_UPSCALE_SCALE = 4;
export const DEFAULT_TILE = 128;
export const DEFAULT_RIFE_MODEL = 'rife-v4.6';
export const DEFAULT_INTERPOLATE_MULTIPLIER = 2;
/** 源视频帧率超过这个值就没必要补帧（PRD E3 异常与边界）。 */
export const UNNECESSARY_INTERPOLATE_FPS = 60;

const REALESRGAN_EXE = 'realesrgan-ncnn-vulkan';
const RIFE_EXE = 'rife-ncnn-vulkan';

// ── 错误类型 ──────────────────────────────────────────
/** 面向用户的错误：message 是中文给人看的，detail 是技术细节折叠显示。 */
export class JobError extends Error {
  constructor(message: string, public readonly detail?: string) {
    super(message);
    this.name = 'JobError';
  }
}

class CancelledError extends Error {
  constructor() {
    super('任务已取消');
    this.name = 'CancelledError';
  }
}

// ── 纯函数（可单测，见 jobs.test.ts）────────────────────

export interface FrameBatch {
  /** 从 1 开始的批次序号。 */
  index: number;
  /** 该批第一帧在整片里的帧号（从 0 开始）。 */
  startFrame: number;
  frameCount: number;
}

/** 估算中间帧占用的磁盘空间。copies = 2 表示「抽出的帧」+「放大的输出帧」各一份。 */
export function estimateSpaceBytes(frameCount: number, bytesPerFrame = FRAME_BYTES_ESTIMATE, copies = 2): number {
  if (!Number.isFinite(frameCount) || frameCount <= 0) return 0;
  return Math.ceil(frameCount) * bytesPerFrame * copies;
}

export function formatGigabytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** 需要超过可用空间的一半就拒绝执行（磁盘红线）。恰好一半算通过。 */
export function isSpaceInsufficient(needBytes: number, freeBytes: number): boolean {
  if (!Number.isFinite(freeBytes) || freeBytes <= 0) return true;
  return needBytes > freeBytes * 0.5;
}

/** 把总帧数切成每批 batchSize 帧。 */
export function planFrameBatches(totalFrames: number, batchSize = DEFAULT_BATCH_FRAMES): FrameBatch[] {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return [];
  const size = Math.max(1, Math.floor(Number.isFinite(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_FRAMES));
  const total = Math.floor(totalFrames);
  const batches: FrameBatch[] = [];
  for (let startFrame = 0; startFrame < total; startFrame += size) {
    batches.push({ index: batches.length + 1, startFrame, frameCount: Math.min(size, total - startFrame) });
  }
  return batches;
}

/** 把帧率数字格式化成 ffmpeg 能接受的字符串，避免出现 29.97002997002997 这种尾巴。 */
export function formatFramerate(fps: number): string {
  return String(Number(fps.toFixed(3)));
}

/** '30000/1001' → 29.97；'0/0' 或缺失 → undefined。 */
export function parseFrameRate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.includes('/')) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : undefined;
}

export function formatDurationCn(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
  }
  const hours = Math.floor(total / 3600);
  return `${hours} 小时 ${Math.floor((total % 3600) / 60)} 分`;
}

export function queueStatusText(aheadCount: number): string {
  return aheadCount <= 0 ? '排队中（马上开始）' : `排队中（前面还有 ${aheadCount} 个）`;
}

export function displayBaseName(originalName: string): string {
  const ext = extname(originalName);
  const base = ext ? originalName.slice(0, -ext.length) : originalName;
  return base.trim() || '素材';
}

export function frameDisplayName(originalName: string, position: 'first' | 'last'): string {
  return `${displayBaseName(originalName)}-${position === 'first' ? '首帧' : '尾帧'}.jpg`;
}

// ── 图片分割（网格切块）────────────────────────────────

/** 行列数的合法范围：1~8（8×8 = 64 块，再多在画布上也管不过来）。 */
export const MIN_GRID_DIVISION = 1;
export const MAX_GRID_DIVISION = 8;

export interface GridCell {
  /** 行号，从 1 开始。 */
  row: number;
  /** 列号，从 1 开始。 */
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function parseGridDivision(value: unknown, label: '列数' | '行数'): number {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || !Number.isInteger(numeric)) {
    throw new JobError(`${label}必须是整数`, `收到的值：${JSON.stringify(value) ?? 'undefined'}`);
  }
  if (numeric < MIN_GRID_DIVISION || numeric > MAX_GRID_DIVISION) {
    throw new JobError(`${label}只能是 ${MIN_GRID_DIVISION} 到 ${MAX_GRID_DIVISION} 之间的整数`, `收到的值：${numeric}（范围 ${MIN_GRID_DIVISION}~${MAX_GRID_DIVISION}）`);
  }
  return numeric;
}

/**
 * 一条边的格子尺寸：前 n-1 格取整除尺寸，最后一格吃掉余数。
 * 不用「每格都向上取整」的分配法：图很小、格数偏多时那种算法会把最后一格算成 0 像素，
 * 交给 crop 就是一个必然失败的格子。这里的分配保证每格 ≥ 1 像素，且各格之和严格等于原边长。
 */
export function splitAxis(total: number, count: number, label: '宽' | '高'): number[] {
  const base = Math.floor(total / count);
  if (base < 1) throw new JobError(`图片${label}只有 ${total} 像素，切不成 ${count} 格，请减少行列数`, `${label}=${total}，格数=${count}`);
  const sizes = new Array<number>(count).fill(base);
  sizes[count - 1] = total - base * (count - 1);
  return sizes;
}

/** 网格切分计算：从左到右、从上到下逐格给出 crop 需要的坐标与尺寸。 */
export function planGridCells(width: number, height: number, cols: unknown, rows: unknown): GridCell[] {
  const safeCols = parseGridDivision(cols, '列数');
  const safeRows = parseGridDivision(rows, '行数');
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new JobError('读不出图片的真实尺寸，无法按网格切块', `宽 ${String(width)} 高 ${String(height)}`);
  }
  const widths = splitAxis(width, safeCols, '宽');
  const heights = splitAxis(height, safeRows, '高');
  const offsetOf = (sizes: number[], index: number) => sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  const cells: GridCell[] = [];
  for (let row = 0; row < safeRows; row += 1) {
    for (let col = 0; col < safeCols; col += 1) {
      cells.push({ row: row + 1, col: col + 1, x: offsetOf(widths, col), y: offsetOf(heights, row), width: widths[col], height: heights[row] });
    }
  }
  return cells;
}

/** 切块的素材显示名，如「小猫咪-第2行第3列.png」。行列都从 1 开始，和用户在界面上数的一致。 */
export function gridCellDisplayName(originalName: string, cell: GridCell): string {
  return `${displayBaseName(originalName)}-第${cell.row}行第${cell.col}列.png`;
}

/**
 * 一次 ffmpeg 调用切完所有格子：先把输入拆成 n 路再逐格 crop，避免为同一张图开 n 个进程重复解码。
 *
 * 必须先把像素格式转成 rgb24：JPEG 这类 4:2:0 素材的色度是半分辨率，crop 在奇数坐标/奇数宽度上
 * 会被强行对齐到偶数（实测 754 宽切 3 列时每格只有 250 像素，9 格加起来比原图少 1764 像素）。
 * rgb24 是全采样，crop 几何不再受约束，切出来的格子逐像素覆盖原图。
 */
export function buildGridFilterGraph(cells: GridCell[]): string {
  const splitOutputs = cells.map((_, index) => `[s${index}]`).join('');
  const lines = [`[0:v]format=rgb24,split=${cells.length}${splitOutputs}`];
  cells.forEach((cell, index) => lines.push(`[s${index}]crop=${cell.width}:${cell.height}:${cell.x}:${cell.y}[c${index}]`));
  return lines.join(';\n');
}

/** 滤镜图走临时文件（AGENTS.md 4.6），输出的 -map 顺序与 cells 一一对应。 */
export function buildGridSplitArgs(inputPath: string, graphFile: string, outputs: string[]): string[] {
  const args = ['-y', '-i', inputPath, '-filter_complex_script', graphFile];
  outputs.forEach((output, index) => args.push('-map', `[c${index}]`, output));
  return args;
}

// ── 时间轴导出 ────────────────────────────────────────

export const DEFAULT_EXPORT_CRF = 18;
export const DEFAULT_EXPORT_PRESET = 'medium';

/** 文件名里 Windows 不允许的字符（<>:"/\|?* 与控制字符），另外去掉首尾的点和空格。 */
export function sanitizeExportFileName(name: unknown): string {
  const raw = typeof name === 'string' ? name.replace(/\.mp4$/i, '') : '';
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80);
  return `${cleaned || '成片'}.mp4`;
}

export interface ExportTimelineOptions { edl: Edl; settings: ExportSettings }

/**
 * 规整前端提交的 options（EDL + 导出设置）：缺项和脏值都在这里挡掉，报错是中文。
 * 数值只做类型与缺省处理，区间校验交给 compileEdl 里的 validateEdl（那边是唯一一处规则来源）。
 */
export function readExportTimelineOptions(options: Record<string, unknown> | undefined): ExportTimelineOptions {
  const rawEdl = options?.edl;
  if (!rawEdl || typeof rawEdl !== 'object') throw new JobError('没有收到时间轴内容，无法导出，请重新打开导出面板');
  const rawSettings = options?.settings;
  if (!rawSettings || typeof rawSettings !== 'object') throw new JobError('没有收到导出设置，无法导出，请重新打开导出面板');

  const edl = rawEdl as Partial<Edl>;
  if (!Array.isArray(edl.clips) || edl.clips.length === 0) throw new JobError('时间轴上没有可导出的片段，请先往时间轴放素材');

  const clips: EdlClip[] = edl.clips.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new JobError(`第 ${index + 1} 个片段的数据不完整，请重新打开导出面板`);
    const clip = raw as Partial<EdlClip>;
    if (typeof clip.path !== 'string' || !clip.path.trim()) throw new JobError(`第 ${index + 1} 个片段没有对应的素材文件，请重新导入素材`);
    return {
      path: clip.path,
      inPoint: readNumber(clip.inPoint, Number.NaN),
      outPoint: readNumber(clip.outPoint, Number.NaN),
      startAt: readNumber(clip.startAt, 0),
      speed: readNumber(clip.speed, 1),
      hasAudio: clip.hasAudio === true,
      audioMode: clip.audioMode === 'mute' || clip.audioMode === 'keepPitchCorrected' ? clip.audioMode : 'keep',
      colorGrade: clip.colorGrade,
      overlays: Array.isArray(clip.overlays)
        ? clip.overlays.map((rawOverlay) => {
            const overlay = (rawOverlay ?? {}) as Record<string, unknown>;
            return {
              path: typeof overlay.path === 'string' ? overlay.path : '',
              x: readNumber(overlay.x, 0),
              y: readNumber(overlay.y, 0),
              widthRatio: readNumber(overlay.widthRatio, 1),
              opacity: readNumber(overlay.opacity, 1),
              startSec: readNumber(overlay.startSec, Number.NaN),
              endSec: readNumber(overlay.endSec, Number.NaN),
              fadeInSec: readNumber(overlay.fadeInSec, 0),
              fadeOutSec: readNumber(overlay.fadeOutSec, 0),
            };
          })
        : undefined,
    };
  });

  const settings = rawSettings as Partial<ExportSettings>;
  const width = Math.round(readNumber(settings.width, readNumber(edl.width, 0)));
  const height = Math.round(readNumber(settings.height, readNumber(edl.height, 0)));
  const fps = readNumber(settings.fps, readNumber(edl.fps, 30));
  return {
    edl: {
      fps,
      width,
      height,
      backgroundColor: typeof edl.backgroundColor === 'string' ? edl.backgroundColor : '#000000',
      clips,
    },
    settings: {
      fileName: sanitizeExportFileName(settings.fileName),
      crf: Math.round(readNumber(settings.crf, DEFAULT_EXPORT_CRF)),
      preset: readString(settings.preset) ?? DEFAULT_EXPORT_PRESET,
      encoder: settings.encoder === 'h264_nvenc' ? 'h264_nvenc' : 'libx264',
      width,
      height,
      fps,
    },
  };
}

/**
 * 抽首帧 / 尾帧的参数。
 *
 * 尾帧必须先把 `-ss` 放在 `-i` 之后（输出侧定位、帧精确）：`-sseof -0.1` 取到的
 * 是倒数若干帧里的一帧，实测和真正的最后一帧不一致（见 AGENTS.md 的警告）。
 * 位置值取 D-0.04，是留出半个帧以内的安全余量，避免浮点误差落到下一帧之外。
 */
export function buildExportFrameArgs(inputPath: string, outputPath: string, position: 'first' | 'last', durationSec = 0): string[] {
  if (position === 'first') return ['-y', '-i', inputPath, '-frames:v', '1', '-q:v', '2', outputPath];
  const at = Math.max(0, durationSec - 0.04);
  return ['-y', '-i', inputPath, '-ss', at.toFixed(3), '-frames:v', '1', '-q:v', '2', outputPath];
}

/**
 * 分块抽帧的参数（PRD E2 第 3 步）：每批最多 200 帧，用 JPEG 不用 PNG。
 *
 * `-ss` 放在 `-i` 之前是快速定位，默认的 accurate_seek 会丢弃关键帧到目标之间的帧，
 * 所以取的是精确帧；目标时间减半帧是为了让浮点误差落在同一帧内（实测 29.97fps 的第 201 帧不偏）。
 */
export function buildBatchExtractArgs(inputPath: string, outputPattern: string, startFrame: number, frameCount: number, fps: number): string[] {
  const args = ['-y', '-progress', 'pipe:1'];
  if (startFrame > 0 && fps > 0) args.push('-ss', ((startFrame - 0.5) / fps).toFixed(6));
  args.push('-i', inputPath, '-frames:v', String(Math.max(1, Math.floor(frameCount))), '-vsync', '0', '-f', 'image2', '-q:v', '2', outputPattern);
  return args;
}

export interface RealEsrganArgsInput {
  input: string;
  output: string;
  model: string;
  scale: number;
  tile: number;
  /** 模型权重目录。留空则用工具默认的 ./models（配合 cwd 指到 bin/）。 */
  modelPath?: string;
}

export function buildRealEsrganArgs(options: RealEsrganArgsInput): string[] {
  const args = ['-i', options.input, '-o', options.output, '-n', options.model, '-s', String(options.scale), '-t', String(options.tile)];
  if (options.modelPath) args.push('-m', options.modelPath);
  return args;
}

/**
 * RIFE 的 `-n` 是**目标总帧数**（不是倍率）。传成倍率会让它只输出几帧，
 * 结果是一个零点几秒的残片——实测过 30 帧传 `-n 2` 只出 8 帧、0.13 秒。
 * 所以这里必须传「这一批的输入帧数 × 倍率」。
 */
export function buildRifeArgs(input: string, output: string, model: string, targetFrameCount: number): string[] {
  return ['-i', input, '-o', output, '-m', model, '-n', String(Math.max(1, Math.floor(targetFrameCount)))];
}

/** 把一批处理好的帧合回一段视频（编码参数必须和后面 concat 的其它段完全一致）。 */
export function buildSegmentArgs(framePattern: string, framerate: number, outputPath: string): string[] {
  return ['-y', '-progress', 'pipe:1', '-framerate', formatFramerate(framerate), '-i', framePattern, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', outputPath];
}

export function buildConcatArgs(listFile: string, outputPath: string): string[] {
  return ['-y', '-progress', 'pipe:1', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outputPath];
}

/**
 * 从原视频复制音轨而不是重编码。
 * 音频一律用带问号的 `-map 1:a?`：源视频没有音轨时不会报错（PRD E2 异常与边界）。
 */
export function buildMuxAudioArgs(videoPath: string, audioSourcePath: string, outputPath: string, hasAudio: boolean): string[] {
  const args = ['-y', '-i', videoPath, '-i', audioSourcePath, '-map', '0:v', '-map', '1:a?', '-c:v', 'copy', '-c:a', 'copy'];
  // 没有音轨时不能加 -shortest：否则会把视频末尾按“音频为 0 秒”截掉。
  if (hasAudio) args.push('-shortest');
  args.push('-movflags', '+faststart', outputPath);
  return args;
}

/** concat demuxer 的清单行：路径用正斜杠，单引号要转义，否则 Windows 路径会让它静默失败。 */
export function concatListLine(absolutePath: string): string {
  return `file '${absolutePath.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
}

export function frameFileExtension(fileName: string): string | undefined {
  const match = /^\d{4,8}\.(png|jpg|jpeg|webp)$/i.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : undefined;
}

/** 显存不足：自动把 tile 减半重试一次（PRD E1 异常与边界）。 */
export function isGpuMemoryError(text: string): boolean {
  return /out of memory|outofmemory|vkAllocateMemory|vkMapMemory|VK_ERROR_OUT_OF_DEVICE_MEMORY|VK_ERROR_OUT_OF_HOST_MEMORY|failed to allocate|gpu memory/i.test(text);
}

/** ncnn 的 tile 最小 32，0 表示自动；减半不能低于 32，也不能把“自动”变成 0 以外的东西。 */
export function halveTile(tile: number): number {
  if (!Number.isFinite(tile) || tile <= 0) return 0;
  return Math.max(32, Math.floor(tile / 2));
}

export function missingToolError(tool: 'realesrgan' | 'rife', expectedPath: string): { message: string; detail: string } {
  const label = tool === 'realesrgan' ? 'Real-ESRGAN 放大' : 'RIFE 补帧';
  return {
    message: `还没安装 ${label}工具，请先运行 node scripts/fetch-tools.mjs 下载`,
    detail: `期望的可执行文件路径：${expectedPath}\n下载脚本会把二进制和模型放到工作区的 bin/ 下。如果已经下载过，请检查工作区路径是否换过。`,
  };
}

/** 解析 ffmpeg `-progress pipe:1` 的结构化输出，返回 0~1 的进度。 */
export function parseFfmpegProgress(chunk: string, durationSec: number): number | undefined {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return undefined;
  let ratio: number | undefined;
  for (const rawLine of chunk.split('\n')) {
    const line = rawLine.trim();
    // ffmpeg 的 out_time_ms 实际是按微秒填的（和 out_time_us 同值），所以两个都按微秒算。
    const match = /^out_time_(?:us|ms)=(-?\d+)$/.exec(line);
    if (match) {
      const microseconds = Number(match[1]);
      if (Number.isFinite(microseconds) && microseconds >= 0) ratio = microseconds / 1_000_000 / durationSec;
      continue;
    }
    if (line === 'progress=end') ratio = 1;
  }
  return ratio === undefined ? undefined : Math.max(0, Math.min(1, ratio));
}

/** 解析 `-progress pipe:1` 里的 frame=N，用于「第 X/Y 帧」这种精确进度。 */
export function parseFrameCount(chunk: string): number | undefined {
  let frames: number | undefined;
  for (const rawLine of chunk.split('\n')) {
    const match = /^frame=(\d+)$/.exec(rawLine.trim());
    if (match) frames = Number(match[1]);
  }
  return frames;
}

/** ncnn 工具没有结构化进度，只能从它打印的百分比里捡（realesrgan 打到 stderr）。 */
export function parseNcnnProgress(chunk: string): number | undefined {
  let percent: number | undefined;
  for (const match of chunk.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) percent = value;
  }
  return percent === undefined ? undefined : Math.max(0, Math.min(1, percent / 100));
}

export function interpolatedFps(fps: number, multiplier: number): number {
  return Number((fps * multiplier).toFixed(3));
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

const readNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
const readString = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

// ── 工作区内的工具路径 ─────────────────────────────────
const exeSuffix = () => (process.platform === 'win32' ? '.exe' : '');

export function toolPath(workspaceRoot: string, name: string): string {
  return join(workspaceRoot, 'bin', `${name}${exeSuffix()}`);
}

export function findOnPath(executable: string): string | undefined {
  const searchPath = process.env.PATH ?? '';
  for (const dir of searchPath.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** ffmpeg / ffprobe 优先用工作区 bin/ 下的，没有就退回 PATH（用户机器上已装 ffmpeg 7.1）。 */
function resolveFfmpeg(workspaceRoot: string): string {
  const local = toolPath(workspaceRoot, 'ffmpeg');
  if (existsSync(local)) return local;
  return findOnPath(`ffmpeg${exeSuffix()}`) ?? 'ffmpeg';
}

function resolveFfprobe(workspaceRoot: string): string {
  const local = toolPath(workspaceRoot, 'ffprobe');
  if (existsSync(local)) return local;
  return findOnPath(`ffprobe${exeSuffix()}`) ?? 'ffprobe';
}

function resolveRealesrgan(workspaceRoot: string): string {
  const path = toolPath(workspaceRoot, REALESRGAN_EXE);
  if (!existsSync(path)) throw new JobError(missingToolError('realesrgan', path).message, missingToolError('realesrgan', path).detail);
  return path;
}

function resolveRife(workspaceRoot: string): string {
  const path = toolPath(workspaceRoot, RIFE_EXE);
  if (!existsSync(path)) throw new JobError(missingToolError('rife', path).message, missingToolError('rife', path).detail);
  return path;
}

/** 模型权重目录：bin/models（跟着 exe）优先，其次工作区根目录的 models/。 */
function resolveModelsDir(workspaceRoot: string): string | undefined {
  for (const candidate of [join(workspaceRoot, 'bin', 'models'), join(workspaceRoot, 'models')]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function freeSpaceBytes(path: string): Promise<number | undefined> {
  try {
    const info = await statfs(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    // 读不到剩余空间就不拦任务（宁可跑失败，也不要因为查询失败卡住用户）。
    return undefined;
  }
}

export async function toolStatus(workspaceRoot: string): Promise<ToolStatus> {
  return {
    ffmpeg: existsSync(toolPath(workspaceRoot, 'ffmpeg')) || Boolean(findOnPath(`ffmpeg${exeSuffix()}`)),
    ffprobe: existsSync(toolPath(workspaceRoot, 'ffprobe')) || Boolean(findOnPath(`ffprobe${exeSuffix()}`)),
    realesrgan: existsSync(toolPath(workspaceRoot, REALESRGAN_EXE)),
    rife: existsSync(toolPath(workspaceRoot, RIFE_EXE)),
  };
}

// ── 队列状态与持久化 ───────────────────────────────────

export interface JobRequest {
  projectId: string;
  kind: JobKind;
  assetIds: string[];
  options?: Record<string, unknown>;
}

/** options 存在任务记录里，重试 / 重启后才能按同样的参数再跑一遍。 */
interface StoredJob extends Job {
  options?: Record<string, unknown>;
}

interface RootState {
  jobs: StoredJob[];
  runningId?: string;
  /** 当前任务是否已被请求取消。同一工作区同一时刻只有一个任务，所以放在根级别就够。 */
  cancelRequested: boolean;
  children: Set<ChildProcess>;
  lastPersist: number;
}

const states = new Map<string, RootState>();

const jobsFile = (root: string) => join(root, 'jobs.json');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function normaliseJob(raw: unknown): StoredJob | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const job = raw as Partial<StoredJob>;
  if (typeof job.id !== 'string' || typeof job.projectId !== 'string' || typeof job.kind !== 'string') return undefined;
  const status: JobStatus = job.status === 'queued' || job.status === 'running' || job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled' ? job.status : 'failed';
  return {
    id: job.id,
    projectId: job.projectId,
    kind: job.kind,
    status,
    progress: typeof job.progress === 'number' ? clamp01(job.progress) : 0,
    statusText: typeof job.statusText === 'string' ? job.statusText : '',
    assetIds: Array.isArray(job.assetIds) ? job.assetIds.filter((id): id is string => typeof id === 'string') : [],
    resultAssetIds: Array.isArray(job.resultAssetIds) ? job.resultAssetIds.filter((id): id is string => typeof id === 'string') : [],
    errorMessage: typeof job.errorMessage === 'string' ? job.errorMessage : undefined,
    errorDetail: typeof job.errorDetail === 'string' ? job.errorDetail : undefined,
    createdAt: typeof job.createdAt === 'number' ? job.createdAt : Date.now(),
    startedAt: typeof job.startedAt === 'number' ? job.startedAt : undefined,
    finishedAt: typeof job.finishedAt === 'number' ? job.finishedAt : undefined,
    options: job.options && typeof job.options === 'object' ? job.options : undefined,
  };
}

/** 第一次碰某个工作区时把 jobs.json 同步读进来。enqueueJob 是同步接口，所以这里用同步 IO。 */
function stateFor(root: string): RootState {
  const cached = states.get(root);
  if (cached) return cached;
  const state: RootState = { jobs: [], cancelRequested: false, children: new Set(), lastPersist: 0 };
  try {
    const parsed = JSON.parse(readFileSync(jobsFile(root), 'utf8')) as { jobs?: unknown };
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    state.jobs = jobs.map(normaliseJob).filter((job): job is StoredJob => Boolean(job)).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    // 首次使用，或文件被手工改坏了：按空队列处理，不要让服务起不来。
  }
  states.set(root, state);
  return state;
}

/** progress 更新很频繁，写盘节流到 500ms 一次；状态变化（immediate）立刻落盘。 */
function persist(root: string, immediate = false): void {
  const state = stateFor(root);
  const now = Date.now();
  if (!immediate && now - state.lastPersist < 500) return;
  state.lastPersist = now;
  const target = jobsFile(root);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temp, JSON.stringify({ jobs: state.jobs }, null, 2), 'utf8');
    renameSync(temp, target);
  } catch (error) {
    // 队列状态不是关键数据，写不进去也不能让任务失败。
    console.error(`任务状态写入失败（不影响任务执行）：${error instanceof Error ? error.message : String(error)}`);
  }
}

function refreshQueueTexts(state: RootState): void {
  let ahead = 0;
  for (const job of state.jobs) {
    if (job.status !== 'queued') continue;
    job.statusText = queueStatusText(ahead);
    ahead += 1;
  }
}

function projectTempDir(root: string, projectId: string): string {
  return join(root, 'projects', projectId, 'temp');
}

async function cleanupProjectTemp(root: string, projectId: string): Promise<void> {
  const dir = projectTempDir(root, projectId);
  // 刚杀掉的子进程可能还握着文件句柄，Windows 上会 EBUSY/EPERM，等一小会儿再删。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(250);
    }
  }
}

export async function deleteJob(workspaceRoot: string, id: string): Promise<boolean> {
  const state = stateFor(workspaceRoot);
  const job = state.jobs.find((item) => item.id === id);
  if (!job || job.status === 'running' || job.status === 'queued') return false;
  state.jobs = state.jobs.filter((item) => item.id !== id);
  persist(workspaceRoot, true);
  return true;
}

export function listJobs(workspaceRoot: string): Job[] {
  return stateFor(workspaceRoot).jobs.map((job) => ({ ...job }));
}

export function getJob(workspaceRoot: string, id: string): Job | undefined {
  const job = stateFor(workspaceRoot).jobs.find((item) => item.id === id);
  return job ? { ...job } : undefined;
}

export function enqueueJob(workspaceRoot: string, request: JobRequest): Job {
  const state = stateFor(workspaceRoot);
  const job: StoredJob = {
    id: nanoid(),
    projectId: request.projectId,
    kind: request.kind,
    status: 'queued',
    progress: 0,
    statusText: queueStatusText(0),
    assetIds: [...request.assetIds],
    resultAssetIds: [],
    createdAt: Date.now(),
    options: request.options ? { ...request.options } : undefined,
  };
  state.jobs.push(job);
  refreshQueueTexts(state);
  persist(workspaceRoot, true);
  pump(workspaceRoot);
  return { ...job };
}

export async function cancelJob(workspaceRoot: string, id: string): Promise<boolean> {
  const state = stateFor(workspaceRoot);
  const job = state.jobs.find((item) => item.id === id);
  if (!job) return false;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.statusText = '已取消';
    job.finishedAt = Date.now();
    refreshQueueTexts(state);
    persist(workspaceRoot, true);
    return true;
  }
  if (job.status !== 'running') return false;
  state.cancelRequested = true;
  for (const child of [...state.children]) killProcessTree(child);
  job.status = 'cancelled';
  job.statusText = '已取消';
  job.finishedAt = Date.now();
  persist(workspaceRoot, true);
  // 中间文件清理和下一个任务的启动交给 execute() 收尾：等正在退出的子进程真正死掉再动文件，
  // 也不会出现两个重型任务短暂同时跑的情况。
  return true;
}

export async function restoreJobs(workspaceRoot: string): Promise<void> {
  const state = stateFor(workspaceRoot);
  for (const job of state.jobs) {
    if (job.status !== 'running') continue;
    job.status = 'failed';
    job.progress = 0;
    job.errorMessage = '上次运行被中断，请重新执行';
    job.errorDetail = '应用在任务执行过程中被关闭，正在运行的 ffmpeg / realesrgan / rife 子进程已随之中断。';
    job.statusText = '上次运行被中断，请重新执行';
    job.finishedAt = Date.now();
  }
  refreshQueueTexts(state);
  persist(workspaceRoot, true);
  // 上次没轮到跑的任务继续按顺序排队执行（同一时刻仍然只有 1 个）。
  pump(workspaceRoot);
}

function pump(workspaceRoot: string): void {
  const state = stateFor(workspaceRoot);
  if (state.runningId) return;
  const next = state.jobs.find((job) => job.status === 'queued');
  if (!next) {
    refreshQueueTexts(state);
    return;
  }
  state.runningId = next.id;
  state.cancelRequested = false;
  next.status = 'running';
  next.progress = 0;
  next.statusText = '正在准备…';
  next.startedAt = Date.now();
  next.finishedAt = undefined;
  next.errorMessage = undefined;
  next.errorDetail = undefined;
  refreshQueueTexts(state);
  persist(workspaceRoot, true);
  void execute(workspaceRoot, next).finally(() => {
    state.runningId = undefined;
    state.cancelRequested = false;
    for (const child of [...state.children]) killProcessTree(child);
    state.children.clear();
    persist(workspaceRoot, true);
    pump(workspaceRoot);
  });
}

// ── 任务执行 ──────────────────────────────────────────

interface JobContext {
  root: string;
  job: StoredJob;
  state: RootState;
  startedAt: number;
}

interface ProcessOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** true 时非 0 退出不抛错，由调用方自己看 stderr 决定怎么处理。 */
  allowFailure?: boolean;
}

function throwIfCancelled(ctx: JobContext): void {
  if (ctx.state.cancelRequested) throw new CancelledError();
}

function shortStderr(stderr: string): string {
  const text = stderr.trim();
  if (!text) return '（工具没有输出错误信息）';
  const lines = text.split(/\r?\n/);
  return lines.slice(-12).join('\n');
}

function runChild(ctx: JobContext, command: string, args: readonly string[], options: RunOptions = {}): Promise<ProcessOutcome> {
  throwIfCancelled(ctx);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, windowsHide: true, shell: false });
    ctx.state.children.add(child);
    let stdout = '';
    let stderr = '';
    const name = basename(command);
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      ctx.state.children.delete(child);
      if (ctx.state.cancelRequested) {
        reject(new CancelledError());
        return;
      }
      const message = error.code === 'ENOENT' ? `找不到工具 ${name}，请先运行 node scripts/fetch-tools.mjs 下载` : `无法启动 ${name}，请检查文件是否被杀毒软件拦截`;
      reject(new JobError(message, `${command}\n${error.message}`));
    });
    child.once('close', (code) => {
      ctx.state.children.delete(child);
      if (ctx.state.cancelRequested) {
        reject(new CancelledError());
        return;
      }
      const exitCode = code ?? -1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new JobError(`${name} 执行失败（退出码 ${exitCode}）`, `${command} ${args.join(' ')}\n${shortStderr(stderr)}`));
        return;
      }
      resolve({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
  });
}

function report(ctx: JobContext, patch: { progress?: number; statusText?: string }): void {
  if (typeof patch.progress === 'number') ctx.job.progress = clamp01(patch.progress);
  if (patch.statusText) ctx.job.statusText = patch.statusText;
  persist(ctx.root);
}

/** 多素材任务里第 index 个素材的进度区间，避免后面的素材把进度条从 0 重来。 */
function spanOf(index: number, total: number): { base: number; span: number } {
  const count = Math.max(1, total);
  return { base: index / count, span: 1 / count };
}

async function execute(workspaceRoot: string, job: StoredJob): Promise<void> {
  const ctx: JobContext = { root: workspaceRoot, job, state: stateFor(workspaceRoot), startedAt: job.startedAt ?? Date.now() };
  try {
    const resultAssetIds = await runJob(ctx);
    throwIfCancelled(ctx);
    job.status = 'succeeded';
    job.progress = 1;
    job.resultAssetIds = resultAssetIds;
    job.statusText = resultAssetIds.length > 0 ? `已完成，成果已存进素材库（${resultAssetIds.length} 个）` : '已完成';
    job.finishedAt = Date.now();
  } catch (error) {
    if (error instanceof CancelledError || ctx.state.cancelRequested) {
      job.status = 'cancelled';
      job.progress = 0;
      job.statusText = '已取消';
      job.finishedAt = Date.now();
      await cleanupProjectTemp(ctx.root, job.projectId).catch(() => undefined);
    } else if (error instanceof JobError) {
      job.status = 'failed';
      job.statusText = '失败了，请看下面的原因';
      job.errorMessage = error.message;
      job.errorDetail = error.detail;
      job.finishedAt = Date.now();
      await cleanupProjectTemp(ctx.root, job.projectId).catch(() => undefined);
    } else {
      job.status = 'failed';
      job.statusText = '失败了，请看下面的原因';
      job.errorMessage = '任务执行过程中出现意外错误，请重试';
      job.errorDetail = error instanceof Error ? error.stack ?? error.message : String(error);
      job.finishedAt = Date.now();
      await cleanupProjectTemp(ctx.root, job.projectId).catch(() => undefined);
    }
  }
}

async function runJob(ctx: JobContext): Promise<string[]> {
  const { job } = ctx;
  // 时间轴导出的输入是 EDL 里的绝对路径，不依赖 assetIds，所以放在素材检查之前。
  if (job.kind === 'exportTimeline') return runExportTimeline(ctx);
  if (job.assetIds.length === 0) throw new JobError('这个任务没有指定素材，请重新选择素材后再执行');
  const state = await ensureWorkspace(ctx.root);
  const assets = job.assetIds.map((id) => assetById(state, id)).filter((asset): asset is Asset => Boolean(asset));
  if (assets.length === 0) throw new JobError('素材不存在或已被删除，请重新选择素材');
  await ensureProjectDirectories(state, job.projectId);

  switch (job.kind) {
    case 'exportFrames':
      return runExportFrames(ctx, state, assets);
    case 'upscaleImage':
      return runUpscaleImages(ctx, state, assets);
    case 'upscaleVideo':
      return runVideoUpscale(ctx, state, assets);
    case 'interpolateVideo':
      return runVideoInterpolate(ctx, state, assets);
    case 'splitImage':
      return runSplitImages(ctx, state, assets);
    default:
      throw new JobError('这个任务类型还不支持', `未知的任务类型：${String(job.kind)}`);
  }
}

// ── 抽帧 ──────────────────────────────────────────────

async function runExportFrames(ctx: JobContext, state: WorkspaceState, assets: Asset[]): Promise<string[]> {
  const results: string[] = [];
  for (const [index, asset] of assets.entries()) {
    throwIfCancelled(ctx);
    const { base, span } = spanOf(index, assets.length);
    report(ctx, { progress: base, statusText: assets.length > 1 ? `正在处理第 ${index + 1}/${assets.length} 个视频…` : '正在读取视频信息…' });
    results.push(await exportFrameOne(ctx, state, asset, base, span));
  }
  return results;
}

async function exportFrameOne(ctx: JobContext, state: WorkspaceState, asset: Asset, base: number, span: number): Promise<string> {
  if (asset.kind !== 'video') throw new JobError('抽首尾帧只能对视频素材使用，请选择视频素材');
  const source = assetAbsolutePath(state, asset);
  if (!existsSync(source)) throw new JobError('素材文件找不到了，可能被移动或删除，请重新导入', source);

  const position = ctx.job.options?.position === 'last' ? 'last' : 'first';
  const tempDir = projectTempDir(ctx.root, asset.projectId);
  await mkdir(tempDir, { recursive: true });
  const output = join(tempDir, `frame-${nanoid(8)}.jpg`);
  const ffmpeg = resolveFfmpeg(ctx.root);

  let durationSec = 0;
  if (position === 'last') {
    const probe = await probeVideo(ctx, source);
    if (!probe.durationSec || probe.durationSec <= 0) throw new JobError('读不出这个视频的时长，无法定位尾帧', 'ffprobe 没有返回 format.duration');
    durationSec = probe.durationSec;
  }
  report(ctx, { progress: base + span * 0.1, statusText: `正在抽取${position === 'first' ? '首帧' : '尾帧'}…` });

  await runChild(ctx, ffmpeg, buildExportFrameArgs(source, output, position, durationSec));
  if (!existsSync(output)) throw new JobError('抽帧没有生成图片，视频文件可能损坏', `预期输出：${output}`);

  const registered = await registerGeneratedAsset(ctx.root, asset.projectId, output, frameDisplayName(asset.originalName, position), 'exportedFrame');
  report(ctx, { progress: base + span, statusText: `已抽出${position === 'first' ? '首帧' : '尾帧'}并加入素材库` });
  return registered.id;
}

// ── 图片分割 ──────────────────────────────────────────

async function probeImageSize(ctx: JobContext, path: string): Promise<{ width: number; height: number }> {
  const ffprobe = resolveFfprobe(ctx.root);
  const outcome = await runChild(ctx, ffprobe, buildFfprobeArgs(path));
  let parsed: { streams?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(outcome.stdout) as typeof parsed;
  } catch {
    throw new JobError('读不出图片信息，文件可能损坏', `ffprobe 输出无法解析：${outcome.stdout.slice(0, 500)}`);
  }
  const stream = (parsed.streams ?? []).find((item) => item.codec_type === 'video');
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new JobError('读不出图片的真实尺寸，无法按网格切块', `${path}\n${outcome.stdout.slice(0, 500)}`);
  }
  return { width, height };
}

async function runSplitImages(ctx: JobContext, state: WorkspaceState, assets: Asset[]): Promise<string[]> {
  const cols = parseGridDivision(ctx.job.options?.cols, '列数');
  const rows = parseGridDivision(ctx.job.options?.rows, '行数');
  const cellsPerImage = cols * rows;
  const totalCells = assets.length * cellsPerImage;
  const ffmpeg = resolveFfmpeg(ctx.root);
  const tempDir = projectTempDir(ctx.root, ctx.job.projectId);
  await mkdir(tempDir, { recursive: true });

  // 先把所有输入查一遍：混进来一个视频或缺失的素材时，不要切了一半才失败
  for (const [index, asset] of assets.entries()) {
    if (asset.kind !== 'image') throw new JobError(`第 ${index + 1} 个素材不是图片，图片分割只能对图片素材使用`, `素材 ${asset.originalName}（${asset.id}）的类型是 ${asset.kind}`);
    if (!existsSync(assetAbsolutePath(state, asset))) throw new JobError('素材文件找不到了，可能被移动或删除，请重新导入', assetAbsolutePath(state, asset));
  }

  const results: string[] = [];
  let done = 0;
  for (const [index, asset] of assets.entries()) {
    throwIfCancelled(ctx);
    const source = assetAbsolutePath(state, asset);
    const prefix = assets.length > 1 ? `第 ${index + 1}/${assets.length} 张图：` : '';
    report(ctx, { progress: done / totalCells, statusText: `${prefix}正在读取图片尺寸…` });
    const { width, height } = await probeImageSize(ctx, source);
    const cells = planGridCells(width, height, cols, rows);

    const outputs = cells.map(() => join(tempDir, `grid-${nanoid(8)}.png`));
    const graphFile = join(tempDir, `grid-${nanoid(8)}.txt`);
    writeFileSync(graphFile, buildGridFilterGraph(cells), 'utf8');
    report(ctx, { statusText: `${prefix}正在按 ${rows} 行 ${cols} 列切分（${width}×${height}）…` });

    await runChild(ctx, ffmpeg, buildGridSplitArgs(source, graphFile, outputs));

    for (const [cellIndex, output] of outputs.entries()) {
      throwIfCancelled(ctx);
      const cell = cells[cellIndex];
      if (!existsSync(output)) {
        throw new JobError(`第 ${cell.row} 行第 ${cell.col} 列没有切出来，图片可能损坏`, `预期输出：${output}`);
      }
      const registered = await registerGeneratedAsset(ctx.root, asset.projectId, output, gridCellDisplayName(asset.originalName, cell), 'split');
      results.push(registered.id);
      done += 1;
      report(ctx, { progress: done / totalCells, statusText: `${prefix}第 ${done}/${totalCells} 格 · 第 ${cell.row} 行第 ${cell.col} 列（${cell.width}×${cell.height}）已加入素材库` });
    }
    await rm(graphFile, { force: true }).catch(() => undefined);
  }
  return results;
}

// ── 时间轴导出 ────────────────────────────────────────

/** 导出用的一次 ffmpeg 调用：滤镜图写进临时文件，用 -filter_complex_script 传（AGENTS.md 4.6）。 */
export function buildExportTimelineArgs(compiled: { inputs: string[]; maps: string[]; outputArgs: string[] }, graphFile: string, outputPath: string): string[] {
  return [
    '-y',
    '-progress', 'pipe:1',
    ...compiled.inputs.flatMap((path) => ['-i', path]),
    '-filter_complex_script', graphFile,
    ...compiled.maps,
    ...compiled.outputArgs,
    outputPath,
  ];
}

async function runExportTimeline(ctx: JobContext): Promise<string[]> {
  const { edl, settings } = readExportTimelineOptions(ctx.job.options);
  const state = await ensureWorkspace(ctx.root);
  await ensureProjectDirectories(state, ctx.job.projectId);
  const projectDir = projectDirectory(state, ctx.job.projectId);
  const tempDir = projectTempDir(ctx.root, ctx.job.projectId);
  await mkdir(join(projectDir, 'exports'), { recursive: true });
  await mkdir(tempDir, { recursive: true });

  let compiled: ReturnType<typeof compileEdl>;
  try {
    compiled = compileEdl(edl, settings);
  } catch (error) {
    // 结构校验不通过（入点出点、变速范围、贴图时间窗、分辨率）：中文原因直接给用户看
    throw new JobError(error instanceof Error ? error.message : '导出参数不合法', '滤镜图编译前的校验（PRD 10.1 第 1 步）未通过');
  }

  // 一次把缺失的素材列全，别让用户导到一半才失败（TASKS 7.2.5）
  const missing = compiled.inputs.filter((path) => !path || !existsSync(path));
  if (missing.length > 0) {
    throw new JobError(`有 ${missing.length} 个素材文件找不到了，导出已中止，请把缺失的素材重新导入后再试`, missing.join('\n'));
  }

  const outputFile = join(projectDir, 'exports', settings.fileName);
  const renderFile = join(tempDir, `export-${nanoid(8)}.mp4`);
  const graphFile = join(tempDir, `export-${nanoid(8)}.txt`);
  const logFile = join(projectDir, 'exports', `${settings.fileName.replace(/\.mp4$/i, '')}.ffmpeg.log`);
  writeFileSync(graphFile, compiled.filterGraph, 'utf8');

  const totalDuration = totalTimelineDuration(edl);
  const startedAt = Date.now();
  const args = buildExportTimelineArgs(compiled, graphFile, renderFile);
  let stderr = '';
  report(ctx, { progress: 0.01, statusText: `正在导出「${settings.fileName}」…` });

  let outcome: ProcessOutcome;
  try {
    outcome = await runChild(ctx, resolveFfmpeg(ctx.root), args, {
      allowFailure: true,
      onStdout: (chunk) => {
        const ratio = parseFfmpegProgress(chunk, totalDuration);
        if (ratio === undefined) return;
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const remaining = ratio > 0.005 ? `预计剩余 ${formatDurationCn((elapsedSec / ratio) * (1 - ratio))}` : '正在估算剩余时间';
        report(ctx, { progress: 0.02 + ratio * 0.96, statusText: `正在导出…${Math.round(ratio * 100)}% · 已用 ${formatDurationCn(elapsedSec)} · ${remaining}` });
      },
      onStderr: (chunk) => { stderr += chunk; },
    });
  } catch (error) {
    // 取消（或被其它原因打断）：进程树已经在队列层杀掉，这里把不完整的成片删掉（TASKS 7.2.10）
    await rm(renderFile, { force: true }).catch(() => undefined);
    await rm(outputFile, { force: true }).catch(() => undefined);
    await rm(graphFile, { force: true }).catch(() => undefined);
    throw error;
  }

  if (!outcome.ok) {
    await rm(renderFile, { force: true }).catch(() => undefined);
    const log = [
      `时间：${new Date().toISOString()}`,
      `命令：ffmpeg ${args.join(' ')}`,
      '',
      '滤镜图：',
      compiled.filterGraph,
      '',
      `ffmpeg 输出（退出码 ${outcome.exitCode}）：`,
      stderr.trim() || '（没有输出错误信息）',
      '',
    ].join('\n');
    try {
      writeFileSync(logFile, log, 'utf8');
    } catch {
      // 日志写不进去也不能盖住真正的失败原因，下面照样把摘要给用户
    }
    throw new JobError(
      `导出失败：ffmpeg 处理出错（退出码 ${outcome.exitCode}），详细日志已存到导出目录`,
      `完整日志：${logFile}\n\n${shortStderr(stderr)}`,
    );
  }

  if (!existsSync(renderFile)) throw new JobError('导出没有生成成片文件，请重试', `预期输出：${renderFile}`);
  // exports/ 下留一份给用户打开所在文件夹看；registerGeneratedAsset 是移动语义，所以先复制再登记
  await copyFile(renderFile, outputFile);
  const registered = await registerGeneratedAsset(ctx.root, ctx.job.projectId, renderFile, settings.fileName, 'exported');
  await rm(renderFile, { force: true }).catch(() => undefined);
  await rm(graphFile, { force: true }).catch(() => undefined);
  report(ctx, { progress: 1, statusText: `导出完成：${settings.fileName}` });
  return [registered.id];
}


// ── 图片放大 ──────────────────────────────────────────

async function runUpscaleImages(ctx: JobContext, state: WorkspaceState, assets: Asset[]): Promise<string[]> {
  const tool = resolveRealesrgan(ctx.root);
  const modelsDir = resolveModelsDir(ctx.root);
  const model = readString(ctx.job.options?.model) ?? DEFAULT_UPSCALE_MODEL;
  const scale = Math.max(1, Math.min(8, Math.round(readNumber(ctx.job.options?.scale, DEFAULT_UPSCALE_SCALE))));
  const requestedTile = Math.round(readNumber(ctx.job.options?.tile, DEFAULT_TILE));
  const results: string[] = [];

  for (const [index, asset] of assets.entries()) {
    throwIfCancelled(ctx);
    const { base, span } = spanOf(index, assets.length);
    if (asset.kind !== 'image') throw new JobError('图片放大只能对图片素材使用，请选择图片素材');
    const source = assetAbsolutePath(state, asset);
    if (!existsSync(source)) throw new JobError('素材文件找不到了，可能被移动或删除，请重新导入', source);

    const tempDir = projectTempDir(ctx.root, asset.projectId);
    await mkdir(tempDir, { recursive: true });
    const output = join(tempDir, `upscaled-${nanoid(8)}.png`);
    const prefix = assets.length > 1 ? `第 ${index + 1}/${assets.length} 个：` : '';
    report(ctx, { progress: base, statusText: `${prefix}正在放大图片（${model}，${scale} 倍，tile ${requestedTile}）…` });

    let tile = requestedTile;
    let finished = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      throwIfCancelled(ctx);
      const outcome = await runChild(ctx, tool, buildRealEsrganArgs({ input: source, output, model, scale, tile, modelPath: modelsDir }), {
        cwd: dirname(tool),
        allowFailure: true,
        onStderr: (chunk) => {
          const inner = parseNcnnProgress(chunk);
          if (inner !== undefined) report(ctx, { progress: base + span * (0.05 + 0.8 * inner), statusText: `${prefix}正在放大图片…${Math.round(inner * 100)}%` });
        },
      });
      if (outcome.ok && existsSync(output)) {
        finished = true;
        break;
      }
      if (attempt === 0 && isGpuMemoryError(`${outcome.stderr}\n${outcome.stdout}`)) {
        tile = halveTile(tile);
        report(ctx, { statusText: `${prefix}显存不足，已把 tile 调到 ${tile} 再试一次…` });
        continue;
      }
      throw new JobError(`图片放大失败${attempt > 0 ? '（降低 tile 重试后仍然失败，请在参数里手动调小 tile）' : ''}`, shortStderr(outcome.stderr));
    }
    if (!finished) throw new JobError('图片放大失败，请把 tile 调小后重试', `输出文件没有生成：${output}`);

    report(ctx, { progress: base + span * 0.95, statusText: `${prefix}正在把结果存进素材库…` });
    const registered = await registerGeneratedAsset(ctx.root, asset.projectId, output, `${displayBaseName(asset.originalName)}-放大${scale}x.png`, 'upscaled');
    results.push(registered.id);
    report(ctx, { progress: base + span, statusText: `${prefix}放大完成` });
  }
  return results;
}

// ── 视频放大 / 补帧 ────────────────────────────────────

interface VideoProbe {
  durationSec: number;
  fps: number;
  frameCount: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
}

async function probeVideo(ctx: JobContext, path: string): Promise<VideoProbe> {
  const ffprobe = resolveFfprobe(ctx.root);
  const outcome = await runChild(ctx, ffprobe, buildFfprobeArgs(path));
  let parsed: { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(outcome.stdout) as typeof parsed;
  } catch {
    throw new JobError('读不出视频信息，文件可能损坏', `ffprobe 输出无法解析：${outcome.stdout.slice(0, 500)}`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video) throw new JobError('这个文件里没有视频轨，没法做放大或补帧', path);
  const durationSec = Number(parsed.format?.duration ?? video.duration ?? 0);
  const fps = parseFrameRate(video.avg_frame_rate) ?? parseFrameRate(video.r_frame_rate) ?? 0;
  const declared = Number(video.nb_frames);
  const frameCount = Number.isFinite(declared) && declared > 0 ? declared : Math.round((Number.isFinite(durationSec) ? durationSec : 0) * fps);
  return {
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    fps,
    frameCount,
    width: typeof video.width === 'number' ? video.width : undefined,
    height: typeof video.height === 'number' ? video.height : undefined,
    hasAudio: Boolean(audio),
  };
}

/** 处理后的帧目录里，第一个文件的扩展名决定合段时用什么通配符。 */
async function discoverFramePattern(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  const extensions = entries.map(frameFileExtension).filter((ext): ext is string => Boolean(ext)).sort();
  if (extensions.length === 0) return undefined;
  return join(dir, `%08d${extensions[0]}`);
}

async function countFrames(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => Boolean(frameFileExtension(name))).length;
  } catch {
    return 0;
  }
}

interface VideoPipelineConfig {
  kind: 'upscaleVideo' | 'interpolateVideo';
  /** 倍率：放大是像素倍数，补帧是帧率倍数。 */
  multiplier: number;
  /** 输出帧率 = 源帧率 × 这个倍率（放大保持原帧率）。 */
  fpsMultiplier: number;
  source: Asset['source'];
  outputSuffix: string;
  /** 中途显示的动词，如「放大」「补帧」。 */
  verb: string;
  /** 执行一批帧，输入输出都是目录。 */
  processBatch: (ctx: JobContext, batch: FrameBatch, inDir: string, outDir: string, upto: number, total: number) => Promise<void>;
}

async function runVideoPipeline(ctx: JobContext, state: WorkspaceState, assets: Asset[], config: VideoPipelineConfig): Promise<string[]> {
  const results: string[] = [];
  for (const [index, asset] of assets.entries()) {
    throwIfCancelled(ctx);
    const { base, span } = spanOf(index, assets.length);
    results.push(await videoPipelineOne(ctx, state, asset, config, base, span, index, assets.length));
  }
  return results;
}

async function videoPipelineOne(ctx: JobContext, state: WorkspaceState, asset: Asset, config: VideoPipelineConfig, base: number, span: number, index: number, total: number): Promise<string> {
  if (asset.kind !== 'video') throw new JobError('这个任务只能对视频素材使用，请选择视频素材');
  const source = assetAbsolutePath(state, asset);
  if (!existsSync(source)) throw new JobError('素材文件找不到了，可能被移动或删除，请重新导入', source);
  const prefix = total > 1 ? `第 ${index + 1}/${total} 个视频：` : '';

  report(ctx, { progress: base, statusText: `${prefix}正在读取视频信息…` });
  const probe = await probeVideo(ctx, source);
  if (!probe.fps || probe.fps <= 0) throw new JobError('读不出这个视频的帧率，无法分块处理', 'ffprobe 的 avg_frame_rate / r_frame_rate 都是 0');
  if (!probe.frameCount || probe.frameCount <= 0) throw new JobError('读不出这个视频的总帧数，无法分块处理', `duration=${probe.durationSec} fps=${probe.fps}`);
  if (config.kind === 'interpolateVideo' && probe.fps > UNNECESSARY_INTERPOLATE_FPS) {
    throw new JobError(`这个视频已经是 ${formatFramerate(probe.fps)} fps，没必要补帧。补帧只对低帧率视频有意义。`, `源帧率超过 ${UNNECESSARY_INTERPOLATE_FPS} fps`);
  }

  const totalFrames = probe.frameCount;
  const outputFrames = Math.round(totalFrames * config.fpsMultiplier);
  const needBytes = estimateSpaceBytes(outputFrames);
  const free = await freeSpaceBytes(ctx.root);
  if (free !== undefined && isSpaceInsufficient(needBytes, free)) {
    throw new JobError(
      `磁盘空间不够：这次${config.verb}大约需要 ${formatGigabytes(needBytes)} 中间文件空间，工作区所在的盘只剩 ${formatGigabytes(free)} 可用。请先清理磁盘，或把工作区换到空间更大的盘。`,
      `需要约 ${needBytes} 字节，可用 ${free} 字节；超过可用空间 50% 的任务一律拒绝（AGENTS.md 磁盘红线）`,
    );
  }

  const ffmpeg = resolveFfmpeg(ctx.root);
  const tempRoot = projectTempDir(ctx.root, asset.projectId);
  const framesRoot = join(tempRoot, 'frames');
  const processedRoot = join(tempRoot, 'frames_up');
  const segmentRoot = join(tempRoot, 'segments');
  const batches = planFrameBatches(totalFrames, DEFAULT_BATCH_FRAMES);
  // 上次异常退出可能留下中间文件，先清干净再开始。
  await rm(tempRoot, { recursive: true, force: true });
  for (const dir of [framesRoot, processedRoot, segmentRoot]) await mkdir(dir, { recursive: true });

  const startedAt = Date.now();
  const reportFrames = (framesDone: number, extra?: string) => {
    const inner = totalFrames > 0 ? Math.min(1, framesDone / totalFrames) : 0;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const remaining = framesDone > 0 && framesDone < totalFrames ? `预计剩余 ${formatDurationCn((elapsedSec / framesDone) * (totalFrames - framesDone))}` : '预计马上完成';
    report(ctx, {
      progress: base + span * inner,
      statusText: `${prefix}第 ${framesDone}/${totalFrames} 帧 · 已用 ${formatDurationCn(elapsedSec)} · ${remaining}${extra ? ` · ${extra}` : ''}`,
    });
  };

  const segments: string[] = [];
  let framesDone = 0;
  for (const batch of batches) {
    throwIfCancelled(ctx);
    const inDir = join(framesRoot, String(batch.index).padStart(4, '0'));
    const outDir = join(processedRoot, String(batch.index).padStart(4, '0'));
    const segmentPath = join(segmentRoot, `${String(batch.index).padStart(4, '0')}.mp4`);
    await mkdir(inDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    const batchNote = `第 ${batch.index}/${batches.length} 批`;

    // 1. 抽这一批的帧（JPEG，不是 PNG）
    reportFrames(framesDone, `${batchNote} 正在抽帧`);
    await runChild(ctx, ffmpeg, buildBatchExtractArgs(source, join(inDir, '%08d.jpg'), batch.startFrame, batch.frameCount, probe.fps), {
      onStdout: (chunk) => {
        const frames = parseFrameCount(chunk);
        if (frames !== undefined) reportFrames(framesDone + Math.min(frames, batch.frameCount), `${batchNote} 正在抽帧`);
      },
    });
    const extracted = await countFrames(inDir);
    if (extracted === 0) throw new JobError(`第 ${batch.index} 批没有抽出任何帧，视频可能损坏`, `抽帧目录：${inDir}`);

    // 2. 处理这一批
    await config.processBatch(ctx, batch, inDir, outDir, framesDone, totalFrames);

    // 3. 立刻合回视频段
    const pattern = await discoverFramePattern(outDir);
    if (!pattern) throw new JobError(`${config.verb}工具没有产出任何图片，请检查模型是否完整`, `输出目录：${outDir}`);
    const framerate = config.kind === 'upscaleVideo' ? probe.fps : interpolatedFps(probe.fps, config.multiplier);
    await runChild(ctx, ffmpeg, buildSegmentArgs(pattern, framerate, segmentPath), {
      onStdout: (chunk) => {
        // 已有精确的帧数进度，这里只是让进度动起来，所以不额外解析 out_time。
        if (parseFfmpegProgress(chunk, extracted / framerate) !== undefined) reportFrames(framesDone + extracted, `${batchNote} 正在合成`);
      },
    });
    segments.push(segmentPath);

    // 4. 这一批的中间帧立刻删掉：磁盘峰值只和「一批」有关，和整片长度无关
    await rm(inDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
    framesDone += extracted;
    reportFrames(framesDone, `${batchNote} 已完成`);
  }

  if (segments.length === 0) throw new JobError('没有生成任何视频片段，任务已中止', `总帧数 ${totalFrames}`);

  // 5. 拼接所有片段
  reportFrames(framesDone, '正在拼接视频');
  const listFile = join(tempRoot, 'segments.txt');
  writeFileSync(listFile, `${segments.map(concatListLine).join('\n')}\n`, 'utf8');
  const merged = join(tempRoot, `merged-${nanoid(6)}.mp4`);
  await runChild(ctx, ffmpeg, buildConcatArgs(listFile, merged));

  // 6. 从原视频复制音轨（无音轨时靠 -map 1:a? 跳过，不报错）
  report(ctx, { progress: base + span * 0.98, statusText: `${prefix}正在复制音轨…` });
  const finalOutput = join(tempRoot, `result-${nanoid(6)}.mp4`);
  await runChild(ctx, ffmpeg, buildMuxAudioArgs(merged, source, finalOutput, probe.hasAudio));
  if (!existsSync(finalOutput)) throw new JobError('输出文件没有生成', `预期输出：${finalOutput}`);

  const registered = await registerGeneratedAsset(ctx.root, asset.projectId, finalOutput, `${displayBaseName(asset.originalName)}-${config.outputSuffix}.mp4`, config.source);
  // 7. 清空 temp（PRD E2 第 7 步）
  await rm(tempRoot, { recursive: true, force: true });
  report(ctx, { progress: base + span, statusText: `${prefix}${config.verb}完成${probe.hasAudio ? '' : '（原视频没有音轨，已跳过音频）'}` });
  return registered.id;
}

async function runVideoUpscale(ctx: JobContext, state: WorkspaceState, assets: Asset[]): Promise<string[]> {
  const tool = resolveRealesrgan(ctx.root);
  const modelsDir = resolveModelsDir(ctx.root);
  const model = readString(ctx.job.options?.model) ?? DEFAULT_UPSCALE_MODEL;
  const scale = Math.max(1, Math.min(8, Math.round(readNumber(ctx.job.options?.scale, DEFAULT_UPSCALE_SCALE))));
  const requestedTile = Math.round(readNumber(ctx.job.options?.tile, DEFAULT_TILE));
  return runVideoPipeline(ctx, state, assets, {
    kind: 'upscaleVideo',
    multiplier: scale,
    fpsMultiplier: 1,
    source: 'upscaled',
    outputSuffix: `放大${scale}x`,
    verb: '放大',
    processBatch: async (batchCtx, batch, inDir, outDir, upto, total) => {
      let tile = requestedTile;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        throwIfCancelled(batchCtx);
        const outcome = await runChild(batchCtx, tool, buildRealEsrganArgs({ input: inDir, output: outDir, model, scale, tile, modelPath: modelsDir }), {
          cwd: dirname(tool),
          allowFailure: true,
          onStderr: (chunk) => {
            const inner = parseNcnnProgress(chunk);
            if (inner !== undefined) report(batchCtx, { statusText: `第 ${upto}/${total} 帧 · 第 ${batch.index} 批正在放大，预计 ${Math.round(inner * 100)}%` });
          },
        });
        if (outcome.ok) return;
        if (attempt === 0 && isGpuMemoryError(`${outcome.stderr}\n${outcome.stdout}`)) {
          tile = halveTile(tile);
          continue;
        }
        throw new JobError(`第 ${batch.index} 批放大失败，请把 tile 调小后重试`, shortStderr(outcome.stderr));
      }
    },
  });
}

async function runVideoInterpolate(ctx: JobContext, state: WorkspaceState, assets: Asset[]): Promise<string[]> {
  const tool = resolveRife(ctx.root);
  const model = readString(ctx.job.options?.model) ?? DEFAULT_RIFE_MODEL;
  const multiplier = Math.round(readNumber(ctx.job.options?.multiplier, DEFAULT_INTERPOLATE_MULTIPLIER));
  // RIFE 的 -n 只接受 2 的幂，不如直接拒绝而不是偷偷改掉用户选的倍率。
  if (![2, 4, 8].includes(multiplier)) throw new JobError('补帧倍率只支持 2 倍、4 倍、8 倍', `收到的倍率：${String(ctx.job.options?.multiplier)}`);
  return runVideoPipeline(ctx, state, assets, {
    kind: 'interpolateVideo',
    multiplier,
    fpsMultiplier: multiplier,
    source: 'interpolated',
    outputSuffix: `补帧${multiplier}x`,
    verb: '补帧',
    processBatch: async (batchCtx, batch, inDir, outDir) => {
      // -n 是目标总帧数：这一批输入 batch.frameCount 帧，目标是倍率倍
      const target = batch.frameCount * multiplier;
      const outcome = await runChild(batchCtx, tool, buildRifeArgs(inDir, outDir, model, target), { cwd: dirname(tool), allowFailure: true });
      if (!outcome.ok) throw new JobError(`第 ${batch.index} 批补帧失败`, shortStderr(outcome.stderr));
    },
  });
}
