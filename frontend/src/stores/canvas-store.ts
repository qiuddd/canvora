import { create } from 'zustand';
import type { CanvasNode, Edge, NodeKind, PortKind } from '@canvora/shared';

interface CanvasState {
  nodes: CanvasNode[];
  edges: Edge[];
  viewport: { x: number; y: number; zoom: number };
  selectedNodeId: string | null;
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => string;
  moveNode: (id: string, x: number, y: number) => void;
  setViewport: (viewport: CanvasState['viewport']) => void;
  selectNode: (id: string | null) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => string | null;
  connect: (fromNodeId: string, fromPortId: string, toNodeId: string, toPortId: string, kind?: PortKind) => void;
  deleteEdge: (id: string) => void;
}

const titles: Record<NodeKind, string> = { prompt: '提示词', text: '文本节点', image: '图片素材', video: '视频素材', generateImage: '生图', generateVideo: '生视频', llm: 'AI 文本', upscale: '图片放大', interpolate: '视频补帧', extractFrame: '抽帧', note: '备注' };

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, selectedNodeId: null,
  addNode: (kind, position) => {
    const state = get(); const now = Date.now(); const id = crypto.randomUUID();
    const node: CanvasNode = { id, projectId: 'local', kind, x: position?.x ?? 160 + state.nodes.length * 28, y: position?.y ?? 100 + state.nodes.length * 24, width: 260, height: 180, title: titles[kind], data: { text: '' }, createdAt: now, updatedAt: now };
    set({ nodes: [...state.nodes, node], selectedNodeId: id }); return id;
  },
  moveNode: (id, x, y) => set((state) => ({ nodes: state.nodes.map((node) => node.id === id ? { ...node, x, y, updatedAt: Date.now() } : node) })),
  setViewport: (viewport) => set({ viewport: { ...viewport, zoom: Math.min(2.5, Math.max(0.35, viewport.zoom)) } }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  deleteNode: (id) => set((state) => ({ nodes: state.nodes.filter((node) => node.id !== id), edges: state.edges.filter((edge) => edge.fromNodeId !== id && edge.toNodeId !== id), selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId })),
  duplicateNode: (id) => { const state = get(); const source = state.nodes.find((node) => node.id === id); if (!source) return null; const now = Date.now(); const copy = { ...source, id: crypto.randomUUID(), x: source.x + 32, y: source.y + 32, createdAt: now, updatedAt: now }; set({ nodes: [...state.nodes, copy], selectedNodeId: copy.id }); return copy.id; },
  connect: (fromNodeId, fromPortId, toNodeId, toPortId, kind = 'any') => set((state) => fromNodeId === toNodeId || state.edges.some((edge) => edge.fromNodeId === fromNodeId && edge.fromPortId === fromPortId && edge.toNodeId === toNodeId && edge.toPortId === toPortId) ? state : { edges: [...state.edges, { id: crypto.randomUUID(), projectId: 'local', fromNodeId, fromPortId, toNodeId, toPortId, kind, createdAt: Date.now() }] }),
  deleteEdge: (id) => set((state) => ({ edges: state.edges.filter((edge) => edge.id !== id) })),
}));
