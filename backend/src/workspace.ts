import { mkdir, readFile, stat, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative } from 'node:path';
import { nanoid } from 'nanoid';
import type { Asset, AssetKind, Project } from '@canvora/shared';

export interface WorkspaceState { root: string; projects: Project[]; assets: Asset[] }
const stateFile = (root: string) => join(root, 'canvora-state.json');

export async function ensureWorkspace(root: string): Promise<WorkspaceState> {
  for (const path of ['bin', 'models', 'luts', 'cache/thumbs', 'projects', 'logs']) await mkdir(join(root, path), { recursive: true });
  try { return JSON.parse(await readFile(stateFile(root), 'utf8')) as WorkspaceState; } catch { const now = Date.now(); const state = { root, projects: [{ id: nanoid(), name: '未命名项目', createdAt: now, updatedAt: now, viewport: { x: 0, y: 0, zoom: 1 } }], assets: [] }; await saveState(state); return state; }
}
export async function saveState(state: WorkspaceState) { await mkdir(dirname(stateFile(state.root)), { recursive: true }); await writeFile(stateFile(state.root), JSON.stringify(state, null, 2), 'utf8'); }
export function classifyAsset(fileName: string): AssetKind | null { const ext = extname(fileName).toLowerCase(); if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'image'; if (['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(ext)) return 'video'; if (['.mp3', '.wav', '.aac', '.m4a'].includes(ext)) return 'audio'; return null; }
export async function importAsset(state: WorkspaceState, projectId: string, sourcePath: string): Promise<Asset> { const kind = classifyAsset(sourcePath); if (!kind) throw new Error('不支持的素材格式'); const info = await stat(sourcePath); const hash = createHash('sha256').update(await readFile(sourcePath)).digest('hex'); const duplicate = state.assets.find((asset) => asset.projectId === projectId && asset.tags.includes(`sha256:${hash}`)); if (duplicate) return duplicate; const id = nanoid(); const ext = extname(sourcePath).toLowerCase(); const relPath = join('projects', projectId, 'assets', `${id}${ext}`).replaceAll('\\', '/'); const destination = join(state.root, relPath); await mkdir(dirname(destination), { recursive: true }); await copyFile(sourcePath, destination); const asset: Asset = { id, projectId, kind, originalName: sourcePath.split(/[\\/]/).pop() ?? id, relPath, ext, sizeBytes: info.size, createdAt: Date.now(), tags: [`sha256:${hash}`], favorite: false, proxyStatus: kind === 'video' ? 'pending' : 'none' }; state.assets.push(asset); await saveState(state); return asset; }
export function assetAbsolutePath(state: WorkspaceState, asset: Asset) { return join(state.root, asset.relPath); }
