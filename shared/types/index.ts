export type NodeKind = 'prompt' | 'text' | 'image' | 'video' | 'audio' | 'generateImage' | 'generateVideo' | 'llm' | 'upscale' | 'interpolate' | 'extractFrame' | 'splitImage' | 'group' | 'note';
export type PortKind = 'text' | 'image' | 'video' | 'audio' | 'any';

export interface CanvasViewport { x: number; y: number; zoom: number }
export interface Project { id: string; name: string; createdAt: number; updatedAt: number; viewport: CanvasViewport }
export interface CanvasNode { id: string; projectId: string; kind: NodeKind; x: number; y: number; width: number; height: number; title: string; data: Record<string, unknown>; createdAt: number; updatedAt: number }
export interface Edge { id: string; projectId: string; fromNodeId: string; fromPortId: string; toNodeId: string; toPortId: string; kind: PortKind; createdAt: number }

/** 画布上的打组框：只记录成员 id，位置和大小由成员自动算出来。 */
export interface NodeGroup { id: string; projectId: string; title: string; color: string; collapsed: boolean; memberIds: string[] }
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
  /** 素材分组，null 表示未分组。 */
  groupId?: string | null;
  /** 产生方式，用于素材库筛选。 */
  source?: 'imported' | 'exportedFrame' | 'upscaled' | 'interpolated' | 'split' | 'exported';
}

export interface AssetGroup { id: string; projectId: string; name: string; createdAt: number }

/** 一个项目的画布内容（节点、连线、画布内打组）。 */
export interface CanvasSnapshot { nodes: CanvasNode[]; edges: Edge[]; nodeGroups?: NodeGroup[] }

export interface WorkspaceState { root: string; projects: Project[]; assets: Asset[]; groups?: AssetGroup[]; canvases?: Record<string, CanvasSnapshot> }

/** 连线尝试的结果，用于界面给出中文提示。 */
export type ConnectResult = 'ok' | 'self' | 'cycle' | 'duplicate' | 'replaced';

export type JobKind = 'exportFrames' | 'upscaleImage' | 'upscaleVideo' | 'interpolateVideo' | 'splitImage' | 'exportTimeline';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  statusText: string;
  /** 参与的素材（批量任务会有多个）。 */
  assetIds: string[];
  resultAssetIds: string[];
  errorMessage?: string;
  errorDetail?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ToolStatus { ffmpeg: boolean; ffprobe: boolean; realesrgan: boolean; rife: boolean }

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatTextPart { type: 'text'; text: string }
export interface ChatImagePart { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
export type ChatContent = string | Array<ChatTextPart | ChatImagePart>
export interface ChatMessage { role: ChatRole; content: ChatContent }
export interface ChatReply { content: string; model: string; usage?: { promptTokens: number; completionTokens: number } }

export interface ProviderSummary { id: string; name: string; protocol: string; baseUrl: string; hasKey: boolean; models: string[]; createdAt: number }
