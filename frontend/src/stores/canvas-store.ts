import { create } from 'zustand';
import type { CanvasNode, NodeKind } from '@canvora/shared';

interface CanvasState { nodes: CanvasNode[]; addNode: (kind: NodeKind) => void }
export const useCanvasStore = create<CanvasState>((set) => ({
  nodes: [],
  addNode: (kind) => set((state) => {
    const now = Date.now();
    const node: CanvasNode = { id: crypto.randomUUID(), projectId: 'local', kind, x: 160 + state.nodes.length * 24, y: 120 + state.nodes.length * 24, width: 260, height: 180, title: kind === 'prompt' ? '提示词' : kind === 'image' ? '图片素材' : kind === 'video' ? '视频素材' : '文本节点', data: { text: '' }, createdAt: now, updatedAt: now };
    return { nodes: [...state.nodes, node] };
  }),
}));
