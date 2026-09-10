export type NodeKind = 'prompt' | 'text' | 'image' | 'video' | 'generateImage' | 'generateVideo' | 'llm' | 'upscale' | 'interpolate' | 'extractFrame' | 'note';
export type PortKind = 'text' | 'image' | 'video' | 'audio' | 'any';

export interface CanvasViewport { x: number; y: number; zoom: number }
export interface Project { id: string; name: string; createdAt: number; updatedAt: number; viewport: CanvasViewport }
export interface CanvasNode { id: string; projectId: string; kind: NodeKind; x: number; y: number; width: number; height: number; title: string; data: Record<string, unknown>; createdAt: number; updatedAt: number }
export interface Edge { id: string; projectId: string; fromNodeId: string; fromPortId: string; toNodeId: string; toPortId: string; kind: PortKind; createdAt: number }
export interface HealthResponse { ok: true; service: 'canvora-backend'; version: string; timestamp: string }
export interface ApiError { message: string; detail?: string }
