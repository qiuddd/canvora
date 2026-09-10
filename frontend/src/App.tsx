import { useState } from 'react';
import { useCanvasStore } from './stores/canvas-store';

const tools = [
  ['选择', '↖'], ['提示词', 'T'], ['图片', '▣'], ['视频', '▶'], ['生图', '✦'], ['生视频', '◈']
] as const;

export function App() {
  const [dark, setDark] = useState(false);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const addNode = useCanvasStore((state) => state.addNode);
  const moveNode = useCanvasStore((state) => state.moveNode);
  const connect = useCanvasStore((state) => state.connect);
  return <div className={dark ? 'app dark' : 'app'}>
    <header className="topbar"><div className="brand"><span className="brand-mark">C</span><span>Canvora</span></div><div className="project-name">未命名项目 <span className="chevron">⌄</span></div><div className="top-actions"><button className="ghost-button">保存</button><button className="ghost-button">导出</button><button className="icon-button" onClick={() => setDark((value) => !value)}>{dark ? '☀' : '☾'}</button></div></header>
    <main className="workspace">
      <aside className="toolbar"><div className="toolbar-title">工具</div>{tools.map(([label, icon]) => <button key={label} className="tool-button" onClick={() => addNode(label === '提示词' ? 'prompt' : label === '图片' ? 'image' : label === '视频' ? 'video' : 'note')}><span className="tool-icon">{icon}</span><span>{label}</span></button>)}<div className="toolbar-spacer"/><button className="tool-button"><span className="tool-icon">⚙</span><span>设置</span></button></aside>
      <section className="canvas-shell"><div className="canvas-toolbar"><span className="canvas-title">画布</span><span className="canvas-hint">拖入图片或视频，开始创作</span><span className="zoom-label">100%</span></div><div className="canvas-area"><div className="grid" /><svg className="edges-layer">{edges.map((edge) => { const from = nodes.find((node) => node.id === edge.fromNodeId); const to = nodes.find((node) => node.id === edge.toNodeId); return from && to ? <line key={edge.id} x1={from.x + from.width} y1={from.y + 70} x2={to.x} y2={to.y + 70} stroke="#818cf8" strokeWidth="2" /> : null; })}</svg>{nodes.length === 0 ? <div className="empty-canvas"><div className="empty-icon">✦</div><h2>开始你的创作</h2><p>从左侧添加节点，或把桌面上的图片、视频拖到这里</p><button className="primary-button" onClick={() => addNode('prompt')}>添加提示词节点</button></div> : <div className="node-layer">{nodes.map((node) => <div className="canvas-node" key={node.id} style={{ left: node.x, top: node.y }} draggable onDragEnd={(event) => moveNode(node.id, Math.max(0, event.clientX - 84), Math.max(0, event.clientY - 103))} onDoubleClick={() => { const target = nodes.find((candidate) => candidate.id !== node.id); if (target) connect(node.id, target.id, node.kind === 'prompt' ? 'text' : 'any'); }}><div className="node-header"><span>{node.title}</span><span>⋮</span></div><div className="node-body">{node.kind === 'prompt' ? <textarea placeholder="写下你的提示词…" /> : <div className="node-placeholder">{node.kind === 'image' ? '图片素材' : node.kind === 'video' ? '视频素材' : '文本节点'}</div>}</div></div>)}</div>}</div></section>
      <aside className="right-panel"><div className="panel-tabs"><button className="active">素材库</button><button>任务中心</button></div><div className="panel-content"><div className="panel-heading"><span>当前项目</span><button className="small-button">导入</button></div><div className="library-empty"><div className="library-icon">▧</div><p>还没有素材</p><span>导入图片或视频后会显示在这里</span></div></div></aside>
    </main>
    <footer className="timeline"><div className="timeline-header"><span>时间轴</span><span className="muted">拖入视频开始剪辑</span><button className="small-button">展开</button></div><div className="timeline-body"><div className="track-label">视频轨 1</div><div className="track-line" /></div></footer>
  </div>;
}
