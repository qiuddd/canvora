import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react';
import type { Asset, Job, NodeKind, PortKind, Project, ToolStatus, WorkspaceState } from '@canvora/shared';
import {
  assignGroup, createGroup, createProject, deleteAsset, deleteProject,
  enqueueJob, getCanvas, getTools, getWorkspace, listJobs, removeGroup, renameProject, saveCanvas, uploadAsset,
} from './api/client';
import { AssetLibrary, type BatchKind } from './components/AssetLibrary';
import { CanvasContextMenu } from './components/CanvasContextMenu';
import { ChatPanel } from './components/ChatPanel';
import { JobsPanel } from './components/JobsPanel';
import { ProjectGate } from './components/ProjectGate';
import { CanvasNodeView } from './canvas/CanvasNodeView';
import { KIND_LABELS, PORT_COLORS, findInput, nodeSpec, portCenterY, portsCompatible } from './canvas/ports';
import { useCanvasStore } from './stores/canvas-store';

type PanelTab = '对话' | '素材' | '任务';
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const VIDEO_TYPES = ['mp4', 'mov', 'mkv', 'webm', 'avi'];
const AUDIO_TYPES = ['mp3', 'wav', 'aac', 'm4a'];
const ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES, ...AUDIO_TYPES].map((ext) => `.${ext}`).join(',');
const clampZoom = (value: number) => Math.min(4, Math.max(0.1, value));

const batchKindOf = (kind: BatchKind): 'exportFrames' | 'upscaleImage' | 'interpolateVideo' => kind === 'frames' ? 'exportFrames' : kind === 'upscale' ? 'upscaleImage' : 'interpolateVideo';

export function App() {
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState<PanelTab>('对话');
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [fatal, setFatal] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
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
  const replaceAll = useCanvasStore((state) => state.replaceAll);

  const root = workspace?.root ?? '';
  const activeProject: Project | null = useMemo(() => workspace?.projects.find((item) => item.id === activeProjectId) ?? null, [workspace, activeProjectId]);
  const projectAssets = useMemo(() => (workspace?.assets ?? []).filter((asset) => asset.projectId === activeProjectId), [workspace, activeProjectId]);
  const projectGroups = useMemo(() => (workspace?.groups ?? []).filter((group) => group.projectId === activeProjectId), [workspace, activeProjectId]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const assetMap = useMemo(() => new Map(projectAssets.map((asset) => [asset.id, asset])), [projectAssets]);
  const selectedPromptText = useMemo(() => {
    const node = nodes.find((item) => item.id === selectedNodeId);
    return node && (node.kind === 'prompt' || node.kind === 'text') ? String(node.data.text ?? '') : '';
  }, [nodes, selectedNodeId]);

  const reloadWorkspace = useCallback(async (targetRoot?: string) => {
    try {
      const state = await getWorkspace(targetRoot);
      setWorkspace(state);
      setFatal('');
      return state;
    } catch (error) {
      setFatal(error instanceof Error ? error.message : '无法读取工作区');
      return null;
    }
  }, []);

  const refreshJobs = useCallback(() => { void listJobs(root || undefined).then(setJobs).catch(() => undefined); }, [root]);

  /** 启动时用它恢复上次打开的项目。定义必须在用到它的 effect 之前，否则会踩暂时性死区。 */
  const openProjectWith = useCallback(async (state: WorkspaceState, projectId: string) => {
    try {
      const snapshot = await getCanvas(projectId, state.root);
      replaceAll(snapshot);
      setActiveProjectId(projectId);
    } catch {
      // 恢复失败就停在项目列表，不影响使用
    }
  }, [replaceAll]);

  useEffect(() => {
    void reloadWorkspace().then((state) => {
      if (!state) return;
      void getTools(state.root).then(setTools).catch(() => setTools(null));
      const last = window.localStorage.getItem('canvora:lastProject');
      if (last && state.projects.some((project) => project.id === last)) void openProjectWith(state, last);
    });
  }, [reloadWorkspace, openProjectWith]);

  useEffect(() => { if (activeProjectId) refreshJobs(); }, [activeProjectId, refreshJobs]);
  // 任务在跑的时候自动轮询，让进度自己更新
  useEffect(() => {
    if (!jobs.some((job) => job.status === 'queued' || job.status === 'running')) return;
    const timer = setInterval(() => {
      void listJobs(root || undefined).then((next) => {
        setJobs(next);
        // 任务产出新素材后刷新素材库
        if (next.some((job) => job.status === 'succeeded' && job.resultAssetIds.length)) {
          void getWorkspace(root || undefined).then(setWorkspace).catch(() => undefined);
        }
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [jobs, root]);

  // ── 画布持久化：改动后延迟保存，避免每个像素都写盘 ──
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!activeProjectId || !root) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveCanvas(activeProjectId, { nodes, edges }, root).catch(() => undefined);
    }, 700);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [nodes, edges, activeProjectId, root]);

  const openProject = useCallback(async (projectId: string) => {
    setBusy('正在打开项目…');
    try {
      const snapshot = await getCanvas(projectId, root || undefined);
      replaceAll(snapshot);
      setActiveProjectId(projectId);
      // 记住上次打开的项目，刷新后直接回到这里，不用每次重新点
      window.localStorage.setItem('canvora:lastProject', projectId);
      setPan({ x: 0, y: 0 });
      setZoom(1);
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '打开项目失败');
    } finally {
      setBusy('');
    }
  }, [replaceAll, root]);

  const handleCreateProject = async (name: string) => {
    setBusy('正在创建项目…');
    try {
      const project = await createProject(name, root || undefined);
      const state = await reloadWorkspace(root || undefined);
      if (!state) return;
      replaceAll({ nodes: [], edges: [] });
      setActiveProjectId(project.id);
      setNotice(`项目「${project.name}」已创建，右键画布添加节点`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '创建项目失败');
    } finally {
      setBusy('');
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    const project = workspace?.projects.find((item) => item.id === projectId);
    if (!project) return;
    const count = (workspace?.assets ?? []).filter((asset) => asset.projectId === projectId).length;
    if (!window.confirm(`删除项目「${project.name}」？\n项目里的 ${count} 个素材文件也会一起删除，无法恢复。`)) return;
    try {
      await deleteProject(projectId, root || undefined);
      if (activeProjectId === projectId) { setActiveProjectId(null); replaceAll({ nodes: [], edges: [] }); }
      await reloadWorkspace(root || undefined);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '删除项目失败');
    }
  };

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
  }, [pan.x, pan.y, zoom]);

  const addAssetToCanvas = useCallback((asset: Asset, position?: { x: number; y: number }) => {
    if (!activeProjectId) { setNotice('请先新建或打开一个项目'); return; }
    const kind: NodeKind = asset.kind === 'audio' ? 'audio' : asset.kind;
    addNode(kind, position, { assetId: asset.id });
  }, [activeProjectId, addNode]);

  const importFiles = useCallback(async (files: File[], dropPoint?: { x: number; y: number }) => {
    if (!activeProjectId) { setNotice('请先新建项目，再拖素材进来'); return; }
    let index = 0;
    for (const file of files) {
      try {
        setBusy(`正在导入 ${file.name}…`);
        const asset = await uploadAsset(root, activeProjectId, file, (percent) => setBusy(`正在导入 ${file.name}（${percent}%）`));
        setWorkspace((state) => state ? { ...state, assets: [...state.assets.filter((item) => item.id !== asset.id), asset] } : state);
        const kind: NodeKind = asset.kind === 'audio' ? 'audio' : asset.kind;
        addNode(kind, dropPoint ? { x: dropPoint.x + index * 28, y: dropPoint.y + index * 28 } : undefined, { assetId: asset.id });
        setNotice(`已导入「${asset.originalName}」，右键画布可以继续加节点`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '素材导入失败');
      }
      index += 1;
    }
    setBusy('');
  }, [activeProjectId, addNode, root]);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const point = toCanvas(event.clientX, event.clientY);
    const assetId = event.dataTransfer.getData('application/x-canvora-asset');
    if (assetId) {
      const asset = assetMap.get(assetId);
      if (asset) { addAssetToCanvas(asset, point); setNotice(`已把「${asset.originalName}」放到画布`); }
      return;
    }
    if (event.dataTransfer.files.length) void importFiles(Array.from(event.dataTransfer.files), point);
  };

  // 连线手势：监听在组件挂载时注册一次，靠 ref 读取最新状态，避免快速拖拽丢事件。
  const gestureRef = useRef<{ nodeId: string; portId: string; kind: PortKind; index: number } | null>(null);
  const toCanvasRef = useRef(toCanvas);
  toCanvasRef.current = toCanvas;
  const completeConnectRef = useRef<(gesture: NonNullable<typeof gestureRef.current>, clientX: number, clientY: number) => void>(() => undefined);

  useEffect(() => {
    const onMove = (event: PointerEvent) => { if (gestureRef.current) setCursor(toCanvasRef.current(event.clientX, event.clientY)); };
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
      if (event.key === 'Escape') { setConnecting(null); setMenu(null); }
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

  const runBatch = async (kind: BatchKind, assetIds: string[]) => {
    if (!activeProjectId) { setNotice('请先打开一个项目'); return; }
    if (!assetIds.length) { setNotice('请先在素材库里勾选要处理的素材'); return; }
    try {
      // 「导出首尾帧」按后端约定拆成首帧和尾帧两个任务，这样每个素材都能拿到两张图。
      const requests = kind === 'frames'
        ? [{ kind: 'exportFrames' as const, options: { position: 'first' } }, { kind: 'exportFrames' as const, options: { position: 'last' } }]
        : [{ kind: batchKindOf(kind), options: {} }];
      for (const request of requests) await enqueueJob(request.kind, assetIds, activeProjectId, request.options, root || undefined);
      setNotice(kind === 'frames' ? '已提交导出首尾帧任务' : '已提交任务，排队执行中');
      setTab('任务');
      refreshJobs();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交任务失败');
    }
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
        <button className="primary-button" onClick={() => void reloadWorkspace()}>重试</button>
      </div>
    </div>;
  }

  if (workspace && !activeProject) {
    return <>
      <ProjectGate
        projects={workspace.projects}
        workspaceRoot={workspace.root}
        busy={Boolean(busy)}
        onCreate={handleCreateProject}
        onOpen={(id) => void openProject(id)}
        onDelete={handleDeleteProject}
        onRename={(id, name) => { void renameProject(id, name, root || undefined).then(() => reloadWorkspace(root || undefined)); }}
        onChangeRoot={(nextRoot) => { void reloadWorkspace(nextRoot); }}
      />
      {busy && <div className="gate-busy">{busy}</div>}
    </>;
  }

  return <div className={dark ? 'app dark' : 'app'}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark">C</span><span>Canvora</span></div>
      <div className="project-switch">
        <button className="link-button" onClick={() => { setActiveProjectId(null); replaceAll({ nodes: [], edges: [] }); }} title="回到项目列表">← 项目</button>
        <strong>{activeProject?.name ?? '未命名项目'}</strong>
        <span className="muted">（{projectAssets.length} 个素材）</span>
      </div>
      <div className="top-actions">
        <button className="ghost-button" onClick={() => fileInput.current?.click()}>导入素材</button>
        <button className="ghost-button" onClick={() => void reloadWorkspace(root)}>刷新</button>
        <button className="icon-button" onClick={() => setDark((value) => !value)}>{dark ? '☀' : '☾'}</button>
      </div>
    </header>
    <main className="workspace">
      <section className="canvas-shell">
        <div className="canvas-toolbar">
          <span className="canvas-title">画布</span>
          <span className="canvas-hint">右键空白处添加节点 · 拖素材进来导入 · 标题栏拖动节点 · 输出口拖到输入口连线 · 双击连线删除</span>
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
          onContextMenu={(event) => {
            event.preventDefault();
            const point = toCanvas(event.clientX, event.clientY);
            setMenu({ x: event.clientX, y: event.clientY, canvasX: point.x, canvasY: point.y });
          }}
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
            {nodes.length === 0 && <div className="empty-canvas">
              <div className="empty-icon">✦</div>
              <h2>{activeProject?.name ?? '新画布'}是空的</h2>
              <p>在画布上点<b>右键</b>添加节点，或把桌面上的图片、视频直接拖进来</p>
              <p className="muted tiny">画布可以无限拖拽和缩放，随手试试滚轮</p>
            </div>}
            <div className="node-layer">
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
            </div>
          </div>
          {connecting && <div className="connection-hint">正在从「{KIND_LABELS[connecting.kind]}」输出口拉线，拖到目标节点左侧高亮的输入口上松开</div>}
          {busy && <div className="connection-hint busy">{busy}</div>}
          {notice && !busy && <button className="connection-hint" onClick={() => setNotice('')}>{notice}（点这里关闭）</button>}
        </div>
      </section>
      <aside className="right-panel">
        <div className="panel-tabs">
          {(['对话', '素材', '任务'] as PanelTab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}{item === '任务' && jobs.some((job) => job.status === 'running' || job.status === 'queued') ? ' ·' : ''}</button>)}
        </div>
        <div className="panel-content">
          {tab === '对话' && <ChatPanel
            root={root}
            promptDraft={selectedPromptText}
            onInsertToCanvas={(text) => { if (selectedNodeId) { updateNodeData(selectedNodeId, { text }); setNotice('已填入选中的提示词节点'); } else { const id = addNode('prompt'); updateNodeData(id, { text }); setNotice('已新建提示词节点并填入内容'); } }}
          />}
          {tab === '素材' && <AssetLibrary
            assets={projectAssets}
            groups={projectGroups}
            root={root}
            tools={tools}
            onImport={() => fileInput.current?.click()}
            onAddToCanvas={(asset) => addAssetToCanvas(asset)}
            onDelete={(asset) => {
              if (!window.confirm(`删除素材「${asset.originalName}」？工作区里的文件也会删掉。`)) return;
              void deleteAsset(asset.id, root || undefined).then(() => reloadWorkspace(root || undefined)).catch((error) => setNotice(error instanceof Error ? error.message : '删除失败'));
            }}
            onCreateGroup={(name, assetIds) => { void createGroup(activeProjectId ?? '', name, assetIds, root || undefined).then(() => reloadWorkspace(root || undefined)).catch((error) => setNotice(error instanceof Error ? error.message : '分组失败')); }}
            onAssignGroup={(groupId, assetIds) => { void assignGroup(groupId, assetIds, root || undefined).then(() => reloadWorkspace(root || undefined)).catch((error) => setNotice(error instanceof Error ? error.message : '移出分组失败')); }}
            onRemoveGroup={(groupId) => { void removeGroup(groupId, root || undefined).then(() => reloadWorkspace(root || undefined)).catch((error) => setNotice(error instanceof Error ? error.message : '删除分组失败')); }}
            onBatch={(kind, assetIds) => void runBatch(kind, assetIds)}
          />}
          {tab === '任务' && <JobsPanel jobs={jobs} root={root} onRefresh={refreshJobs} />}
        </div>
      </aside>
    </main>
    <footer className="statusbar">
      <span>工作区：{root || '未设置'}</span>
      <span>工具：{tools ? `ffmpeg ${tools.ffmpeg ? '✓' : '×'} · ffprobe ${tools.ffprobe ? '✓' : '×'} · Real-ESRGAN ${tools.realesrgan ? '✓' : '×'} · RIFE ${tools.rife ? '✓' : '×'}` : '检测中…'}</span>
      <span>节点 {nodes.length} · 连线 {edges.length}</span>
      <span className="muted">时间轴剪辑还在开发中</span>
    </footer>
    {menu && <CanvasContextMenu x={menu.x} y={menu.y} onPick={(kind) => addNode(kind, { x: menu.canvasX, y: menu.canvasY })} onClose={() => setMenu(null)} />}
    <input ref={fileInput} hidden type="file" multiple accept={ACCEPT} onChange={(event) => { if (event.target.files?.length) void importFiles(Array.from(event.target.files)); event.target.value = ''; }} />
  </div>;
}
