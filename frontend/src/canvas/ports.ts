import type { NodeKind, PortKind } from '@canvora/shared';
export interface PortSpec {
  id: string;
  label: string;
  kind: PortKind;
  /** 允许接入的类型；缺省表示只接受 kind 本身。 */
  accepts?: PortKind[];
  /** 该输入口是否允许接多条线（PRD 8.3 标注“可多个”的端口）。 */
  multiple?: boolean;
}

export interface NodeSpec { inputs: PortSpec[]; outputs: PortSpec[] }

const any: PortKind[] = ['text', 'image', 'video', 'audio'];

const SPECS: Record<NodeKind, NodeSpec> = {
  prompt: { inputs: [], outputs: [{ id: 'out', label: '文本', kind: 'text' }] },
  text: { inputs: [], outputs: [{ id: 'out', label: '文本', kind: 'text' }] },
  // 便利贴按 PRD 不能连线
  note: { inputs: [], outputs: [] },
  image: { inputs: [], outputs: [{ id: 'out', label: '图片', kind: 'image' }] },
  video: { inputs: [], outputs: [{ id: 'out', label: '视频', kind: 'video' }] },
  audio: { inputs: [], outputs: [{ id: 'out', label: '音频', kind: 'audio' }] },
  generateImage: {
    inputs: [
      { id: 'prompt', label: '提示词', kind: 'text' },
      { id: 'refImage', label: '参考图', kind: 'image', multiple: true },
    ],
    outputs: [{ id: 'out', label: '图片', kind: 'image', multiple: true }],
  },
  generateVideo: {
    inputs: [
      { id: 'prompt', label: '提示词', kind: 'text' },
      { id: 'firstFrame', label: '首帧', kind: 'image' },
      { id: 'lastFrame', label: '尾帧', kind: 'image' },
      { id: 'refImage', label: '参考图', kind: 'image', multiple: true },
    ],
    outputs: [{ id: 'out', label: '视频', kind: 'video', multiple: true }],
  },
  llm: { inputs: [{ id: 'input', label: '输入', kind: 'text' }], outputs: [{ id: 'out', label: '文本', kind: 'text' }] },
  // 放大允许接多张图或多段视频：一次任务里批量处理
  upscale: { inputs: [{ id: 'in', label: '素材', kind: 'any', accepts: any, multiple: true }], outputs: [{ id: 'out', label: '结果', kind: 'any', multiple: true }] },
  interpolate: { inputs: [{ id: 'in', label: '视频', kind: 'video', multiple: true }], outputs: [{ id: 'out', label: '视频', kind: 'video', multiple: true }] },
  extractFrame: { inputs: [{ id: 'in', label: '视频', kind: 'video' }], outputs: [{ id: 'out', label: '图片', kind: 'image', multiple: true }] },
  splitImage: { inputs: [{ id: 'in', label: '图片', kind: 'image', multiple: true }], outputs: [{ id: 'out', label: '切块', kind: 'image', multiple: true }] },
  group: { inputs: [], outputs: [] },
};

export function nodeSpec(kind: NodeKind): NodeSpec {
  return SPECS[kind];
}

export function findInput(kind: NodeKind, portId: string): PortSpec | undefined {
  return nodeSpec(kind).inputs.find((port) => port.id === portId);
}

/** 上游输出类型能否接进下游输入口。 */
export function portsCompatible(from: PortKind, spec: PortSpec): boolean {
  if (from === 'any' || spec.kind === 'any') return true;
  if (spec.accepts) return spec.accepts.includes(from);
  return spec.kind === from;
}

export const PORT_COLORS: Record<PortKind, string> = { text: '#64748b', image: '#2563eb', video: '#9333ea', audio: '#16a34a', any: '#6366f1' };

export const KIND_LABELS: Record<PortKind, string> = { text: '文本', image: '图片', video: '视频', audio: '音频', any: '通用' };

/** 端口行的几何常量，连线预览与 DOM 布局必须使用同一套数值。 */
export const HEADER_HEIGHT = 38;
export const PORTS_PADDING_TOP = 6;
export const PORT_ROW_HEIGHT = 22;

export function portCenterY(index: number): number {
  return HEADER_HEIGHT + PORTS_PADDING_TOP + index * PORT_ROW_HEIGHT + PORT_ROW_HEIGHT / 2;
}

/**
 * 从一个输出口能接到哪些节点类型：只要该节点存在一个能接受这种类型的输入口就算兼容。
 * 用于「拖线到空白处」时只列出这一步真正能用的功能。
 */
export function compatibleKinds(from: PortKind): NodeKind[] {
  return (Object.keys(SPECS) as NodeKind[]).filter((kind) => SPECS[kind].inputs.some((spec) => portsCompatible(from, spec)));
}

/** 该节点能不能直接吃某类素材（素材库拖到画布时用来挑默认节点）。 */
export function acceptsAsset(kind: NodeKind, assetKind: PortKind): boolean {
  return SPECS[kind].inputs.some((spec) => portsCompatible(assetKind, spec));
}
