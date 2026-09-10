import { useEffect } from 'react';
import type { NodeKind } from '@canvora/shared';
import { CATALOG_BY_KIND, NODE_CATALOG } from '../canvas/node-catalog';
import { KIND_LABELS } from '../canvas/ports';
import type { PortKind } from '@canvora/shared';

export interface MenuRequest {
  clientX: number;
  clientY: number;
  canvasX: number;
  canvasY: number;
  /** 有值表示是「从某个输出口拖到空白处」，菜单只列这一步能接的功能。 */
  connectFrom?: { nodeId: string; portId: string; kind: PortKind };
  /** 有值表示是在某个节点上右键，显示节点操作。 */
  nodeId?: string;
  /** connectFrom 情况下的候选节点类型。 */
  kinds?: NodeKind[];
}

interface Props {
  request: MenuRequest;
  onPick: (kind: NodeKind) => void;
  onClose: () => void;
  onRunNode: (nodeId: string) => void;
  onGroup: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function CanvasContextMenu({ request, onPick, onClose, onRunNode, onGroup, onDuplicate, onDelete }: Props) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const style = { left: Math.min(request.clientX, window.innerWidth - 250), top: Math.min(request.clientY, window.innerHeight - 320) };

  // 节点右键：节点自己的操作
  if (request.nodeId) {
    return <div className="context-menu" style={style} onPointerDown={(event) => event.stopPropagation()}>
      <div className="context-title">节点操作</div>
      <button className="context-item wide" onClick={() => { onRunNode(request.nodeId as string); onClose(); }}>
        <span className="context-icon">▶</span><span className="context-label">运行这个节点</span>
        <span className="context-hint">把上游素材交给任务队列处理</span>
      </button>
      <button className="context-item wide" onClick={() => { onDuplicate(); onClose(); }}>
        <span className="context-icon">⧉</span><span className="context-label">复制</span>
        <span className="context-hint">支持多选后一起复制（Ctrl+C）</span>
      </button>
      <button className="context-item wide" onClick={() => { onGroup(); onClose(); }}>
        <span className="context-icon">▣</span><span className="context-label">把选中的打成一组</span>
        <span className="context-hint">需要先选中两个以上节点（Ctrl+G）</span>
      </button>
      <button className="context-item wide danger" onClick={() => { onDelete(); onClose(); }}>
        <span className="context-icon">×</span><span className="context-label">删除</span>
        <span className="context-hint">Delete</span>
      </button>
    </div>;
  }

  // 从端口拖到空白处：只列这一步能接的功能
  if (request.connectFrom) {
    const kinds = request.kinds ?? [];
    return <div className="context-menu" style={style} onPointerDown={(event) => event.stopPropagation()}>
      <div className="context-title">这条「{KIND_LABELS[request.connectFrom.kind]}」线接下来可以接</div>
      {kinds.map((kind) => {
        const entry = CATALOG_BY_KIND[kind];
        if (!entry) return null;
        return <button key={kind} className="context-item wide" onClick={() => { onPick(kind); onClose(); }}>
          <span className="context-icon">{entry.icon}</span>
          <span className="context-label">{entry.label}</span>
          <span className="context-hint">{entry.hint}</span>
        </button>;
      })}
      <div className="context-foot">选一个就会自动建好节点并连上</div>
    </div>;
  }

  // 空白处右键：全部节点
  return <div className="context-menu" style={style} onPointerDown={(event) => event.stopPropagation()}>
    <div className="context-title">在这里添加节点</div>
    {NODE_CATALOG.map((group) => <div className="context-group" key={group.title}>
      <div className="context-group-title">{group.title}</div>
      {group.entries.map((entry) => <button key={entry.kind} className="context-item" title={entry.hint} onClick={() => { onPick(entry.kind); onClose(); }}>
        <span className="context-icon">{entry.icon}</span>
        <span className="context-label">{entry.label}</span>
        <span className="context-hint">{entry.hint}</span>
      </button>)}
    </div>)}
    <div className="context-foot">从端口拖到空白处，只会列出能接的下一步</div>
  </div>;
}
