import { create } from 'zustand';
import type { CanvasNode, CanvasSnapshot, ConnectResult, Edge, NodeGroup, NodeKind, PortKind } from '@canvora/shared';

interface CanvasState {
  nodes: CanvasNode[];
  edges: Edge[];
  nodeGroups: NodeGroup[];
  selectedNodeIds: string[];
  addNode: (kind: NodeKind, position?: { x: number; y: number }, data?: Record<string, unknown>) => string;
  moveNodes: (ids: string[], delta: { x: number; y: number }) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  setSelection: (ids: string[]) => void;
  toggleSelection: (id: string) => void;
  deleteSelection: () => void;
  duplicateSelection: () => string[];
  connect: (fromNodeId: string, fromPortId: string, toNodeId: string, toPortId: string, kind: PortKind, multiple: boolean) => ConnectResult;
  deleteEdge: (id: string) => void;
  createGroup: (title: string) => NodeGroup | null;
  removeGroup: (groupId: string) => void;
  toggleGroupCollapsed: (groupId: string) => void;
  replaceAll: (snapshot: CanvasSnapshot) => void;
  snapshot: () => CanvasSnapshot;
}

const TITLES: Record<NodeKind, string> = {
  prompt: '提示词', text: '文本', image: '图片素材', video: '视频素材', audio: '音频素材',
  generateImage: '生图', generateVideo: '生视频', llm: 'AI 文本', upscale: '图片放大',
  interpolate: '视频补帧', extractFrame: '抽帧', splitImage: '图片分割', group: '分组', note: '便利贴',
};

const GROUP_COLORS = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899'];

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
  nodeGroups: [],
  selectedNodeIds: [],

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
    set({ nodes: [...state.nodes, node], selectedNodeIds: [id] });
    return id;
  },

  moveNodes: (ids, delta) => set((state) => ({
    nodes: state.nodes.map((node) => ids.includes(node.id)
      ? { ...node, x: Math.max(0, node.x + delta.x), y: Math.max(0, node.y + delta.y), updatedAt: Date.now() }
      : node),
  })),

  updateNodeData: (id, patch) => set((state) => ({ nodes: state.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, ...patch }, updatedAt: Date.now() } : node) })),

  setSelection: (selectedNodeIds) => set({ selectedNodeIds }),
  toggleSelection: (id) => set((state) => ({ selectedNodeIds: state.selectedNodeIds.includes(id) ? state.selectedNodeIds.filter((item) => item !== id) : [...state.selectedNodeIds, id] })),

  deleteSelection: () => set((state) => {
    const ids = new Set(state.selectedNodeIds);
    return {
      nodes: state.nodes.filter((node) => !ids.has(node.id)),
      edges: state.edges.filter((edge) => !ids.has(edge.fromNodeId) && !ids.has(edge.toNodeId)),
      nodeGroups: state.nodeGroups
        .map((group) => ({ ...group, memberIds: group.memberIds.filter((id) => !ids.has(id)) }))
        .filter((group) => group.memberIds.length > 0),
      selectedNodeIds: [],
    };
  }),

  duplicateSelection: () => {
    const state = get();
    const sources = state.nodes.filter((node) => state.selectedNodeIds.includes(node.id));
    if (!sources.length) return [];
    const now = Date.now();
    // 组内一起复制时保留组内连线关系
    const idMap = new Map(sources.map((node) => [node.id, crypto.randomUUID()]));
    const copies: CanvasNode[] = sources.map((node) => ({
      ...node, id: idMap.get(node.id) as string,
      x: node.x + 32, y: node.y + 32, createdAt: now, updatedAt: now,
    }));
    const innerEdges: Edge[] = state.edges
      .filter((edge) => idMap.has(edge.fromNodeId) && idMap.has(edge.toNodeId))
      .map((edge) => ({ ...edge, id: crypto.randomUUID(), fromNodeId: idMap.get(edge.fromNodeId) as string, toNodeId: idMap.get(edge.toNodeId) as string, createdAt: now }));
    set({ nodes: [...state.nodes, ...copies], edges: [...state.edges, ...innerEdges], selectedNodeIds: copies.map((node) => node.id) });
    return copies.map((node) => node.id);
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

  createGroup: (title) => {
    const state = get();
    if (state.selectedNodeIds.length < 2) return null;
    const color = GROUP_COLORS[state.nodeGroups.length % GROUP_COLORS.length];
    const group: NodeGroup = { id: crypto.randomUUID(), projectId: 'local', title: title || `分组 ${state.nodeGroups.length + 1}`, color, collapsed: false, memberIds: [...state.selectedNodeIds] };
    set({ nodeGroups: [...state.nodeGroups, group] });
    return group;
  },

  removeGroup: (groupId) => set((state) => ({ nodeGroups: state.nodeGroups.filter((group) => group.id !== groupId) })),

  toggleGroupCollapsed: (groupId) => set((state) => ({ nodeGroups: state.nodeGroups.map((group) => group.id === groupId ? { ...group, collapsed: !group.collapsed } : group) })),

  replaceAll: (snapshot) => set({ nodes: snapshot.nodes ?? [], edges: snapshot.edges ?? [], nodeGroups: snapshot.nodeGroups ?? [], selectedNodeIds: [] }),

  snapshot: () => ({ nodes: get().nodes, edges: get().edges, nodeGroups: get().nodeGroups }),
}));
