import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react';
import type { Asset, GenerationTask, Job, NodeKind, PortKind, Project, Provider, ToolStatus, WorkspaceState } from '@canvora/shared';
import {
  assignGroup, createGroup, createProject, deleteAsset, deleteProject,
  enqueueJob, generateImage, generateVideo, getCanvas, getTools, getWorkspace, listGenerationTasks, listJobs, listProviders, removeGroup, renameProject, saveCanvas, uploadAsset,
} from './api/client';
import { AssetLibrary, type BatchKind } from './components/AssetLibrary';
import { CanvasContextMenu, type MenuRequest } from './components/CanvasContextMenu';
import { ChatPanel } from './components/ChatPanel';
import { JobsPanel } from './components/JobsPanel';
import { ProjectGate } from './components/ProjectGate';
import { CanvasNodeView } from './canvas/CanvasNodeView';
import { KIND_LABELS, PORT_COLORS, compatibleKinds, findInput, nodeSpec, portCenterY, portsCompatible } from './canvas/ports';
import { buildGenerationParams, resolveGenerationTarget } from './canvas/generation-options';
import { TimelinePanel } from './components/TimelinePanel';
import { useCanvasStore } from './stores/canvas-store';
import { emptyTimeline, useTimelineStore } from './stores/timeline-store';

type PanelTab = '对话' | '素材' | '任务';
type ThemeMode = 'light' | 'dark' | 'system';
const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
const VIDEO_TYPES = ['mp4', 'mov', 'mkv', 'webm', 'avi'];
const AUDIO_TYPES = ['mp3', 'wav', 'aac', 'm4a'];
const ACCEPT = [...IMAGE_TYPES, ...VIDEO_TYPES, ...AUDIO_TYPES].map((ext) => `.${ext}`).join(',');
const clampZoom = (value: number) => Math.min(4, Math.max(0.1, value));
const batchKindOf = (kind: BatchKind): 'exportFrames' | 'upscaleImage' | 'interpolateVideo' => kind === 'frames' ? 'exportFrames' : kind === 'upscale' ? 'upscaleImage' : 'interpolateVideo';

export function App() {
  const [theme, setTheme] = useState<ThemeMode>(() => (window.localStorage.getItem('canvora:theme') as ThemeMode) || 'light');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  const [tab, setTab] = useState<PanelTab>('对话');
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  // 服务商和密钥只在后端配置，前端只拿到可选项，永远不持有明文密钥。
  const [providers, setProviders] = useState<Provider[]>([]);
  const [generationTasks, setGenerationTasks] = useState<GenerationTask[]>([]);
  const [fatal, setFatal] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [connecting, setConnecting] = useState<{ nodeId: string; portId: string; kind: PortKind; index: number } | null>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const timeline = useTimelineStore((state) => state.timeline);
  const timelineClips = timeline.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  const resetTimeline = useTimelineStore((state) => state.setTimeline);
  const [boxSelect, setBoxSelect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ clientX: number; clientY: number; panX: number; panY: number } | null>(null);
  const boxStart = useRef<{ x: number; y: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** 已经放回画布的结果素材，避免轮询重复建节点。 */
  const placedAssetsRef = useRef<Set<string>>(new Set());
  const nodeMapRef = useRef<Map<string, import('@canvora/shared').CanvasNode>>(new Map());

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const nodeGroups = useCanvasStore((state) => state.nodeGroups);
  const selectedNodeIds = useCanvasStore((state) => state.selectedNodeIds);
  const addNode = useCanvasStore((state) => state.addNode);
  const moveNodes = useCanvasStore((state) => state.moveNodes);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelection = useCanvasStore((state) => state.setSelection);
  const toggleSelection = useCanvasStore((state) => state.toggleSelection);
  const deleteSelection = useCanvasStore((state) => state.deleteSelection);
  const duplicateSelection = useCanvasStore((state) => state.duplicateSelection);
  const connect = useCanvasStore((state) => state.connect);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const createNodeGroup = useCanvasStore((state) => state.createGroup);
  const removeNodeGroup = useCanvasStore((state) => state.removeGroup);
  const toggleGroupCollapsed = useCanvasStore((state) => state.toggleGroupCollapsed);
  const replaceAll = useCanvasStore((state) => state.replaceAll);

  const root = workspace?.root ?? '';
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  const activeProject: Project | null = useMemo(() => workspace?.projects.find((item) => item.id === activeProjectId) ?? null, [workspace, activeProjectId]);
  const projectAssets = useMemo(() => (workspace?.assets ?? []).filter((asset) => asset.projectId === activeProjectId), [workspace, activeProjectId]);
  const projectGroups = useMemo(() => (workspace?.groups ?? []).filter((group) => group.projectId === activeProjectId), [workspace, activeProjectId]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  nodeMapRef.current = nodeMap;
  const assetMap = useMemo(() => new Map(projectAssets.map((asset) => [asset.id, asset])), [projectAssets]);
  const selectedPromptText = useMemo(() => {
    const node = nodes.find((item) => selectedNodeIds.includes(item.id));
    return node && (node.kind === 'prompt' || node.kind === 'text') ? String(node.data.text ?? '') : '';
  }, [nodes, selectedNodeIds]);

  useEffect(() => {
    window.localStorage.setItem('canvora:theme', theme);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [theme]);

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
  const refreshProviders = useCallback(() => { void listProviders(root || undefined).then(setProviders).catch(() => undefined); }, [root]);
  const refreshGenerationTasks = useCallback(() => {
    void listGenerationTasks(root || undefined).then((tasks) => {
      setGenerationTasks(tasks.filter((task) => task.engine === 'cloud'));
    }).catch(() => undefined);
  }, [root]);

  /** 旧快照里的节点 projectId 可能是 'local'，进项目时统一归到当前项目，否则生成结果会写错目录。 */
  const openProjectWith = useCallback(async (state: WorkspaceState, projectId: string) => {
    try {
      const snapshot = await getCanvas(projectId, state.root);
      replaceAll({
        nodes: snapshot.nodes.map((node) => ({ ...node, projectId })),
        edges: snapshot.edges.map((edge) => ({ ...edge, projectId })),
        nodeGroups: (snapshot.nodeGroups ?? []).map((group) => ({ ...group, projectId })),
      });
      setActiveProjectId(projectId);
    } catch {
      // 恢复失败就停在项目列表，不影响使用
    }
  }, [replaceAll]);

  useEffect(() => {
    void reloadWorkspace().then((state) => {
      if (!state) return;
      void getTools(state.root).then(setTools).catch(() => setTools(null));
      void listProviders(state.root).then(setProviders).catch(() => setProviders([]));
      const last = window.localStorage.getItem('canvora:lastProject');
      if (last && state.projects.some((project) => project.id === last)) void openProjectWith(state, last);
    });
  }, [reloadWorkspace, openProjectWith]);

  useEffect(() => {
    if (!activeProjectId) return;
    // 切换项目时时间轴清空，避免把上一个项目的片段带过来
    resetTimeline(emptyTimeline(activeProjectId));
  }, [activeProjectId, resetTimeline]);

  useEffect(() => { if (activeProjectId) { refreshJobs(); refreshProviders(); refreshGenerationTasks(); } }, [activeProjectId, refreshJobs, refreshProviders, refreshGenerationTasks]);

  // 云端视频任务是异步的：轮询到完成就把结果素材放回画布，并刷新素材库。
  useEffect(() => {
    if (!generationTasks.some((task) => task.status === 'queued' || task.status === 'running')) return;
    const timer = setInterval(() => { refreshGenerationTasks(); }, 2500);
    return () => clearInterval(timer);
  }, [generationTasks, refreshGenerationTasks]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === 'queued' || job.status === 'running')) return;
    const timer = setInterval(() => {
      void listJobs(root || undefined).then((next) => {
        setJobs(next);
        // 任务产出新素材后刷新素材库，并把新素材摆到发起任务的节点下方
        const fresh = next.filter((job) => job.status === 'succeeded' && job.resultAssetIds.length);
        if (fresh.length) void getWorkspace(root || undefined).then(setWorkspace).catch(() => undefined);
      }).catch(() => undefined);
    }, 1500);
    return () => clearInterval(timer);
  }, [jobs, root]);

  // ── 画布持久化：改动后延迟保存 ──
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!activeProjectId || !root) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveCanvas(activeProjectId, { nodes, edges, nodeGroups }, root).catch(() => undefined);
    }, 700);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [nodes, edges, nodeGroups, activeProjectId, root]);

  const openProject = useCallback(async (projectId: string) => {
    setBusy('正在打开项目…');
    try {
      const snapshot = await getCanvas(projectId, root || undefined);
      replaceAll({
        nodes: snapshot.nodes.map((node) => ({ ...node, projectId })),
        edges: snapshot.edges.map((edge) => ({ ...edge, projectId })),
        nodeGroups: (snapshot.nodeGroups ?? []).map((group) => ({ ...group, projectId })),
      });
      setActiveProjectId(projectId);
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
      replaceAll({ nodes: [], edges: [], nodeGroups: [] });
      setActiveProjectId(project.id);
      window.localStorage.setItem('canvora:lastProject', project.id);
      setNotice(`项目「${project.name}」已创建，右键画布或把文件拖进来开始`);
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
      if (activeProjectId === projectId) { setActiveProjectId(null); replaceAll({ nodes: [], edges: [], nodeGroups: [] }); }
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
    addNode(kind, position, { assetId: asset.id }, activeProjectId);
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
        addNode(kind, dropPoint ? { x: dropPoint.x + index * 28, y: dropPoint.y + index * 28 } : undefined, { assetId: asset.id }, activeProjectId);
        setNotice(`已导入「${asset.originalName}」`);
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

  // 连线手势：监听在挂载时注册一次，靠 ref 读取最新状态，避免快速拖拽丢事件。
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

    // 落在输入口上：直接连线
    if (portElement) {
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
      return;
    }

    // 落在节点上但没落在输入口：提示一下别连错
    if (element?.closest('.canvas-node')) { setNotice('要连到节点左侧的输入口上，松手位置不对'); return; }

    // 落在空白处：只列出这一步真正能接的功能
    const point = toCanvasRef.current(clientX, clientY);
    const kinds = compatibleKinds(gesture.kind);
    if (kinds.length === 0) { setNotice('这个输出口没有可接的下一步'); return; }
    setMenu({ clientX, clientY, canvasX: point.x, canvasY: point.y, kinds, connectFrom: { nodeId: gesture.nodeId, portId: gesture.portId, kind: gesture.kind } });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      if (event.code === 'Space') { event.preventDefault(); setSpaceHeld(true); return; }
      const meta = event.ctrlKey || event.metaKey;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedNodeIds.length) deleteSelection();
      if (meta && event.key.toLowerCase() === 'd' && selectedNodeIds.length) { event.preventDefault(); duplicateSelection(); }
      if (meta && event.key.toLowerCase() === 'c' && selectedNodeIds.length) { event.preventDefault(); duplicateSelection(); setNotice('已复制选中的节点'); }
      if (meta && event.key.toLowerCase() === 'g' && selectedNodeIds.length >= 2) { event.preventDefault(); const group = createNodeGroup(''); if (group) setNotice(`已打组：${group.title}`); }
      if (meta && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelection(nodes.map((node) => node.id)); }
      if (event.key === 'Escape') { setConnecting(null); setMenu(null); setSelection([]); }
      if (meta && event.key === '0') { event.preventDefault(); setZoom(1); }
    };
    // 空格是"按住平移"：必须在 keyup 里松开，否则会一直处于平移态
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') setSpaceHeld(false); };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [createNodeGroup, deleteSelection, duplicateSelection, nodes, selectedNodeIds, setSelection]);

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 中键、Alt+左键、或按住空格：平移。空格是多数专业工具的习惯按键。
    if (event.button === 1 || (event.button === 0 && (event.altKey || spaceHeld))) {
      panStart.current = { clientX: event.clientX, clientY: event.clientY, panX: pan.x, panY: pan.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    // 左键空白处：框选
    if (!event.shiftKey) setSelection([]);
    const point = toCanvas(event.clientX, event.clientY);
    boxStart.current = point;
    setBoxSelect({ x: point.x, y: point.y, w: 0, h: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = panStart.current;
    if (start) { setPan({ x: start.panX + event.clientX - start.clientX, y: start.panY + event.clientY - start.clientY }); return; }
    const origin = boxStart.current;
    if (!origin) return;
    const point = toCanvas(event.clientX, event.clientY);
    const box = { x: Math.min(origin.x, point.x), y: Math.min(origin.y, point.y), w: Math.abs(point.x - origin.x), h: Math.abs(point.y - origin.y) };
    setBoxSelect(box);
    const hit = nodes.filter((node) => node.x < box.x + box.w && node.x + node.width > box.x && node.y < box.y + box.h && node.y + node.height > box.y).map((node) => node.id);
    setSelection(hit);
  };
  const endCanvasDrag = () => { panStart.current = null; boxStart.current = null; setBoxSelect(null); };
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
      const requests = kind === 'frames'
        ? [{ kind: 'exportFrames' as const, options: { position: 'both' } }]
        : [{ kind: batchKindOf(kind), options: {} }];
      for (const request of requests) await enqueueJob(request.kind, assetIds, activeProjectId, request.options, root || undefined);
      setNotice(kind === 'frames' ? '已提交导出首尾帧任务' : '已提交任务，排队执行中');
      setTab('任务');
      refreshJobs();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交任务失败');
    }
  };

  /** 在画布上就地执行节点的处理动作：把上游素材交给后端任务队列。 */
  const runNode = async (nodeId: string) => {
    const node = nodeMap.get(nodeId);
    if (!node || !activeProjectId) return;
    const incoming = edges.filter((edge) => edge.toNodeId === nodeId);
    const assetIds = incoming
      .map((edge) => nodeMap.get(edge.fromNodeId))
      .map((source) => (source ? String(source.data.assetId ?? '') : ''))
      .filter(Boolean);
    if (!assetIds.length) { setNotice('这个节点还没有接入素材，先把上游连上来'); return; }
    const options: Record<string, unknown> = {};
    if (node.kind === 'splitImage') {
      const [cols, rows] = String(node.data.split ?? '2x2').split('x').map(Number);
      options.cols = cols; options.rows = rows;
    }
    if (node.kind === 'upscale') options.scale = Number(node.data.scale ?? 4);
    if (node.kind === 'interpolate') options.multiplier = Number(node.data.multiplier ?? 2);
    if (node.kind === 'extractFrame') options.position = String(node.data.position ?? 'first');
    const kind = node.kind === 'splitImage' ? 'splitImage'
      : node.kind === 'upscale' ? (assetMap.get(assetIds[0])?.kind === 'video' ? 'upscaleVideo' : 'upscaleImage')
        : node.kind === 'interpolate' ? 'interpolateVideo'
          : 'exportFrames';
    try {
      await enqueueJob(kind, assetIds, activeProjectId, options, root || undefined);
      setNotice(`已提交「${node.title}」任务，去任务中心看进度`);
      setTab('任务');
      refreshJobs();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '提交任务失败');
    }
  };

  /** 生成结果回到画布：在生成节点下方建结果节点，并记录来源关系。 */
  const placeGenerationResults = useCallback((sourceNodeId: string, assetIds: string[]) => {
    if (!activeProjectId || !assetIds.length) return;
    const source = nodeMapRef.current.get(sourceNodeId);
    if (!source) return;
    const resultKind: NodeKind = source.kind === 'generateVideo' ? 'video' : 'image';
    assetIds.forEach((assetId, index) => {
      if (placedAssetsRef.current.has(assetId)) return;
      placedAssetsRef.current.add(assetId);
      addNode(resultKind, {
        x: source.x + index * 300,
        y: source.y + source.height + 70,
      }, { assetId, sourceNodeId }, activeProjectId);
    });
    updateNodeData(sourceNodeId, { resultAssetIds: assetIds, status: 'succeeded', error: '' });
  }, [activeProjectId, addNode, updateNodeData]);

  // 云端任务完成后把结果素材放回画布；同一个素材只放一次。
  useEffect(() => {
    const pending = generationTasks
      .filter((task) => task.status === 'succeeded' && task.nodeId)
      .filter((task) => task.resultAssetIds.some((assetId) => !placedAssetsRef.current.has(assetId)));
    if (!pending.length) return;
    void reloadWorkspace(root).then(() => {
      for (const task of pending) placeGenerationResults(task.nodeId as string, task.resultAssetIds);
    });
  }, [generationTasks, placeGenerationResults, reloadWorkspace, root]);

  // 云端任务失败时把错误写回发起生成的节点，用户能在画布上直接看到原因。
  useEffect(() => {
    for (const task of generationTasks) {
      if (task.status !== 'failed' || !task.nodeId) continue;
      const node = nodeMapRef.current.get(task.nodeId);
      if (node && node.data.status !== 'failed') updateNodeData(task.nodeId, { status: 'failed', error: task.errorMessage ?? '生成失败' });
    }
  }, [generationTasks, updateNodeData]);

  /** 云端生成：把节点参数、上游素材和提示词交给后端，结果自动回到画布。 */
  const runGeneration = async (nodeId: string) => {
    const node = nodeMap.get(nodeId);
    if (!node || !activeProjectId) { setNotice('请先打开一个项目'); return; }
    const kind: 'image' | 'video' = node.kind === 'generateVideo' ? 'video' : 'image';
    const target = resolveGenerationTarget(providers, kind, String(node.data.providerId ?? ''), String(node.data.model ?? ''));
    if (!target) { setNotice('还没有可用的服务商，请到后端管理页配置服务商和密钥'); return; }
    const prompt = String(node.data.prompt ?? '').trim();
    if (!prompt) { setNotice('先写下提示词再生成'); return; }

    // 上游连进来的图片素材就是参考图/首帧/尾帧；只提交素材 id，文件由后端读取。
    const inputs = edges.filter((edge) => edge.toNodeId === nodeId)
      .map((edge) => ({ port: edge.toPortId, source: nodeMap.get(edge.fromNodeId) }))
      .map((item) => ({ port: item.port, assetId: item.source ? String(item.source.data.assetId ?? '') : '' }))
      .filter((item) => item.assetId)
      .map((item) => {
        const asset = assetMap.get(item.assetId);
        const assetKind: 'image' | 'video' | 'audio' = asset?.kind === 'video' ? 'video' : asset?.kind === 'audio' ? 'audio' : 'image';
        return { assetId: item.assetId, kind: assetKind, role: item.port };
      });

    updateNodeData(nodeId, { providerId: target.provider.id, model: target.model.id, status: 'running', error: '' });
    try {
      const request = {
        root,
        projectId: activeProjectId,
        providerId: target.provider.id,
        model: target.model.id,
        prompt,
        params: buildGenerationParams(kind, node.data),
        inputs,
        nodeId,
      };
      const result = kind === 'video' ? await generateVideo(request) : await generateImage(request);
      if (result.assetIds?.length) {
        await reloadWorkspace(root);
        placeGenerationResults(nodeId, result.assetIds);
        setNotice(kind === 'video' ? '视频已生成并放回画布' : '图片已生成并放回画布');
      } else if (result.taskId) {
        updateNodeData(nodeId, { taskId: result.taskId, status: 'queued', error: '' });
        setNotice('已提交生成任务，完成后会自动回到画布');
        refreshGenerationTasks();
        setTab('任务');
      } else {
        throw new Error('服务商没有返回结果');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败';
      updateNodeData(nodeId, { status: 'failed', error: message });
      setNotice(message);
    }
  };

  /** 把时间轴编成 EDL 交给后端导出。 */
  const runTimelineExport = async (exportSettings: import('@canvora/shared').ExportSettings) => {
    if (!activeProjectId) { setNotice('请先打开一个项目'); return; }
    const edl = useTimelineStore.getState().buildEdl(
      (assetId) => {
        const asset = assetMap.get(assetId);
        return asset ? `${root.replace(/\/$/, '')}/${asset.relPath}` : null;
      },
      (assetId) => Boolean(assetMap.get(assetId)?.hasAudio),
    );
    if (!edl.clips.length) { setNotice('时间轴还没有片段，先把素材拖到轨道上'); return; }
    try {
      await enqueueJob('exportTimeline', [], activeProjectId, { edl, settings: exportSettings }, root || undefined);
      setNotice('已提交导出任务，去任务中心看进度');
      setTab('任务');
      refreshJobs();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导出提交失败');
    }
  };

  const connectingFrom = connecting ? nodeMap.get(connecting.nodeId) : null;
  const previewPath = connectingFrom && connecting
    ? `M ${connectingFrom.x + connectingFrom.width} ${connectingFrom.y + portCenterY(connecting.index)} C ${connectingFrom.x + connectingFrom.width + 80} ${connectingFrom.y + portCenterY(connecting.index)}, ${cursor.x - 80} ${cursor.y}, ${cursor.x} ${cursor.y}`
    : '';

  /** 拖动节点：选中多个时整组一起移动。 */
  const dragNodeBy = (id: string, delta: { x: number; y: number }) => {
    const moving = selectedNodeIds.includes(id) ? selectedNodeIds : [id];
    moveNodes(moving, delta);
  };

  const nodeContextMenu = (nodeId: string, clientX: number, clientY: number) => {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    if (!selectedNodeIds.includes(nodeId)) setSelection([nodeId]);
    setMenu({ clientX, clientY, canvasX: node.x, canvasY: node.y, nodeId });
  };

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
        <button className="link-button" onClick={() => { setActiveProjectId(null); replaceAll({ nodes: [], edges: [], nodeGroups: [] }); }} title="回到项目列表">← 项目</button>
        <strong>{activeProject?.name ?? '未命名项目'}</strong>
        <span className="muted">（{projectAssets.length} 个素材）</span>
      </div>
      <div className="top-actions">
        <button className="ghost-button" onClick={() => fileInput.current?.click()}>导入素材</button>
        <button className="ghost-button" onClick={() => void reloadWorkspace(root)}>刷新</button>
        <div className="theme-switch" title="主题">
          {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => <button key={mode} className={theme === mode ? 'active' : ''} onClick={() => setTheme(mode)}>{mode === 'light' ? '浅色' : mode === 'dark' ? '深色' : '跟随系统'}</button>)}
        </div>
      </div>
    </header>
    <main className="workspace">
      <section className="canvas-shell">
        <div className="canvas-toolbar">
          <span className="canvas-title">画布</span>
          <span className="canvas-hint">右键或从端口拖到空白处添加节点 · 拖文件进来导入 · 左键框选 · 中键/Alt 拖动平移 · 滚轮缩放 · 选中两个以上按 Ctrl+G 打组</span>
          <button className="zoom-button" onClick={() => setZoom((value) => clampZoom(value + 0.1))}>＋</button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button className="zoom-button" onClick={() => setZoom((value) => clampZoom(value - 0.1))}>－</button>
          <button className="zoom-button" onClick={fitAll}>适应全部</button>
          <button className="zoom-button" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}>重置</button>
        </div>
        <div
          className={`canvas-area ${spaceHeld ? 'space-pan' : ''}`}
          ref={canvasRef}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onCanvasPointerMove}
          onPointerUp={endCanvasDrag}
          onWheel={onWheel}
          onContextMenu={(event) => {
            event.preventDefault();
            const point = toCanvas(event.clientX, event.clientY);
            setMenu({ clientX: event.clientX, clientY: event.clientY, canvasX: point.x, canvasY: point.y });
          }}
        >
          <div className="grid" style={{ backgroundPosition: `${pan.x}px ${pan.y}px`, backgroundSize: `${24 * zoom}px ${24 * zoom}px` }} />
          <div className="canvas-content" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            {nodeGroups.map((group) => {
              const members = group.memberIds.map((id) => nodeMap.get(id)).filter((node): node is NonNullable<typeof node> => Boolean(node));
              if (!members.length) return null;
              const minX = Math.min(...members.map((node) => node.x)) - 18;
              const minY = Math.min(...members.map((node) => node.y)) - 40;
              const maxX = Math.max(...members.map((node) => node.x + node.width)) + 18;
              const maxY = Math.max(...members.map((node) => node.y + node.height)) + 18;
              return <div className="node-group" key={group.id} style={{ left: minX, top: minY, width: maxX - minX, height: maxY - minY, borderColor: group.color }}>
                <div className="node-group-header" style={{ background: group.color }} onPointerDown={(event) => event.stopPropagation()}>
                  <span>{group.title}（{members.length}）</span>
                  <span className="node-group-actions">
                    <button onClick={() => toggleGroupCollapsed(group.id)}>{group.collapsed ? '展开' : '折叠'}</button>
                    <button onClick={() => removeNodeGroup(group.id)}>解散</button>
                  </span>
                </div>
              </div>;
            })}
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
              <p className="muted tiny">也试试：从素材库把素材拖进来 · 左键框选 · 中键平移 · 滚轮缩放</p>
            </div>}
            <div className="node-layer">
              {nodes.filter((node) => !nodeGroups.some((group) => group.collapsed && group.memberIds.includes(node.id))).map((node) => <CanvasNodeView
                key={node.id}
                node={node}
                zoom={zoom}
                root={root}
                assets={assetMap}
                providers={providers}
                selected={selectedNodeIds.includes(node.id)}
                connectingKind={connecting?.kind ?? null}
                onSelect={(id, additive) => { if (additive) toggleSelection(id); else setSelection([id]); }}
                onDragBy={dragNodeBy}
                onUpdateData={updateNodeData}
                onRunGeneration={(nodeId) => void runGeneration(nodeId)}
                onStartConnect={(nodeId, portId, kind, index) => { const gesture = { nodeId, portId, kind, index }; gestureRef.current = gesture; setConnecting(gesture); }}
                onContextMenu={nodeContextMenu}
              />)}
            </div>
            {boxSelect && boxSelect.w > 2 && <div className="select-box" style={{ left: boxSelect.x, top: boxSelect.y, width: boxSelect.w, height: boxSelect.h }} />}
          </div>
          {selectedNodeIds.length > 1 && <div className="selection-bar">
            已选中 {selectedNodeIds.length} 个节点
            <button onClick={() => { const group = createNodeGroup(''); if (group) setNotice(`已打组：${group.title}`); }}>打组</button>
            <button onClick={() => { duplicateSelection(); setNotice('已复制选中的节点'); }}>复制</button>
            {selectedNodeIds.some((id) => ['upscale', 'interpolate', 'splitImage', 'extractFrame'].includes(nodeMap.get(id)?.kind ?? '')) && <button onClick={() => { const target = selectedNodeIds.find((id) => ['upscale', 'interpolate', 'splitImage', 'extractFrame'].includes(nodeMap.get(id)?.kind ?? '')); if (target) void runNode(target); }}>运行处理节点</button>}
            <button onClick={() => deleteSelection()}>删除</button>
          </div>}
          {connecting && <div className="connection-hint">正在从「{KIND_LABELS[connecting.kind]}」输出口拉线：拖到输入口连线，拖到空白处会列出能接的下一步</div>}
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
            onInsertToCanvas={(text) => { if (selectedNodeIds.length) { updateNodeData(selectedNodeIds[0], { text }); setNotice('已填入选中的提示词节点'); } else { const id = addNode('prompt', undefined, undefined, activeProjectId ?? undefined); updateNodeData(id, { text }); setNotice('已新建提示词节点并填入内容'); } }}
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
          {tab === '任务' && <JobsPanel jobs={jobs} generationTasks={generationTasks} root={root} onRefresh={() => { refreshJobs(); refreshGenerationTasks(); }} />}
        </div>
      </aside>
    </main>
    <footer className="timeline-shell">
      <div className="timeline-header">
        <span>时间轴</span>
        <span className="muted">拖素材到轨道 · 拖片段边缘变速 · S 分割 · Delete 删除 · 空格播放</span>
        <button className="small-button" onClick={() => setTimelineOpen((value) => !value)}>{timelineOpen ? '收起' : '展开'}</button>
      </div>
      {timelineOpen && <TimelinePanel
        assets={projectAssets}
        root={root}
        onNotice={setNotice}
        onExport={(exportSettings) => { void runTimelineExport(exportSettings); }}
      />}
    </footer>
    <div className="statusbar">
      <span>工作区：{root || '未设置'}</span>
      <span>工具：{tools ? `ffmpeg ${tools.ffmpeg ? '✓' : '×'} · ffprobe ${tools.ffprobe ? '✓' : '×'} · Real-ESRGAN ${tools.realesrgan ? '✓' : '×'} · RIFE ${tools.rife ? '✓' : '×'}` : '检测中…'}</span>
      <span>节点 {nodes.length} · 连线 {edges.length}{selectedNodeIds.length ? ` · 选中 ${selectedNodeIds.length}` : ''}</span>
      <span className="muted">时间轴片段 {timelineClips} 个</span>
    </div>
    {menu && <CanvasContextMenu
      request={menu}
      onPick={(kind) => {
        const id = addNode(kind, { x: menu.canvasX, y: menu.canvasY }, undefined, activeProjectId ?? undefined);
        if (menu.connectFrom) {
          const spec = nodeSpec(kind);
          const target = spec.inputs.find((input) => portsCompatible(menu.connectFrom!.kind, input));
          if (target) connect(menu.connectFrom.nodeId, menu.connectFrom.portId, id, target.id, menu.connectFrom.kind, Boolean(target.multiple));
        }
      }}
      onClose={() => setMenu(null)}
      onRunNode={(nodeId) => runNode(nodeId)}
      onGroup={() => { const group = createNodeGroup(''); if (group) setNotice(`已打组：${group.title}`); }}
      onDuplicate={() => { duplicateSelection(); setNotice('已复制选中的节点'); }}
      onDelete={() => deleteSelection()}
    />}
    <input ref={fileInput} hidden type="file" multiple accept={ACCEPT} onChange={(event) => { if (event.target.files?.length) void importFiles(Array.from(event.target.files)); event.target.value = ''; }} />
  </div>;
}
