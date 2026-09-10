import { create } from 'zustand';
import type { CanvasNode, CanvasSnapshot, ConnectResult, Edge, NodeKind, PortKind } from '@canvora/shared';

interface CanvasState {
  nodes: CanvasNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  addNode: (kind: NodeKind, position?: { x: number; y: number }, data?: Record<string, unknown>) => string;
  moveNode: (id: string, x: number, y: number) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  selectNode: (id: string | null) => void;
  deleteNode: (id: string) => void;
  duplicateNode: (id: string) => string | null;
  connect: (fromNodeId: string, fromPortId: string, toNodeId: string, toPortId: string, kind: PortKind, multiple: boolean) => ConnectResult;
  deleteEdge: (id: string) => void;
  replaceAll: (snapshot: CanvasSnapshot) => void;
  snapshot: () => CanvasSnapshot;
}

const TITLES: Record<NodeKind, string> = { prompt: '提示词', text: '文本', image: '图片素材', video: '视频素材', audio: '音频素材', generateImage: '生图', generateVideo: '生视频', llm: 'AI 文本', upscale: '图片放大', interpolate: '视频补帧', extractFrame: '抽帧', note: '便利贴' };

/** 判断从 from 出发能否走到 target，用于连线前的环检测。 */
function reaches(edges: Edge[], from: string, target: string, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return edges.filter((edge) => edge.fromNodeId === from).some((edge) => reaches(edges, edge.toNodeId, target, seen));
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,

  addNode: (kind, position, data) => {
    const state = get();
    const now = Date.now();
    const id = crypto.randomUUID();
    const node: CanvasNode = {
      id, projectId: 'local', kind,
      // 按网格排布，避免新节点盖住已有节点的端口
      x: position?.x ?? 140 + (state.nodes.length % 3) * 320,
      y: position?.y ?? 80 + Math.floor(state.nodes.length / 3) * 300,
      width: 260,
      height: kind === 'image' || kind === 'video' ? 220 : 170,
      title: TITLES[kind],
      data: data ?? (kind === 'prompt' || kind === 'text' || kind === 'note' ? { text: '' } : {}),
      createdAt: now, updatedAt: now,
    };
    set({ nodes: [...state.nodes, node], selectedNodeId: id });
    return id;
  },

  moveNode: (id, x, y) => set((state) => ({ nodes: state.nodes.map((node) => node.id === id ? { ...node, x, y, updatedAt: Date.now() } : node) })),

  updateNodeData: (id, patch) => set((state) => ({ nodes: state.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch }, updatedAt: Date.now() } : node) })),

  selectNode: (selectedNodeId) => set({ selectedNodeId }),

  deleteNode: (id) => set((state) => ({
    nodes: state.nodes.filter((node) => node.id !== id),
    edges: state.edges.filter((edge) => edge.fromNodeId !== id && edge.toNodeId !== id),
    selectedNodeId: state.selectedNodeId === id ? null : state.selectedNodeId,
  })),

  duplicateNode: (id) => {
    const state = get();
    const source = state.nodes.find((node) => node.id === id);
    if (!source) return null;
    const now = Date.now();
    const copy: CanvasNode = { ...source, id: crypto.randomUUID(), x: source.x + 32, y: source.y + 32, createdAt: now, updatedAt: now };
    set({ nodes: [...state.nodes, copy], selectedNodeId: copy.id });
    return copy.id;
  },

  connect: (fromNodeId, fromPortId, toNodeId, toPortId, kind, multiple) => {
    const state = get();
    if (fromNodeId === toNodeId) return 'self';
    if (reaches(state.edges, toNodeId, fromNodeId)) return 'cycle';
    const alreadyLinked = state.edges.some((edge) => edge.fromNodeId === fromNodeId && edge.fromPortId === fromPortId && edge.toNodeId === toNodeId && edge.toPortId === toPortId);
    if (alreadyLinked) return 'duplicate';
    // 一个输入口只接一条线（标注“可多个”的端口除外），新连线替换旧连线。
    const kept = multiple ? state.edges : state.edges.filter((edge) => !(edge.toNodeId === toNodeId && edge.toPortId === toPortId));
    const replaced = kept.length !== state.edges.length;
    set({ edges: [...kept, { id: crypto.randomUUID(), projectId: 'local', fromNodeId, fromPortId, toNodeId, toPortId, kind, createdAt: Date.now() }] });
    return replaced ? 'replaced' : 'ok';
  },

  deleteEdge: (id) => set((state) => ({ edges: state.edges.filter((edge) => edge.id !== id) })),

  replaceAll: (snapshot) => set({ nodes: snapshot.nodes ?? [], edges: snapshot.edges ?? [], selectedNodeId: null }),

  snapshot: () => ({ nodes: get().nodes, edges: get().edges }),
}));
