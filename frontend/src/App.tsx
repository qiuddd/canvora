import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react';
import type { Asset, NodeKind, PortKind, WorkspaceState } from '@canvora/shared';
import { assetFileUrl, assetThumbUrl, getWorkspace, uploadAsset } from './api/client';
import { CanvasNodeView } from './canvas/CanvasNodeView';
import { KIND_LABELS, PORT_COLORS, findInput, nodeSpec, portCenterY, portsCompatible } from './canvas/ports';
import { useCanvasStore } from './stores/canvas-store';

type PanelTab = '素材库' | '任务中心' | '设置';

const TOOLS: Array<[string, string, NodeKind]> = [
  ['提示词', 'T', 'prompt'], ['文本', '≡', 'text'], ['图片', '▣', 'image'], ['视频', '▶', 'video'],
  ['生图', '✦', 'generateImage'], ['生视频', '◈', 'generateVideo'], ['抽帧', '⧉', 'extractFrame'],
  ['放大', '⤢', 'upscale'], ['补帧', '⧗', 'interpolate'], ['AI 文本', '✎', 'llm'], ['便利贴', '▤', 'note'],
];

const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const VIDEO_TYPES = ['mp4', 'mov', 'mkv', 'webm', 'avi'];
const AUDIO_TYPES = ['mp3', 'wav', 'aac', 'm4a'];
const ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES, ...AUDIO_TYPES].map((ext) => `.${ext}`).join(',');

const clampZoom = (value: number) => Math.min(4, Math.max(0.1, value));

export function App() {
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState<PanelTab>('素材库');
  const [timelineExpanded, setTimelineExpanded] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [fatal, setFatal] = useState('');
  const [rootInput, setRootInput] = useState('');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [connecting, setConnecting] = useState<{ nodeId: string; portId: string; kind: PortKind; index: number } | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const addNode = useCanvasStore((state) => state.addNode);
  const moveNode = useCanvasStore((state) => state.moveNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const selectNode = useCanvasStore((state) => state.selectNode);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const duplicateNode = useCanvasStore((state) => state.duplicateNode);
  const connect = useCanvasStore((state) => state.connect);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const assetMap = useMemo(() => new Map((workspace?.assets ?? []).map((asset) => [asset.id, asset])), [workspace]);
  const root = workspace?.root ?? '';

  const loadWorkspace = useCallback(async (targetRoot?: string) => {
    try {
      const state = await getWorkspace(targetRoot);
      setWorkspace(state);
      setRootInput(state.root);
      setFatal('');
    } catch (error) {
      setFatal(error instanceof Error ? error.message : '无法读取工作区');
    }
  }, []);

  useEffect(() => { void loadWorkspace(); }, [loadWorkspace]);

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  }, [pan.x, pan.y, zoom]);

  const importFiles = useCallback(async (files: File[], dropPoint?: { x: number; y: number }) => {
    if (!workspace) { setNotice('工作区还没准备好，请稍后重试'); return; }
    const projectId = workspace.projects[0]?.id ?? 'default';
    let index = 0;
    for (const file of files) {
      try {
        setBusy(`正在导入 ${file.name}…`);
        const asset = await uploadAsset(workspace.root, projectId, file, (percent) => setBusy(`正在导入 ${file.name}（${percent}%）`));
        setWorkspace((state) => state ? { ...state, assets: [...state.assets.filter((item) => item.id !== asset.id), asset] } : state);
        const kind: NodeKind = asset.kind === 'audio' ? 'audio' : asset.kind;
        const position = dropPoint
          ? { x: dropPoint.x + index * 28, y: dropPoint.y + index * 28 }
          : undefined;
        addNode(kind, position, { assetId: asset.id });
        setNotice(`已导入：${asset.originalName}`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '素材导入失败');
      }
      index += 1;
    }
    setBusy('');
  }, [addNode, nodes.length, workspace]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const point = toCanvas(event.clientX, event.clientY);
    const assetId = event.dataTransfer.getData('application/x-canvora-asset');
    if (assetId) {
      const asset = assetMap.get(assetId);
      if (asset) {
        addNode(asset.kind === 'audio' ? 'audio' : asset.kind, point, { assetId });
        setNotice(`已把「${asset.originalName}」放到画布`);
      }
      return;
    }
    if (event.dataTransfer.files.length) void importFiles(Array.from(event.dataTransfer.files), point);
  };

  // 连线手势：监听在组件挂载时注册一次，靠 ref 读取最新状态。
  // 如果放在 useEffect([connecting]) 里注册，快速拖拽时 pointerup 可能早于 React 提交而丢失。
  const gestureRef = useRef<{ nodeId: string; portId: string; kind: PortKind; index: number } | null>(null);
  const toCanvasRef = useRef(toCanvas);
  toCanvasRef.current = toCanvas;
  const completeConnectRef = useRef<(gesture: NonNullable<typeof gestureRef.current>, clientX: number, clientY: number) => void>(() => undefined);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!gestureRef.current) return;
      setCursor(toCanvasRef.current(event.clientX, event.clientY));
    };
    const onUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;
      setConnecting(null);
      completeConnectRef.current(gesture, event.clientX, event.clientY);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  completeConnectRef.current = (gesture, clientX, clientY) => {
    const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const portElement = element?.closest('[data-port-in]') as HTMLElement | null;
    if (!portElement) return;
    const targetNodeId = portElement.dataset.nodeId ?? '';
    const targetPortId = portElement.dataset.portId ?? '';
    const targetNode = nodeMap.get(targetNodeId);
    if (!targetNode) return;
    const inputSpec = findInput(targetNode.kind, targetPortId);
    if (!inputSpec) return;
    if (targetNodeId === gesture.nodeId) { setNotice('不能连接到自己的节点'); return; }
    if (!portsCompatible(gesture.kind, inputSpec)) {
      setNotice(`端口类型不匹配：${KIND_LABELS[gesture.kind]} 不能接到「${inputSpec.label}」（需要 ${KIND_LABELS[inputSpec.kind]}）`);
      return;
    }
    const result = connect(gesture.nodeId, gesture.portId, targetNodeId, targetPortId, gesture.kind, Boolean(inputSpec.multiple));
    if (result === 'cycle') setNotice('不能连成循环');
    else if (result === 'duplicate') setNotice('这条连线已经存在了');
    else if (result === 'replaced') setNotice('这个输入口已有连线，已替换成新的');
    else setNotice('已连接');
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodeId) deleteNode(selectedNodeId);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd' && selectedNodeId) { event.preventDefault(); duplicateNode(selectedNodeId); }
      if (event.key === 'Escape') setConnecting(null);
      if ((event.ctrlKey || event.metaKey) && event.key === '0') { event.preventDefault(); setZoom(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteNode, duplicateNode, selectedNodeId]);

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    selectNode(null);
    panStart.current = { clientX: event.clientX, clientY: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStart.current;
    if (!start) return;
    setPan({ x: start.panX + event.clientX - start.clientX, y: start.panY + event.clientY - start.clientY });
  };
  // 以鼠标指针为锚点缩放：指针下的画布坐标在缩放前后保持不变。
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const nextZoom = clampZoom(zoom * (event.deltaY > 0 ? 0.92 : 1.08));
    setPan({ x: mx - ((mx - pan.x) / zoom) * nextZoom, y: my - ((my - pan.y) / zoom) * nextZoom });
    setZoom(nextZoom);
  };

  const fitAll = () => {
    if (nodes.length === 0) { setPan({ x: 0, y: 0 }); setZoom(1); return; }
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const maxY = Math.max(...nodes.map((node) => node.y + node.height));
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextZoom = clampZoom(Math.min((rect.width - 80) / (maxX - minX), (rect.height - 80) / (maxY - minY), 1));
    setZoom(nextZoom);
    setPan({ x: 40 - minX * nextZoom, y: 40 - minY * nextZoom });
  };

  const connectingFrom = connecting ? nodeMap.get(connecting.nodeId) : null;
  const previewPath = connectingFrom && connecting
    ? `M ${connectingFrom.x + connectingFrom.width} ${connectingFrom.y + portCenterY(connecting.index)} C ${connectingFrom.x + connectingFrom.width + 80} ${connectingFrom.y + portCenterY(connecting.index)}, ${cursor.x - 80} ${cursor.y}, ${cursor.x} ${cursor.y}`
    : '';

  if (fatal) {
    return <div className="fatal">
      <div className="fatal-card">
        <h2>无法连接后端</h2>
        <p>{fatal}</p>
        <p className="muted">请确认后端窗口还在运行（默认 http://127.0.0.1:8787），然后重试。</p>
        <button className="primary-button" onClick={() => void loadWorkspace()}>重试</button>
      </div>
    </div>;
  }

  return <div className={dark ? 'app dark' : 'app'}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">C</span><span>Canvora</span></div>
      <div className="project-name">{workspace?.projects[0]?.name ?? '未命名项目'} <span className="chevron">⌄</span></div>
      <div className="top-actions">
        <button className="ghost-button" onClick={() => fileInput.current?.click()}>导入素材</button>
        <button className="ghost-button" onClick={() => void loadWorkspace(root)}>刷新</button>
        <button className="icon-button" onClick={() => setDark((value) => !value)}>{dark ? '☀' : '☾'}</button>
      </div>
    </header>
    <main className="workspace">
      <aside className="toolbar">
        <div className="toolbar-title">添加节点</div>
        {TOOLS.map(([label, icon, kind]) => <button key={label} className="tool-button" onClick={() => addNode(kind)}><span className="tool-icon">{icon}</span><span>{label}</span></button>)}
        <div className="toolbar-spacer" />
        <button className="tool-button" onClick={() => setTab('设置')}><span className="tool-icon">⚙</span><span>设置</span></button>
      </aside>
      <section className="canvas-shell">
        <div className="canvas-toolbar">
          <span className="canvas-title">画布</span>
          <span className="canvas-hint">空白处拖动平移 · 滚轮缩放 · 标题栏拖动节点 · 输出口拖到输入口连线 · 双击连线删除</span>
          <button className="zoom-button" onClick={() => setZoom((value) => clampZoom(value + 0.1))}>＋</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="zoom-button" onClick={() => setZoom((value) => clampZoom(value - 0.1))}>－</button>
          <button className="zoom-button" onClick={fitAll}>适应全部</button>
          <button className="zoom-button" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}>重置</button>
        </div>
        <div
          className="canvas-area"
          ref={canvasRef}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={() => { panStart.current = null; }}
          onWheel={onWheel}
        >
          <div className="grid" style={{ backgroundPosition: `${pan.x}px ${pan.y}px`, backgroundSize: `${24 * zoom}px ${24 * zoom}px` }} />
          <div className="canvas-content" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <svg className="edges-layer">
              {edges.map((edge) => {
                const from = nodeMap.get(edge.fromNodeId);
                const to = nodeMap.get(edge.toNodeId);
                if (!from || !to) return null;
                const outIndex = nodeSpec(from.kind).outputs.findIndex((port) => port.id === edge.fromPortId);
                const inIndex = nodeSpec(to.kind).inputs.findIndex((port) => port.id === edge.toPortId);
                const x1 = from.x + from.width;
                const y1 = from.y + portCenterY(outIndex < 0 ? 0 : outIndex);
                const x2 = to.x;
                const y2 = to.y + portCenterY(inIndex < 0 ? 0 : inIndex);
                const midX = (x1 + x2) / 2;
                const midY = (y1 + y2) / 2;
                const path = `M ${x1} ${y1} C ${x1 + 70} ${y1}, ${x2 - 70} ${y2}, ${x2} ${y2}`;
                return <g key={edge.id} className="edge-group" onDoubleClick={(event) => { event.stopPropagation(); deleteEdge(edge.id); setNotice('已删除连线'); }}>
                  <path className="edge-hit" d={path} onPointerEnter={() => setHoveredEdge(edge.id)} onPointerLeave={() => setHoveredEdge(null)} />
                  <path d={path} style={{ stroke: PORT_COLORS[edge.kind] }} />
                  {hoveredEdge === edge.id && <g className="edge-delete" onPointerDown={(event) => { event.stopPropagation(); deleteEdge(edge.id); setNotice('已删除连线'); }}>
                    <circle cx={midX} cy={midY} r={9} />
                    <text x={midX} y={midY + 3}>×</text>
                  </g>}
                </g>;
              })}
            </svg>
            {previewPath && <svg className="edges-layer preview"><path d={previewPath} style={{ stroke: PORT_COLORS[connecting?.kind ?? 'any'] }} /></svg>}
            {nodes.length === 0
              ? <div className="empty-canvas">
                <div className="empty-icon">✦</div>
                <h2>开始你的创作</h2>
                <p>把桌面上的图片、视频拖到这里，或点击左上角「导入素材」</p>
                <button className="primary-button" onClick={() => fileInput.current?.click()}>导入素材</button>
              </div>
              : <div className="node-layer">
                {nodes.map((node) => <CanvasNodeView
                  key={node.id}
                  node={node}
                  zoom={zoom}
                  root={root}
                  assets={assetMap}
                  selected={selectedNodeId === node.id}
                  connectingKind={connecting?.kind ?? null}
                  onSelect={selectNode}
                  onMove={moveNode}
                  onUpdateData={updateNodeData}
                  onStartConnect={(nodeId, portId, kind, index) => { const gesture = { nodeId, portId, kind, index }; gestureRef.current = gesture; setConnecting(gesture); }}
                />)}
              </div>}
          </div>
          {connecting && <div className="connection-hint">正在从「{KIND_LABELS[connecting.kind]}」输出口拉线，拖到目标节点左侧高亮的输入口上松开</div>}
          {busy && <div className="connection-hint busy">{busy}</div>}
          {notice && !busy && <button className="connection-hint" onClick={() => setNotice('')}>{notice}（点这里关闭）</button>}
        </div>
      </section>
      <aside className="right-panel">
        <div className="panel-tabs">
          {(['素材库', '任务中心', '设置'] as PanelTab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}
        </div>
        <div className="panel-content">
          {tab === '素材库' && <>
            <div className="panel-heading">
              <span>当前项目（{workspace?.assets.length ?? 0}）</span>
              <button className="small-button" onClick={() => fileInput.current?.click()}>导入</button>
            </div>
            {workspace?.assets.length
              ? <div className="asset-grid">
                {workspace.assets.map((asset: Asset) => <div
                  className="asset-card"
                  key={asset.id}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('application/x-canvora-asset', asset.id)}
                  onDoubleClick={() => addNode(asset.kind === 'audio' ? 'audio' : asset.kind, undefined, { assetId: asset.id })}
                  title={`${asset.originalName}（拖到画布或双击创建节点）`}
                >
                  <img src={asset.kind === 'video' ? assetThumbUrl(root, asset.id) : assetFileUrl(root, asset.id)} alt={asset.originalName} />
                  <span className="asset-name">{asset.originalName}</span>
                  <span className="asset-meta">{KIND_LABELS[asset.kind]}{asset.kind !== 'image' && asset.durationSec ? ` · ${asset.durationSec.toFixed(1)}秒` : ''}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</span>
                </div>)}
              </div>
              : <div className="library-empty"><div className="library-icon">▧</div><p>还没有素材</p><span>把图片或视频拖进画布，或点上面的「导入」</span></div>}
          </>}
          {tab === '任务中心' && <div className="panel-section">
            <h3>生成任务</h3>
            <p className="muted">云端生图 / 生视频、本地放大与补帧任务会显示在这里。</p>
            <p className="muted">当前版本还没有接入真实 AI 接口，需要你先在「设置」里配置服务商和密钥。</p>
          </div>}
          {tab === '设置' && <div className="panel-section">
            <h3>工作区</h3>
            <label>工作区路径
              <input value={rootInput} onChange={(event) => setRootInput(event.target.value)} placeholder="F:/Canvora" />
            </label>
            <button className="primary-button" onClick={() => void loadWorkspace(rootInput)}>切换工作区</button>
            <p className="muted">素材会复制到这个目录下，请选择空间充足的磁盘（推荐 F: 或 G:）。</p>
            <h3>外观</h3>
            <button className="ghost-button" onClick={() => setDark((value) => !value)}>切换{dark ? '浅色' : '深色'}主题</button>
          </div>}
        </div>
      </aside>
    </main>
    <footer className={`timeline ${timelineExpanded ? 'expanded' : ''}`}>
      <div className="timeline-header">
        <span>时间轴</span>
        <span className="muted">序列 · 视频轨道（时间轴编辑还在开发中）</span>
        <button className="small-button" onClick={() => setTimelineExpanded((value) => !value)}>{timelineExpanded ? '收起' : '展开'}</button>
      </div>
      <div className="timeline-body">
        <div className="ruler"><span>00:00</span><span>00:05</span><span>00:10</span><span>00:15</span></div>
        <div className="track-row"><div className="track-label">视频轨 1</div><div className="track-line"><div className="drop-label">把画布上的视频拖到这里</div></div></div>
        <div className="track-row"><div className="track-label">贴图轨 1</div><div className="track-line secondary" /></div>
      </div>
    </footer>
    <input ref={fileInput} hidden type="file" multiple accept={ACCEPT} onChange={(event) => { if (event.target.files?.length) void importFiles(Array.from(event.target.files)); event.target.value = ''; }} />
  </div>;
}
