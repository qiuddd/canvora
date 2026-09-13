import { join } from 'node:path';
import { runProcess, type ProcessResult } from './process.js';

export interface MediaToolPaths { ffmpeg: string; ffprobe: string }
export interface ProbeResult { format: Record<string, unknown>; streams: Array<Record<string, unknown>> }

export function buildFfprobeArgs(inputPath: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', inputPath];
}
export function buildProxyArgs(inputPath: string, outputPath: string): string[] {
  return ['-y', '-i', inputPath, '-vf', 'scale=-2:480', '-c:v', 'libx264', '-crf', '30', '-g', '30', '-c:a', 'aac', outputPath];
}
export function buildThumbnailArgs(inputPath: string, outputPath: string, atSeconds = 1): string[] {
  return ['-y', '-ss', String(Math.max(0, atSeconds)), '-i', inputPath, '-frames:v', '1', '-q:v', '2', outputPath];
}
export function buildExtractFrameArgs(inputPath: string, outputPath: string, atSeconds: number): string[] {
  return ['-y', '-i', inputPath, '-ss', String(Math.max(0, atSeconds)), '-frames:v', '1', '-q:v', '2', outputPath];
}
export function mediaToolPaths(workspaceRoot: string): MediaToolPaths {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return { ffmpeg: join(workspaceRoot, 'bin', `ffmpeg${suffix}`), ffprobe: join(workspaceRoot, 'bin', `ffprobe${suffix}`) };
}
export async function probeMedia(inputPath: string, ffprobe = 'ffprobe'): Promise<ProbeResult> {
  const result = await runProcess(ffprobe, buildFfprobeArgs(inputPath));
  if (result.exitCode !== 0) throw new Error(`媒体信息读取失败：${result.stderr.trim()}`);
  return JSON.parse(result.stdout) as ProbeResult;
}
export async function createProxy(inputPath: string, outputPath: string, ffmpeg = 'ffmpeg'): Promise<ProcessResult> {
  return runProcess(ffmpeg, buildProxyArgs(inputPath, outputPath));
}
export async function createThumbnail(inputPath: string, outputPath: string, atSeconds = 1, ffmpeg = 'ffmpeg'): Promise<ProcessResult> {
  return runProcess(ffmpeg, buildThumbnailArgs(inputPath, outputPath, atSeconds));
}
export async function extractFrame(inputPath: string, outputPath: string, atSeconds: number, ffmpeg = 'ffmpeg'): Promise<ProcessResult> {
  return runProcess(ffmpeg, buildExtractFrameArgs(inputPath, outputPath, atSeconds));
}

/** HTTP Range 解析结果：full = 无 Range 头，整文件 200；range = 分段 206；invalid = 头不合法或越界，416。 */
export type ParsedRange =
  | { kind: 'full' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'invalid' };

/**
 * 解析 `Range: bytes=...` 请求头（预览器拖进度条必须依赖 206 分段传输，否则视频流不可 seek）。
 * 支持 `bytes=start-end`、`bytes=start-`、`bytes=-suffix` 三种形式；end 越界按规范截到文件尾。
 */
export function parseRangeHeader(header: string | undefined, fileSize: number): ParsedRange {
  if (fileSize <= 0) return { kind: 'invalid' };
  if (!header) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return { kind: 'invalid' };
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'full' };
  if (rawStart === '') {
    // bytes=-N：最后 N 个字节
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return { kind: 'invalid' };
    return { kind: 'range', start: Math.max(0, fileSize - suffix), end: fileSize - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isInteger(start) || start >= fileSize) return { kind: 'invalid' };
  const end = rawEnd === '' ? fileSize - 1 : Math.min(Number(rawEnd), fileSize - 1);
  if (!Number.isInteger(end) || end < start) return { kind: 'invalid' };
  return { kind: 'range', start, end };
}
