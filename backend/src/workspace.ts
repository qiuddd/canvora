import { mkdir, readFile, stat, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Asset, AssetKind, AssetMetadata, Project, WorkspaceState } from '@canvora/shared';
import { probeMedia } from './media/media.js';

export type { WorkspaceState };

const stateFile = (root: string) => join(root, 'canvora-state.json');

export async function ensureWorkspace(root: string): Promise<WorkspaceState> {
  for (const path of ['bin', 'models', 'luts', 'cache/thumbs', 'projects', 'logs']) await mkdir(join(root, path), { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(stateFile(root), 'utf8')) as WorkspaceState;
    return { root, projects: parsed.projects ?? [], assets: parsed.assets ?? [] };
  } catch {
    const now = Date.now();
    const state: WorkspaceState = { root, projects: [{ id: nanoid(), name: '未命名项目', createdAt: now, updatedAt: now, viewport: { x: 0, y: 0, zoom: 1 } }], assets: [] };
    await saveState(state);
    return state;
  }
}

export async function saveState(state: WorkspaceState) {
  await mkdir(dirname(stateFile(state.root)), { recursive: true });
  await writeFile(stateFile(state.root), JSON.stringify(state, null, 2), 'utf8');
}

export function classifyAsset(fileName: string): AssetKind | null {
  const ext = extname(fileName).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.aac', '.m4a'].includes(ext)) return 'audio';
  return null;
}

const parseFps = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !value.includes('/')) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!denominator) return undefined;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : undefined;
};

/** 读取媒体元信息。图片、音频、视频都可能缺少部分字段，失败时返回空对象而不是抛错。 */
async function readMetadata(absolutePath: string, ffprobe?: string): Promise<AssetMetadata> {
  try {
    const probe = await probeMedia(absolutePath, ffprobe);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(probe.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
    return {
      width: typeof video?.width === 'number' ? video.width : undefined,
      height: typeof video?.height === 'number' ? video.height : undefined,
      durationSec: Number.isFinite(duration) && duration > 0 ? Number(duration.toFixed(3)) : undefined,
      fps: parseFps(video?.avg_frame_rate ?? video?.r_frame_rate),
      codec: typeof video?.codec_name === 'string' ? video.codec_name : typeof audio?.codec_name === 'string' ? audio.codec_name : undefined,
      hasAudio: Boolean(audio),
    };
  } catch {
    return {};
  }
}

async function registerAsset(state: WorkspaceState, projectId: string, originalName: string, sourceFile: string, ffprobe?: string): Promise<Asset> {
  const kind = classifyAsset(originalName);
  if (!kind) throw new Error('不支持的素材格式，仅支持常见图片、视频和音频文件');

  const info = await stat(sourceFile);
  const hash = createHash('sha256').update(await readFile(sourceFile)).digest('hex');
  const existing = state.assets.find((asset) => asset.hash === hash);
  if (existing) return existing;

  const id = nanoid();
  const ext = extname(originalName).toLowerCase();
  const relPath = join('projects', projectId, 'assets', `${id}${ext}`).replaceAll('\\', '/');
  const destination = join(state.root, relPath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourceFile, destination);

  const metadata = await readMetadata(destination, ffprobe);
  const asset: Asset = {
    id, projectId, kind, originalName, relPath, ext, sizeBytes: info.size, createdAt: Date.now(),
    tags: [], favorite: false, proxyStatus: kind === 'video' ? 'pending' : 'none', hash, ...metadata,
  };
  state.assets.push(asset);
  await saveState(state);
  return asset;
}

/** 从服务器本地路径导入（用于桌面端或已有素材）。 */
export async function importAsset(state: WorkspaceState, projectId: string, sourcePath: string): Promise<Asset> {
  return registerAsset(state, projectId, sourcePath.split(/[\\/]/).pop() ?? 'asset', sourcePath);
}

/** 从浏览器上传的临时文件导入。调用方负责在结束后删除临时文件。 */
export async function importAssetFromUpload(state: WorkspaceState, projectId: string, originalName: string, tempPath: string): Promise<Asset> {
  const safeName = originalName.split(/[\\/]/).pop() ?? 'asset';
  return registerAsset(state, projectId, safeName, tempPath);
}

export function assetAbsolutePath(state: WorkspaceState, asset: Asset) {
  return join(state.root, asset.relPath);
}

export async function moveIntoWorkspace(state: WorkspaceState, tempPath: string, projectId: string, originalName: string) {
  const ext = extname(originalName).toLowerCase();
  const target = join(state.root, 'projects', projectId, 'assets', `${nanoid()}${ext}`);
  await mkdir(dirname(target), { recursive: true });
  await rename(tempPath, target);
  return target;
}

export async function removeFileIfExists(path: string) {
  await rm(path, { force: true });
}

export function defaultProjectId(state: WorkspaceState): string {
  if (state.projects.length === 0) {
    const now = Date.now();
    const project: Project = { id: nanoid(), name: '未命名项目', createdAt: now, updatedAt: now, viewport: { x: 0, y: 0, zoom: 1 } };
    state.projects.push(project);
  }
  return state.projects[0].id;
}
