import { mkdir, readFile, stat, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Asset, AssetGroup, AssetKind, AssetMetadata, CanvasSnapshot, Project, WorkspaceState } from '@canvora/shared';
import { probeMedia } from './media/media.js';

export type { WorkspaceState };

const stateFile = (root: string) => join(root, 'canvora-state.json');

/**
 * 每个工作区一条串行队列。
 * 工作区状态是单个 JSON 文件，读-改-写如果不串行化，后台任务写产物和接口写数据会互相覆盖
 * （实测出现过「刚建好的素材分组被任务写回旧状态冲掉」）。
 */
const workspaceLocks = new Map<string, Promise<unknown>>();

function withWorkspaceLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = workspaceLocks.get(root) ?? Promise.resolve();
  const run = previous.then(task, task);
  workspaceLocks.set(root, run.then(() => undefined, () => undefined));
  return run;
}

/** 在锁保护下完成「读取 → 修改 → 保存」，所有会改变工作区的操作都必须走这里。 */
export async function mutateWorkspace<T>(root: string, mutator: (state: WorkspaceState) => Promise<T> | T): Promise<T> {
  return withWorkspaceLock(root, async () => {
    const state = await ensureWorkspace(root);
    const result = await mutator(state);
    await saveState(state);
    return result;
  });
}

/** 分块算哈希：放大后的视频可能几百 MB，整块读进内存会直接吃掉同样大的内存。 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function ensureWorkspace(root: string): Promise<WorkspaceState> {
  for (const path of ['bin', 'models', 'luts', 'cache/thumbs', 'projects', 'logs']) await mkdir(join(root, path), { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(stateFile(root), 'utf8')) as WorkspaceState;
    return { root, projects: parsed.projects ?? [], assets: parsed.assets ?? [], groups: parsed.groups ?? [], canvases: parsed.canvases ?? {} };
  } catch {
    // 首次使用不自动建项目：界面要求用户先新建项目再进入画布。
    return { root, projects: [], assets: [], groups: [], canvases: {} };
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
export async function readMetadata(absolutePath: string, ffprobe?: string): Promise<AssetMetadata> {
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

export function projectDirectory(state: WorkspaceState, projectId: string) {
  return join(state.root, 'projects', projectId);
}

export function assetAbsolutePath(state: WorkspaceState, asset: Asset) {
  return join(state.root, asset.relPath);
}

export function assetById(state: WorkspaceState, id: string): Asset | undefined {
  return state.assets.find((asset) => asset.id === id);
}

export async function removeFileIfExists(path: string) {
  await rm(path, { force: true });
}

export async function removeDirectory(path: string) {
  await rm(path, { recursive: true, force: true });
}

export async function ensureProjectDirectories(state: WorkspaceState, projectId: string) {
  for (const sub of ['assets', 'proxy', 'exports', 'temp']) await mkdir(join(projectDirectory(state, projectId), sub), { recursive: true });
}

// ── 素材登记 ──────────────────────────────────────────
interface RegisterOptions { move?: boolean; source?: Asset['source'] }

async function registerAssetInState(state: WorkspaceState, projectId: string, originalName: string, sourceFile: string, hash: string, size: number, options: RegisterOptions): Promise<Asset> {
  const kind = classifyAsset(originalName);
  if (!kind) throw new Error('不支持的素材格式，仅支持常见图片、视频和音频文件');
  const existing = state.assets.find((asset) => asset.hash === hash && asset.projectId === projectId);
  if (existing) return existing;

  const id = nanoid();
  const ext = extname(originalName).toLowerCase();
  const relPath = join('projects', projectId, 'assets', `${id}${ext}`).replaceAll('\\', '/');
  const destination = join(state.root, relPath);
  await mkdir(dirname(destination), { recursive: true });
  if (options.move) await rename(sourceFile, destination);
  else await copyFile(sourceFile, destination);

  const metadata = await readMetadata(destination);
  const asset: Asset = {
    id, projectId, kind, originalName, relPath, ext, sizeBytes: size, createdAt: Date.now(),
    tags: [], favorite: false, proxyStatus: kind === 'video' ? 'pending' : 'none', hash,
    groupId: null, source: options.source ?? 'imported', ...metadata,
  };
  state.assets.push(asset);
  return asset;
}

/** 从服务器本地路径导入（用于桌面端或已有素材）。 */
export async function importAsset(root: string, projectId: string, sourcePath: string): Promise<Asset> {
  const info = await stat(sourcePath);
  const hash = await hashFile(sourcePath);
  const name = sourcePath.split(/[\\/]/).pop() ?? 'asset';
  return mutateWorkspace(root, (state) => registerAssetInState(state, projectId, name, sourcePath, hash, info.size, {}));
}

/** 从浏览器上传的临时文件导入。调用方负责在结束后删除临时文件。 */
export async function importAssetFromUpload(root: string, projectId: string, originalName: string, tempPath: string): Promise<Asset> {
  const info = await stat(tempPath);
  const hash = await hashFile(tempPath);
  const safeName = originalName.split(/[\\/]/).pop() ?? 'asset';
  return mutateWorkspace(root, (state) => registerAssetInState(state, projectId, safeName, tempPath, hash, info.size, {}));
}

/** 把工具产生的文件登记成素材（文件已经在工作区内，直接移动）。 */
export async function registerGeneratedAsset(root: string, projectId: string, producedFile: string, displayName: string, source: Asset['source']): Promise<Asset> {
  const info = await stat(producedFile);
  const hash = await hashFile(producedFile);
  return mutateWorkspace(root, (state) => registerAssetInState(state, projectId, displayName, producedFile, hash, info.size, { move: true, source }));
}

export async function deleteAsset(root: string, assetId: string): Promise<boolean> {
  return mutateWorkspace(root, async (state) => {
    const asset = assetById(state, assetId);
    if (!asset) return false;
    const absolute = assetAbsolutePath(state, asset);
    state.assets = state.assets.filter((item) => item.id !== assetId);
    await removeFileIfExists(absolute).catch(() => undefined);
    return true;
  });
}

// ── 项目 ──────────────────────────────────────────────
export async function createProject(root: string, name: string): Promise<Project> {
  return mutateWorkspace(root, async (state) => {
    const now = Date.now();
    const project: Project = { id: nanoid(), name: name.trim() || '未命名项目', createdAt: now, updatedAt: now, viewport: { x: 0, y: 0, zoom: 1 } };
    state.projects.push(project);
    await ensureProjectDirectories(state, project.id);
    return project;
  });
}

export async function renameProject(root: string, projectId: string, name: string): Promise<Project | undefined> {
  return mutateWorkspace(root, (state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return undefined;
    project.name = name.trim() || project.name;
    project.updatedAt = Date.now();
    return project;
  });
}

export interface ProjectDeletion { project?: Project; fileCount: number; totalBytes: number }

export async function deleteProject(root: string, projectId: string): Promise<ProjectDeletion> {
  return mutateWorkspace(root, async (state) => {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return { fileCount: 0, totalBytes: 0 };
    const assets = state.assets.filter((asset) => asset.projectId === projectId);
    const totalBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
    state.assets = state.assets.filter((asset) => asset.projectId !== projectId);
    state.groups = (state.groups ?? []).filter((group) => group.projectId !== projectId);
    state.projects = state.projects.filter((item) => item.id !== projectId);
    if (state.canvases) delete state.canvases[projectId];
    const directory = projectDirectory(state, projectId);
    await removeDirectory(directory).catch(() => undefined);
    return { project, fileCount: assets.length, totalBytes };
  });
}

// ── 素材分组 ──────────────────────────────────────────
export async function createGroup(root: string, projectId: string, name: string, assetIds: string[] = []): Promise<AssetGroup> {
  return mutateWorkspace(root, (state) => {
    const group: AssetGroup = { id: nanoid(), projectId, name: name.trim() || '新建分组', createdAt: Date.now() };
    state.groups = [...(state.groups ?? []), group];
    for (const asset of state.assets) if (asset.projectId === projectId && assetIds.includes(asset.id)) asset.groupId = group.id;
    return group;
  });
}

export async function assignAssetsToGroup(root: string, groupId: string | null, assetIds: string[]): Promise<void> {
  await mutateWorkspace(root, (state) => {
    for (const asset of state.assets) if (assetIds.includes(asset.id)) asset.groupId = groupId;
  });
}

export async function removeGroup(root: string, groupId: string): Promise<void> {
  await mutateWorkspace(root, (state) => {
    state.groups = (state.groups ?? []).filter((group) => group.id !== groupId);
    for (const asset of state.assets) if (asset.groupId === groupId) asset.groupId = null;
  });
}

// ── 画布快照 ──────────────────────────────────────────
export function readCanvas(state: WorkspaceState, projectId: string): CanvasSnapshot {
  return state.canvases?.[projectId] ?? { nodes: [], edges: [] };
}

export async function writeCanvas(root: string, projectId: string, snapshot: CanvasSnapshot): Promise<void> {
  await mutateWorkspace(root, (state) => {
    state.canvases = { ...(state.canvases ?? {}), [projectId]: snapshot };
    const project = state.projects.find((item) => item.id === projectId);
    if (project) project.updatedAt = Date.now();
  });
}
