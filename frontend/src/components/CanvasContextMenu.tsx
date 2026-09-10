import { useEffect } from 'react';
import type { NodeKind } from '@canvora/shared';
import { NODE_CATALOG } from '../canvas/node-catalog';

interface Props {
  x: number;
  y: number;
  onPick: (kind: NodeKind) => void;
  onClose: () => void;
}

/** 画布右键菜单：所有节点都从这里添加，侧边栏不再放节点按钮。 */
export function CanvasContextMenu({ x, y, onPick, onClose }: Props) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return <div className="context-menu" style={{ left: x, top: y }} onPointerDown={(event) => event.stopPropagation()}>
    <div className="context-title">在这里添加节点</div>
    {NODE_CATALOG.map((group) => <div className="context-group" key={group.title}>
      <div className="context-group-title">{group.title}</div>
      {group.entries.map((entry) => <button key={entry.kind} className="context-item" title={entry.hint} onClick={() => { onPick(entry.kind); onClose(); }}>
        <span className="context-icon">{entry.icon}</span>
        <span className="context-label">{entry.label}</span>
        <span className="context-hint">{entry.hint}</span>
      </button>)}
    </div>)}
    <div className="context-foot">右键菜单添加节点 · 从素材库拖素材进来直接成节点</div>
  </div>;
}
