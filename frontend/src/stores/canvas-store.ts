import { create } from 'zustand';
import type { CanvasNode, Edge, NodeKind, PortKind } from '@canvora/shared';

interface CanvasState { nodes: CanvasNode[]; edges: Edge[]; viewport: { x: number; y: number; zoom: number }; addNode: (kind: NodeKind, position?: { x: number; y: number }) => void; moveNode: (id: string, x: number, y: number) => void; setViewport: (viewport: CanvasState['viewport']) => void; connect: (fromNodeId: string, toNodeId: string, kind?: PortKind) => void }
export const useCanvasStore = create<CanvasState>((set) => ({
  nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  addNode: (kind, position) => set((state) => {
    const now = Date.now();
    const node: CanvasNode = { id: crypto.randomUUID(), projectId: 'local', kind, x: position?.x ?? 160 + state.nodes.length * 24, y: position?.y ?? 120 + state.nodes.length * 24, width: 260, height: 180, title: kind === 'prompt' ? '提示词' : kind === 'image' ? '图片素材' : kind === 'video' ? '视频素材' : '文本节点', data: { text: '' }, createdAt: now, updatedAt: now };
    return { nodes: [...state.nodes, node] };
  }),
  moveNode: (id, x, y) => set((state) => ({ nodes: state.nodes.map((node) => node.id === id ? { ...node, x, y, updatedAt: Date.now() } : node) })),
  setViewport: (viewport) => set({ viewport }),
  connect: (fromNodeId, toNodeId, kind = 'any') => set((state) => fromNodeId === toNodeId || state.edges.some((edge) => edge.fromNodeId === toNodeId && edge.toNodeId === fromNodeId) ? state : { edges: [...state.edges, { id: crypto.randomUUID(), projectId: 'local', fromNodeId, fromPortId: 'out', toNodeId, toPortId: 'in', kind, createdAt: Date.now() }] }),
}));
