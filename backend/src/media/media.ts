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
