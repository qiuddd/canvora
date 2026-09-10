export type NodeKind = 'prompt' | 'text' | 'image' | 'video' | 'audio' | 'generateImage' | 'generateVideo' | 'llm' | 'upscale' | 'interpolate' | 'extractFrame' | 'note';
export type PortKind = 'text' | 'image' | 'video' | 'audio' | 'any';

export interface CanvasViewport { x: number; y: number; zoom: number }
export interface Project { id: string; name: string; createdAt: number; updatedAt: number; viewport: CanvasViewport }
export interface CanvasNode { id: string; projectId: string; kind: NodeKind; x: number; y: number; width: number; height: number; title: string; data: Record<string, unknown>; createdAt: number; updatedAt: number }
export interface Edge { id: string; projectId: string; fromNodeId: string; fromPortId: string; toNodeId: string; toPortId: string; kind: PortKind; createdAt: number }
export interface HealthResponse { ok: true; service: 'canvora-backend'; version: string; timestamp: string }
export interface ApiError { message: string; detail?: string }

export type AssetKind = 'image' | 'video' | 'audio';

export interface AssetMetadata {
  width?: number;
  height?: number;
  durationSec?: number;
  fps?: number;
  codec?: string;
  hasAudio?: boolean;
}

export interface Asset extends AssetMetadata {
  id: string;
  projectId: string;
  kind: AssetKind;
  originalName: string;
  relPath: string;
  ext: string;
  sizeBytes: number;
  createdAt: number;
  tags: string[];
  favorite: boolean;
  proxyStatus: 'none' | 'pending' | 'ready' | 'failed';
  hash?: string;
}

export interface WorkspaceState { root: string; projects: Project[]; assets: Asset[] }

/** 连线尝试的结果，用于界面给出中文提示。 */
export type ConnectResult = 'ok' | 'self' | 'cycle' | 'duplicate' | 'replaced';
