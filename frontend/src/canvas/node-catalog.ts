import type { NodeKind } from '@canvora/shared';

export interface CatalogEntry { kind: NodeKind; label: string; icon: string; hint: string }
export interface CatalogGroup { title: string; entries: CatalogEntry[] }

/** 画布右键菜单的节点清单。侧边栏不再放这些按钮。 */
export const NODE_CATALOG: CatalogGroup[] = [
  {
    title: '文本',
    entries: [
      { kind: 'prompt', label: '提示词', icon: 'T', hint: '写提示词，连到生成节点' },
      { kind: 'text', label: '文本', icon: '≡', hint: '一段普通文本' },
      { kind: 'note', label: '便利贴', icon: '▤', hint: '纯备注，不能连线' },
    ],
  },
  {
    title: '素材',
    entries: [
      { kind: 'image', label: '图片', icon: '▣', hint: '放一张图片素材' },
      { kind: 'video', label: '视频', icon: '▶', hint: '放一段视频素材' },
    ],
  },
  {
    title: 'AI 生成',
    entries: [
      { kind: 'generateImage', label: '生图', icon: '✦', hint: '需要先配置生图服务商' },
      { kind: 'generateVideo', label: '生视频', icon: '◈', hint: '需要先配置生视频服务商' },
      { kind: 'llm', label: 'AI 文本', icon: '✎', hint: '用 DeepSeek 扩写或改写' },
    ],
  },
  {
    title: '本地处理',
    entries: [
      { kind: 'extractFrame', label: '抽帧', icon: '⧉', hint: '从视频抽取首帧 / 尾帧' },
      { kind: 'upscale', label: '放大', icon: '⤢', hint: 'Real-ESRGAN 放大图片或视频' },
      { kind: 'interpolate', label: '补帧', icon: '⧗', hint: 'RIFE 把帧率补上去' },
    ],
  },
];

export const NODE_LABELS: Record<NodeKind, string> = {
  prompt: '提示词', text: '文本', note: '便利贴', image: '图片', video: '视频', audio: '音频',
  generateImage: '生图', generateVideo: '生视频', llm: 'AI 文本', upscale: '放大', interpolate: '补帧', extractFrame: '抽帧',
};
