import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Asset, Clip, ColorGrade, ExportSettings, Timeline, Track } from '@canvora/shared';
import { clipTimelineDuration, defaultOverlayLayout, timelineDuration } from '@canvora/shared';
import { assetFileUrl, assetThumbUrl } from '../api/client';
import { defaultExportSettings, mainVideoTrackOf, useTimelineStore } from '../stores/timeline-store';

interface Props {
  assets: Asset[];
  root: string;
  onExport: (settings: ExportSettings) => void;
  onNotice: (message: string) => void;
}

const MIN_SPEED = 0.1;
const MAX_SPEED = 20;
const formatTime = (seconds: number) => {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const f = Math.floor((safe % 1) * 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${f}`;
};
const clipAt = (list: Clip[], seconds: number) => list.find((clip) => seconds >= clip.startAt && seconds < clip.startAt + clipTimelineDuration(clip)) ?? null;
const findClip = (timeline: Timeline, clipId: string) => timeline.tracks.flatMap((track) => track.clips).find((clip) => clip.id === clipId) ?? null;

/** 预览近似：调色映射成 CSS 滤镜（导出走 ffmpeg 的 eq/colorbalance，参数语义一致）。 */
const gradeCssFilter = (grade?: ColorGrade) => {
  if (!grade) return undefined;
  const parts: string[] = [];
  if (grade.brightness) parts.push(`brightness(${(1 + grade.brightness).toFixed(3)})`);
  if (grade.contrast && grade.contrast !== 1) parts.push(`contrast(${grade.contrast.toFixed(3)})`);
  if (grade.saturation && grade.saturation !== 1) parts.push(`saturate(${grade.saturation.toFixed(3)})`);
  return parts.length ? parts.join(' ') : undefined;
};
/** 色温/色调的预览近似：一层 soft-light 叠色，导出走 colorbalance。 */
const gradeTintStyle = (grade?: ColorGrade): CSSProperties | null => {
  const temperature = grade?.temperature ?? 0;
  const tint = grade?.tint ?? 0;
  if (!temperature && !tint) return null;
  let color = 'rgba(128,128,128,0)';
  if (Math.abs(temperature) >= Math.abs(tint)) {
    color = temperature > 0 ? `rgba(255,145,60,${Math.min(0.5, temperature * 0.42)})` : `rgba(70,140,255,${Math.min(0.5, -temperature * 0.42)})`;
  } else {
    color = tint > 0 ? `rgba(90,220,110,${Math.min(0.45, tint * 0.38)})` : `rgba(235,80,200,${Math.min(0.45, -tint * 0.38)})`;
  }
  return { background: color, mixBlendMode: 'soft-light' };
};

export function TimelinePanel({ assets, root, onExport, onNotice }: Props) {
  const timeline = useTimelineStore((state) => state.timeline);
  const playhead = useTimelineStore((state) => state.playhead);
  const playing = useTimelineStore((state) => state.playing);
  const zoom = useTimelineStore((state) => state.zoom);
  const selectedClipId = useTimelineStore((state) => state.selectedClipId);
  const edgeModes = useTimelineStore((state) => state.edgeModes);
  const setPlayhead = useTimelineStore((state) => state.setPlayhead);
  const setPlaying = useTimelineStore((state) => state.setPlaying);
  const selectClip = useTimelineStore((state) => state.selectClip);
  const setZoom = useTimelineStore((state) => state.setZoom);
  const addClip = useTimelineStore((state) => state.addClip);
  const updateClip = useTimelineStore((state) => state.updateClip);
  const moveClip = useTimelineStore((state) => state.moveClip);
  const setClipLayout = useTimelineStore((state) => state.setClipLayout);
  const setClipGrade = useTimelineStore((state) => state.setClipGrade);
  const removeClip = useTimelineStore((state) => state.removeClip);
  const splitAt = useTimelineStore((state) => state.splitAt);
  const toggleEdgeMode = useTimelineStore((state) => state.toggleEdgeMode);
  const setEdgeMode = useTimelineStore((state) => state.setEdgeMode);
  const duplicateClip = useTimelineStore((state) => state.duplicateClip);
  const toggleClipMuted = useTimelineStore((state) => state.toggleClipMuted);
  const toggleClipEnabled = useTimelineStore((state) => state.toggleClipEnabled);
  const addTrack = useTimelineStore((state) => state.addTrack);
  const removeTrack = useTimelineStore((state) => state.removeTrack);
  const buildEdl = useTimelineStore((state) => state.buildEdl);

  const [settings, setSettings] = useState<ExportSettings>(() => defaultExportSettings(timeline));
  const [speedBadge, setSpeedBadge] = useState<string | null>(null);
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [clipMenu, setClipMenu] = useState<{ clientX: number; clientY: number; clipId: string } | null>(null);
  const [trackMenu, setTrackMenu] = useState<{ clientX: number; clientY: number; trackId: string } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const tracksScrollRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  /** 播放头期望对应的源时间：视频元数据加载完成后再定位，避免加载途中 seek 被吞掉。 */
  const desiredSourceTimeRef = useRef(0);

  const mainTrack = mainVideoTrackOf(timeline);
  const clips = useMemo(() => [...(mainTrack?.clips ?? [])].sort((a, b) => a.startAt - b.startAt), [mainTrack]);
  const total = useMemo(() => Math.max(timelineDuration(timeline), 0), [timeline]);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  const activeClip = useMemo(() => clipAt(clips, playhead), [clips, playhead]);
  const activeAsset = activeClip ? assetById.get(activeClip.assetId) ?? null : null;
  const sourceTime = activeClip ? Math.max(0, activeClip.inPoint + (playhead - activeClip.startAt) * activeClip.speed) : 0;
  const previewOverlays = useMemo(() => timeline.tracks
    .filter((track) => track.kind === 'overlay')
    .flatMap((track) => track.clips)
    .filter((clip) => clip.enabled && playhead >= clip.startAt && playhead < clip.startAt + clipTimelineDuration(clip)), [timeline, playhead]);

  // 用 ref 把最新值带进不重建的 RAF 循环
  const totalRef = useRef(total);
  totalRef.current = total;
  const assetMapRef = useRef(assetById);
  assetMapRef.current = assetById;

  // ── 走带：播放头始终按真实时间推进；视频片段且播放器跟得上时改用视频时钟，保证帧级同步 ──
  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    let lastTick = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - lastTick) / 1000);
      lastTick = now;
      const state = useTimelineStore.getState();
      const main = mainVideoTrackOf(state.timeline);
      const current = clipAt((main?.clips ?? []).filter((clip) => clip.enabled), state.playhead);
      const asset = current ? assetMapRef.current.get(current.assetId) : undefined;
      const video = videoRef.current;
      const next = state.playhead + dt;
      const end = totalRef.current;
      if (end > 0 && next >= end) {
        state.setPlayhead(end);
        state.setPlaying(false);
        return;
      }
      const videoTime = current && asset?.kind === 'video' && video && !video.paused && !video.seeking && video.readyState >= 2
        && current.speed >= 0.25 && current.speed <= 4
        ? current.startAt + (video.currentTime - current.inPoint) / current.speed
        : null;
      if (videoTime !== null && current && video) {
        if (Math.abs(videoTime - next) > 0.3) {
          // 视频和播放头差得远（拖动播放头/换段/卡顿后恢复）：把视频拽回播放头
          try { video.currentTime = Math.max(0, current.inPoint + (next - current.startAt) * current.speed); } catch { /* 元数据未就绪，忽略 */ }
          state.setPlayhead(next);
        } else {
          state.setPlayhead(videoTime);
        }
      } else {
        // 变速超出预览能力（<0.25x 或 >4x）或非视频片段：墙钟推进，周期性把视频拽回正确位置
        if (current && asset?.kind === 'video' && video && video.readyState >= 1 && !video.seeking) {
          const target = current.inPoint + (next - current.startAt) * current.speed;
          if (Math.abs(video.currentTime - target) > 0.35) {
            try { video.currentTime = target; } catch { /* 忽略 */ }
          }
        }
        state.setPlayhead(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; };
  }, [playing]);

  // ── 预览同步：暂停时把画面seek到播放头；播放时设好倍速/静音并保证在播 ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!activeClip || activeAsset?.kind !== 'video') {
      if (!video.paused) video.pause();
      return;
    }
    desiredSourceTimeRef.current = sourceTime;
    video.playbackRate = Math.min(4, Math.max(0.25, activeClip.speed));
    video.muted = activeClip.audioMode === 'mute';
    if (!playing) {
      if (!video.paused) video.pause();
      if (video.readyState >= 1 && Math.abs(video.currentTime - sourceTime) > 0.02) {
        try { video.currentTime = sourceTime; } catch { /* 忽略 */ }
      }
    } else if (video.paused) {
      void video.play().catch(() => undefined);
    }
  }, [activeClip, activeAsset, playing, sourceTime]);

  // 播放时播放头快滚出视野就自动跟滚
  useEffect(() => {
    if (!playing) return;
    const el = tracksScrollRef.current;
    if (!el) return;
    const x = playhead * zoom;
    if (x < el.scrollLeft + 24) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.25);
    else if (x > el.scrollLeft + el.clientWidth - 64) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.7);
  }, [playhead, playing, zoom]);

  // 可视宽度：决定滚动内容的最小宽度（时间轴总长超出可视区时出现横向滚动条）
  const [viewportWidth, setViewportWidth] = useState(900);
  useEffect(() => {
    const el = tracksScrollRef.current;
    if (!el) return;
    const update = () => setViewportWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const contentWidth = Math.max(viewportWidth, Math.ceil((total + 8) * zoom) + 24);

  // 预览区尺寸 + 视频固有尺寸 → 按 contain 规则算出画面实际显示矩形。
  // 贴图坐标是相对成片画面的归一化值，只有叠在这个矩形上才和导出结果一致。
  const [previewSize, setPreviewSize] = useState({ w: 300, h: 216 });
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const update = () => setPreviewSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const [videoDimensions, setVideoDimensions] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => { setVideoDimensions(null); }, [activeAsset?.id]);
  const mediaBox = useMemo(() => {
    const dims = activeAsset?.kind === 'video'
      ? videoDimensions
      : activeAsset?.width && activeAsset?.height ? { w: activeAsset.width, h: activeAsset.height } : null;
    if (!dims || !dims.w || !dims.h || !previewSize.w || !previewSize.h) return null;
    const scale = Math.min(previewSize.w / dims.w, previewSize.h / dims.h);
    const width = dims.w * scale;
    const height = dims.h * scale;
    return { left: (previewSize.w - width) / 2, top: (previewSize.h - height) / 2, width, height };
  }, [activeAsset, videoDimensions, previewSize]);

  const togglePlay = useCallback(() => {
    const state = useTimelineStore.getState();
    if (!state.playing && totalRef.current > 0 && state.playhead >= totalRef.current - 1e-6) state.setPlayhead(0);
    state.setPlaying(!state.playing);
  }, []);

  const addAsset = useCallback((assetId: string, startAt?: number, trackKind: Track['kind'] = 'video') => {
    const asset = assetById.get(assetId);
    if (!asset) return;
    if (trackKind === 'overlay' && asset.kind !== 'image') { onNotice('贴图轨只能放图片素材，视频请放进视频轨'); return; }
    // 图片没有时长，作为片段默认占 5 秒
    const durationSec = asset.kind === 'image' ? 5 : asset.durationSec;
    const clip = addClip({ id: asset.id, kind: asset.kind, durationSec }, trackKind, startAt);
    if (clip) onNotice(`已把「${asset.originalName}」加入${trackKind === 'overlay' ? '贴图轨' : '视频轨'}`);
  }, [addClip, assetById, onNotice]);

  const onTrackDrop = (event: React.DragEvent<HTMLDivElement>, trackKind: Track['kind']) => {
    event.preventDefault();
    const assetId = event.dataTransfer.getData('application/x-canvora-asset');
    if (!assetId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = Math.max(0, (event.clientX - rect.left) / zoom);
    const targetTrack = timeline.tracks.find((track) => track.kind === trackKind);
    const trackClips = targetTrack ? [...targetTrack.clips].sort((a, b) => a.startAt - b.startAt) : [];
    // 轨道为空时第一段直接贴到起点：否则很容易在开头留下看不见的空隙，拖动播放头会看到黑屏
    if (trackClips.length === 0) { addAsset(assetId, 0, trackKind); return; }
    // 否则吸附到轨道起点、播放头和已有片段的边缘
    const threshold = 10 / zoom;
    const anchors = [0, playhead, ...trackClips.flatMap((clip) => [clip.startAt, clip.startAt + clipTimelineDuration(clip)])];
    const nearest = anchors.reduce((best, candidate) => Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best, raw);
    addAsset(assetId, Math.abs(nearest - raw) <= threshold ? nearest : raw, trackKind);
  };

  // ── 拖动片段改位置：可跨同类型轨道，吸附到 0 / 播放头 / 其他片段边缘，store 侧保证不重叠 ──
  const onClipBodyPointerDown = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    event.stopPropagation();
    selectClip(clip.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const originStart = clip.startAt;
    let dragging = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
      if (!dragging) { dragging = true; setDraggingClipId(clip.id); }
      const state = useTimelineStore.getState();
      const target = Math.max(0, originStart + (moveEvent.clientX - startX) / state.zoom);
      const element = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const trackEl = element?.closest('.timeline-track') as HTMLElement | null;
      const hoveredTrackId = trackEl?.dataset.trackId;
      const source = state.timeline.tracks.find((track) => track.clips.some((item) => item.id === clip.id));
      const hovered = hoveredTrackId ? state.timeline.tracks.find((track) => track.id === hoveredTrackId) : undefined;
      const destination = hovered && source && hovered.kind === source.kind ? hovered : source;
      if (!source || !destination) return;
      // 吸附：轨道起点、播放头、目标轨上其他片段的边缘
      const others = destination.clips.filter((item) => item.id !== clip.id);
      const anchors = [0, state.playhead, ...others.flatMap((item) => [item.startAt, item.startAt + clipTimelineDuration(item)])];
      const threshold = 8 / state.zoom;
      const snapped = anchors.reduce((best, anchor) => Math.abs(anchor - target) < Math.abs(best - target) ? anchor : best, target);
      state.moveClip(clip.id, destination.id, Math.abs(snapped - target) <= threshold ? snapped : target);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDraggingClipId(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // ── 预览区直接拖贴图调位置（相对画面显示矩形换算成归一化坐标，和导出语义一致）──
  const onOverlayPreviewPointerDown = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    event.preventDefault();
    event.stopPropagation();
    selectClip(clip.id);
    const box = (event.currentTarget.parentElement as HTMLElement | null)?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const layout = clip.layout ?? defaultOverlayLayout();
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = layout.x;
    const originY = layout.y;
    const onMove = (moveEvent: PointerEvent) => {
      const x = Math.min(1, Math.max(0, originX + (moveEvent.clientX - startX) / box.width));
      const y = Math.min(1, Math.max(0, originY + (moveEvent.clientY - startY) / box.height));
      setClipLayout(clip.id, { x, y });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // ── 标尺刷选：按住左右拖动连续改播放头 ──
  const scrubTo = useCallback((clientX: number) => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPlayhead(Math.max(0, (clientX - rect.left) / zoom));
  }, [setPlayhead, zoom]);
  const onRulerPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    scrubTo(event.clientX);
    const onMove = (moveEvent: PointerEvent) => scrubTo(moveEvent.clientX);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  // 片段左右边缘拖拽。**默认是裁剪**：往左拉右边缘 = 只保留 1~7 秒这种（源时长真的变短）。
  // 双击片段切换到变速模式后，拖边缘才是改速度、源时长不变。
  const onEdgePointerDown = (event: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'left' | 'right') => {
    event.stopPropagation();
    selectClip(clip.id);
    const mode = edgeModes[clip.id] ?? 'trim';
    const startX = event.clientX;
    const original = { startAt: clip.startAt, inPoint: clip.inPoint, outPoint: clip.outPoint, speed: clip.speed };
    const sourceDuration = original.outPoint - original.inPoint;
    let badge = mode === 'trim' ? `裁剪 ${sourceDuration.toFixed(2)}秒` : `${original.speed.toFixed(2)}x`;
    setSpeedBadge(badge);

    const onMove = (moveEvent: PointerEvent) => {
      const deltaSeconds = (moveEvent.clientX - startX) / zoom;
      // 图片是静止画面，出点可以任意延长（上限 1 小时兜底）；视频受素材本身时长限制
      const asset = assetById.get(clip.assetId);
      const assetDuration = asset?.kind === 'image' ? 3600 : asset?.durationSec ?? original.outPoint;
      if (mode === 'trim') {
        if (edge === 'right') {
          const outPoint = Math.max(original.inPoint + 0.1, Math.min(original.outPoint + deltaSeconds, assetDuration));
          updateClip(clip.id, { outPoint });
          badge = `裁剪：保留 ${original.inPoint.toFixed(2)} ~ ${outPoint.toFixed(2)} 秒`;
        } else {
          const inPoint = Math.max(0, Math.min(original.outPoint - 0.1, original.inPoint + deltaSeconds));
          // 左边缘裁剪时，片段在时间轴上的起点跟着右移，避免内容错位
          const delta = inPoint - original.inPoint;
          updateClip(clip.id, { inPoint, startAt: Math.max(0, original.startAt + delta) });
          badge = `裁剪：保留 ${inPoint.toFixed(2)} ~ ${original.outPoint.toFixed(2)} 秒`;
        }
      } else if (edge === 'right') {
        // 变速：源时长不变，改变时间轴占用
        const newTimelineDuration = sourceDuration / original.speed + deltaSeconds;
        const clamped = Math.max(sourceDuration / MAX_SPEED, Math.min(sourceDuration / MIN_SPEED, newTimelineDuration));
        const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, sourceDuration / clamped));
        updateClip(clip.id, { speed });
        badge = `${speed.toFixed(2)}x${speed <= MIN_SPEED + 1e-6 ? '（已最慢）' : speed >= MAX_SPEED - 1e-6 ? '（已最快）' : ''}`;
      } else {
        const newTimelineDuration = sourceDuration / original.speed - deltaSeconds;
        const clamped = Math.max(sourceDuration / MAX_SPEED, Math.min(sourceDuration / MIN_SPEED, newTimelineDuration));
        const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, sourceDuration / clamped));
        updateClip(clip.id, { speed, startAt: Math.max(0, original.startAt + (sourceDuration / original.speed - sourceDuration / speed)) });
        badge = `${speed.toFixed(2)}x`;
      }
      setSpeedBadge(badge);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setSpeedBadge(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
      if (event.key === 'ArrowRight') setPlayhead(playhead + (event.shiftKey ? 1 : 1 / timeline.fps));
      if (event.key === 'ArrowLeft') setPlayhead(Math.max(0, playhead - (event.shiftKey ? 1 : 1 / timeline.fps)));
      if (event.key === 'Home') setPlayhead(0);
      if (event.key === 'End') setPlayhead(total);
      if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey) {
        if (splitAt(playhead)) onNotice('已在播放头处分割'); else onNotice('播放头不在任何主轨片段内部，没法分割');
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedClipId) {
        removeClip(selectedClipId, !event.altKey);
        onNotice(event.altKey ? '已删除片段并保留空隙' : '已删除片段，后面的片段已前移');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNotice, playhead, playing, removeClip, selectedClipId, setPlayhead, splitAt, timeline.fps, togglePlay, total]);

  const doExport = () => {
    const state = useTimelineStore.getState();
    const edl = buildEdl(
      (assetId) => {
        const asset = assetById.get(assetId);
        if (!asset) return null;
        // 后端用工作区里的绝对路径读文件
        return `${root.replace(/\/$/, '')}/${asset.relPath}`;
      },
      (assetId) => Boolean(assetById.get(assetId)?.hasAudio),
      (assetId) => assetById.get(assetId)?.kind === 'image' ? 'image' : 'video',
    );
    if (!edl.clips.length) { onNotice('时间轴还没有片段，先把素材拖进来'); return; }
    const hints: string[] = [];
    const main = mainVideoTrackOf(state.timeline);
    const mainClips = [...(main?.clips ?? [])].filter((clip) => clip.enabled).sort((a, b) => a.startAt - b.startAt);
    const hasGap = mainClips.some((clip, index) => index > 0 && clip.startAt > (mainClips[index - 1].startAt + clipTimelineDuration(mainClips[index - 1])) + 0.05);
    if (hasGap) hints.push('主轨片段之间有空隙，导出按顺序拼接，空隙会被剪掉');
    const extraClips = state.timeline.tracks.filter((track) => track.kind === 'video' && track.id !== main?.id).flatMap((track) => track.clips).filter((clip) => clip.enabled).length;
    if (extraClips > 0) hints.push(`只有第一条视频轨会导出成片，其他视频轨上的 ${extraClips} 个片段不参与导出`);
    if (hints.length) onNotice(hints.join('；'));
    onExport({ ...settings, width: timeline.width, height: timeline.height, fps: timeline.fps });
    if (!hints.length) onNotice('已提交导出任务');
  };

  const ticks = useMemo(() => {
    const step = zoom > 90 ? 1 : zoom > 40 ? 2 : 5;
    const count = Math.ceil(Math.max(10, total + 5) / step) + 1;
    return Array.from({ length: count }, (_, index) => index * step);
  }, [total, zoom]);

  const renderClip = (clip: Clip) => {
    const asset = assetById.get(clip.assetId);
    const width = clipTimelineDuration(clip) * zoom;
    const mode = edgeModes[clip.id] ?? 'trim';
    const isOverlay = clip.layout !== undefined;
    return <div
      className={`timeline-clip ${selectedClipId === clip.id ? 'selected' : ''} mode-${mode} ${clip.enabled ? '' : 'disabled'} ${clip.audioMode === 'mute' ? 'muted' : ''} ${isOverlay ? 'overlay-clip' : ''} ${draggingClipId === clip.id ? 'dragging' : ''}`}
      key={clip.id}
      style={{ left: clip.startAt * zoom, width: Math.max(12, width) }}
      onPointerDown={(event) => onClipBodyPointerDown(event, clip)}
      onDoubleClick={() => { toggleEdgeMode(clip.id); onNotice(mode === 'trim' ? '已切到变速模式：拖边缘改速度，源时长不变' : '已切回裁剪模式：拖边缘就是裁掉内容'); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); selectClip(clip.id); setClipMenu({ clientX: event.clientX, clientY: event.clientY, clipId: clip.id }); }}
      title={`${asset?.originalName ?? '素材'} · 按住拖动改变位置 · 当前「${mode === 'trim' ? '裁剪' : '变速'}」模式（双击切换）· 右键更多操作`}
    >
      {asset && <img className="clip-thumb" src={assetThumbUrl(root, asset.id)} alt="" draggable={false} />}
      <span className="clip-name">{asset?.originalName ?? '素材'}</span>
      <span className="clip-badge">{isOverlay ? `宽 ${Math.round((clip.layout?.widthRatio ?? 0.28) * 100)}%` : mode === 'trim' ? `保留${(clip.outPoint - clip.inPoint).toFixed(1)}s` : `${clip.speed.toFixed(2)}x`}</span>
      <div className="clip-edge left" onPointerDown={(event) => onEdgePointerDown(event, clip, 'left')} />
      <div className="clip-edge right" onPointerDown={(event) => onEdgePointerDown(event, clip, 'right')} />
    </div>;
  };

  const selectedClip = selectedClipId ? findClip(timeline, selectedClipId) : null;
  const selectedIsOverlay = selectedClip?.layout !== undefined;
  const gradeRows: Array<{ label: string; key: 'brightness' | 'contrast' | 'saturation' | 'temperature'; min: number; max: number; base: number }> = [
    { label: '亮度', key: 'brightness', min: -1, max: 1, base: 0 },
    { label: '对比度', key: 'contrast', min: 0, max: 3, base: 1 },
    { label: '饱和度', key: 'saturation', min: 0, max: 3, base: 1 },
    { label: '色温', key: 'temperature', min: -1, max: 1, base: 0 },
  ];

  return <section className="timeline-editor">
    <div className="timeline-toolbar">
      <button className="small-button" onClick={togglePlay}>{playing ? '暂停' : '播放'}</button>
      <button className="small-button" onClick={() => setPlayhead(Math.max(0, playhead - 1 / timeline.fps))}>上一帧</button>
      <button className="small-button" onClick={() => setPlayhead(playhead + 1 / timeline.fps)}>下一帧</button>
      <button className="small-button" onClick={() => { if (splitAt(playhead)) onNotice('已在播放头处分割'); else onNotice('播放头不在任何主轨片段内部'); }}>分割（S）</button>
      <button className="small-button" onClick={() => { if (selectedClipId) { removeClip(selectedClipId, true); onNotice('已删除片段'); } }}>删除</button>
      <span className="timecode">{formatTime(playhead)} / {formatTime(total)}</span>
      <span className="muted tiny">缩放</span>
      <input type="range" min={8} max={240} value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
      <span className="muted tiny">分辨率</span>
      <select value={`${timeline.height}`} onChange={(event) => {
        const map: Record<string, [number, number]> = { '480': [854, 480], '720': [1280, 720], '1080': [1920, 1080], '1440': [2560, 1440], '2160': [3840, 2160] };
        const [width, height] = map[event.target.value] ?? [1920, 1080];
        useTimelineStore.getState().setTimeline({ ...timeline, width, height });
      }}>
        {[['480', '480p'], ['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <span className="muted tiny">CRF</span>
      <input className="crf-input" type="number" min={0} max={51} value={settings.crf} onChange={(event) => setSettings({ ...settings, crf: Number(event.target.value) })} />
      <button className="primary-button small" onClick={doExport}>导出成片</button>
      <span className="muted tiny">拖片段移动 · 拖边缘裁剪 · 双击切变速 · 在预览里拖贴图定位 · 预览为低清近似，导出为原画质</span>
    </div>
    <div className="timeline-main">
      <div className="timeline-preview" ref={previewRef}>
        {activeAsset
          ? <div className="preview-stage">
            <div className="preview-media-box" style={mediaBox ? { left: mediaBox.left, top: mediaBox.top, width: mediaBox.width, height: mediaBox.height } : undefined}>
              {activeAsset.kind === 'video'
                ? <video
                  ref={videoRef}
                  src={assetFileUrl(root, activeAsset.id)}
                  preload="auto"
                  playsInline
                  style={{ filter: gradeCssFilter(activeClip?.colorGrade) }}
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    setVideoDimensions({ w: video.videoWidth, h: video.videoHeight });
                    try { video.currentTime = desiredSourceTimeRef.current; } catch { /* 忽略 */ }
                  }}
                />
                : <img className="preview-still" src={assetFileUrl(root, activeAsset.id)} alt="" draggable={false} style={{ filter: gradeCssFilter(activeClip?.colorGrade) }} />}
              {activeAsset.kind === 'video' && gradeTintStyle(activeClip?.colorGrade) && <div className="preview-tint" style={gradeTintStyle(activeClip?.colorGrade) ?? undefined} />}
              {previewOverlays.map((overlayClip) => {
                const overlayAsset = assetById.get(overlayClip.assetId);
                const layout = overlayClip.layout ?? defaultOverlayLayout();
                return <div
                  key={overlayClip.id}
                  className={`preview-overlay ${selectedClipId === overlayClip.id ? 'selected' : ''}`}
                  style={{ left: `${layout.x * 100}%`, top: `${layout.y * 100}%`, width: `${layout.widthRatio * 100}%`, opacity: layout.opacity }}
                  onPointerDown={(event) => onOverlayPreviewPointerDown(event, overlayClip)}
                  title="按住拖动调整贴图位置"
                >
                  {overlayAsset && <img src={assetFileUrl(root, overlayAsset.id)} alt="" draggable={false} />}
                </div>;
              })}
            </div>
          </div>
          : <div className="preview-empty">{clips.length ? '播放头在空白区间，拖上方标尺或按 Home 回到开头' : '把素材拖到下面的轨道上开始剪辑'}</div>}
      </div>
      <div className="timeline-tracks" ref={tracksScrollRef} onPointerDown={() => selectClip(null)}>
        <div className="timeline-content" style={{ width: contentWidth }}>
          <div className="timeline-ruler" ref={rulerRef} onPointerDown={onRulerPointerDown}>
            {ticks.map((tick) => <span key={tick} className="tick" style={{ left: tick * zoom }}>{formatTime(tick)}</span>)}
          </div>
          {timeline.tracks.map((track) => {
            const trackClips = [...track.clips].sort((a, b) => a.startAt - b.startAt);
            const label = track.kind === 'video' ? '视频轨' : track.kind === 'overlay' ? '贴图轨' : '音频轨';
            return <div
              className={`timeline-track ${track.kind}-track`}
              key={track.id}
              data-track-id={track.id}
              data-track-kind={track.kind}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => onTrackDrop(event, track.kind)}
              onContextMenu={(event) => { event.preventDefault(); setTrackMenu({ clientX: event.clientX, clientY: event.clientY, trackId: track.id }); }}
            >
              <span className="track-tag">{label} {track.index + 1}</span>
              <div className="track-line">{trackClips.map(renderClip)}</div>
              {!trackClips.length && <div className="track-hint">{track.kind === 'video' ? '把素材库或画布上的图片/视频拖到这里' : track.kind === 'overlay' ? '贴图轨：拖图片进来，导出时会叠在画面上' : '音频轨（本期保留）'}</div>}
            </div>;
          })}
          <div className="track-actions">
            <button onClick={() => addTrack('video')}>＋ 视频轨</button>
            <button onClick={() => addTrack('overlay')}>＋ 贴图轨</button>
          </div>
          <div className="playhead" style={{ left: playhead * zoom }} />
          {speedBadge && <div className="speed-badge" style={{ left: playhead * zoom }}>{speedBadge}</div>}
        </div>
      </div>
    </div>
    {selectedClip && <div className="clip-inspector">
      {(() => {
        const clip = selectedClip;
        const asset = assetById.get(clip.assetId);
        const grade = clip.colorGrade ?? {};
        const layout = clip.layout ?? defaultOverlayLayout();
        return <>
          <strong>{asset?.originalName ?? '素材'}</strong>
          <span>源时长 {(clip.outPoint - clip.inPoint).toFixed(2)} 秒</span>
          <span>时间轴占用 {clipTimelineDuration(clip).toFixed(2)} 秒</span>
          {!selectedIsOverlay && <>
            <label>速度<input type="number" min={MIN_SPEED} max={MAX_SPEED} step={0.1} value={clip.speed} onChange={(event) => updateClip(clip.id, { speed: Math.max(MIN_SPEED, Math.min(MAX_SPEED, Number(event.target.value) || 1)) })} /></label>
            <label>音频
              <select value={clip.audioMode} onChange={(event) => updateClip(clip.id, { audioMode: event.target.value as Clip['audioMode'] })}>
                <option value="keep">保留原声并变速</option>
                <option value="mute">静音</option>
                <option value="keepPitchCorrected">保留原声并保持音调</option>
              </select>
            </label>
          </>}
          {selectedIsOverlay && <>
            <span className="muted tiny">贴图设置（也可以直接在左侧预览里拖动）：</span>
            <label>横向 x<input type="number" min={0} max={1} step={0.01} value={layout.x} onChange={(event) => setClipLayout(clip.id, { x: Math.min(1, Math.max(0, Number(event.target.value))) })} /></label>
            <label>纵向 y<input type="number" min={0} max={1} step={0.01} value={layout.y} onChange={(event) => setClipLayout(clip.id, { y: Math.min(1, Math.max(0, Number(event.target.value))) })} /></label>
            <label>宽度<input type="number" min={0.02} max={1} step={0.01} value={layout.widthRatio} onChange={(event) => setClipLayout(clip.id, { widthRatio: Math.min(1, Math.max(0.02, Number(event.target.value))) })} /></label>
            <label>不透明度<input type="number" min={0} max={1} step={0.05} value={layout.opacity} onChange={(event) => setClipLayout(clip.id, { opacity: Math.min(1, Math.max(0, Number(event.target.value))) })} /></label>
            <label>淡入(秒)<input type="number" min={0} max={10} step={0.1} value={layout.fadeInSec} onChange={(event) => setClipLayout(clip.id, { fadeInSec: Math.max(0, Number(event.target.value) || 0) })} /></label>
            <label>淡出(秒)<input type="number" min={0} max={10} step={0.1} value={layout.fadeOutSec} onChange={(event) => setClipLayout(clip.id, { fadeOutSec: Math.max(0, Number(event.target.value) || 0) })} /></label>
          </>}
          {!selectedIsOverlay && <span className="grade-group">
            {gradeRows.map((row) => <label key={row.key} className="grade-row">{row.label}
              <input type="range" min={row.min} max={row.max} step={0.05} value={grade[row.key] ?? row.base}
                onChange={(event) => setClipGrade(clip.id, { [row.key]: Number(event.target.value) })} />
              <span className="grade-value">{(grade[row.key] ?? row.base).toFixed(2)}</span>
            </label>)}
            <button className="small-button" onClick={() => updateClip(clip.id, { colorGrade: undefined })}>重置调色</button>
          </span>}
          <span className="muted tiny">拖片段边缘 = {((edgeModes[clip.id] ?? 'trim')) === 'trim' ? '裁剪（保留入点~出点）' : '变速（源时长不变）'}，双击片段可切换</span>
        </>;
      })()}
    </div>}
    {clipMenu && (() => {
      const clip = findClip(timeline, clipMenu.clipId);
      if (!clip) return null;
      const mode = edgeModes[clip.id] ?? 'trim';
      const close = () => setClipMenu(null);
      const isOverlayClip = clip.layout !== undefined;
      const style = { left: Math.min(clipMenu.clientX, window.innerWidth - 230), top: Math.min(clipMenu.clientY, window.innerHeight - 340) };
      return <div className="context-menu" style={style} onPointerDown={(event) => event.stopPropagation()}>
        <div className="context-title">片段操作</div>
        <button className="context-item wide" onClick={() => {
          if (isOverlayClip) { onNotice('贴图片段暂不支持分割'); close(); return; }
          if (splitAt(playhead)) onNotice('已在播放头处分割'); else onNotice('请先把播放头拖到这个片段内部再分割');
          close();
        }}>
          <span className="context-icon">✂</span><span className="context-label">在播放头处分割</span><span className="context-hint">快捷键 S</span>
        </button>
        <button className="context-item wide" onClick={() => { duplicateClip(clip.id); onNotice('已复制片段到它后面'); close(); }}>
          <span className="context-icon">⧉</span><span className="context-label">复制片段</span><span className="context-hint">复制到本片段之后</span>
        </button>
        <button className="context-item wide" onClick={() => { removeClip(clip.id, true); onNotice('已删除片段，后面的片段已前移'); close(); }}>
          <span className="context-icon">⇤</span><span className="context-label">删除并前移</span><span className="context-hint">Delete</span>
        </button>
        <button className="context-item wide" onClick={() => { removeClip(clip.id, false); onNotice('已删除片段并保留空隙'); close(); }}>
          <span className="context-icon">×</span><span className="context-label">删除并保留空隙</span><span className="context-hint">Alt+Delete</span>
        </button>
        <button className="context-item wide" onClick={() => { toggleClipMuted(clip.id); onNotice(clip.audioMode === 'mute' ? '已恢复原声' : '已静音这个片段'); close(); }}>
          <span className="context-icon">{clip.audioMode === 'mute' ? '🔊' : '🔇'}</span><span className="context-label">{clip.audioMode === 'mute' ? '恢复原声' : '静音这个片段'}</span><span className="context-hint">只影响这段</span>
        </button>
        <button className="context-item wide" onClick={() => { toggleClipEnabled(clip.id); onNotice(clip.enabled ? '已在导出中跳过这个片段' : '已恢复这个片段'); close(); }}>
          <span className="context-icon">{clip.enabled ? '◻' : '◼'}</span><span className="context-label">{clip.enabled ? '导出时跳过这段' : '恢复参与导出'}</span><span className="context-hint">不删除，只是不导出</span>
        </button>
        <button className="context-item wide" onClick={() => { setEdgeMode(clip.id, mode === 'trim' ? 'speed' : 'trim'); onNotice(mode === 'trim' ? '已切到变速模式：拖边缘改速度，源时长不变' : '已切回裁剪模式：拖边缘就是裁掉内容'); close(); }}>
          <span className="context-icon">⇄</span><span className="context-label">切到{mode === 'trim' ? '变速' : '裁剪'}模式</span><span className="context-hint">当前是{mode === 'trim' ? '裁剪' : '变速'}（双击片段也能切）</span>
        </button>
      </div>;
    })()}
    {trackMenu && (() => {
      const track = timeline.tracks.find((item) => item.id === trackMenu.trackId);
      if (!track) return null;
      const style = { left: Math.min(trackMenu.clientX, window.innerWidth - 230), top: Math.min(trackMenu.clientY, window.innerHeight - 200) };
      return <div className="context-menu" style={style} onPointerDown={(event) => event.stopPropagation()}>
        <div className="context-title">轨道操作（{track.kind === 'video' ? '视频轨' : track.kind === 'overlay' ? '贴图轨' : '音频轨'}）</div>
        <button className="context-item wide" onClick={() => { addTrack(track.kind); onNotice('已新增一条同类轨道'); setTrackMenu(null); }}>
          <span className="context-icon">＋</span><span className="context-label">新增一条同类轨道</span><span className="context-hint">可以把素材分层摆放</span>
        </button>
        <button className="context-item wide" onClick={() => { removeTrack(track.id); onNotice('已删除这条轨道'); setTrackMenu(null); }}>
          <span className="context-icon">×</span><span className="context-label">删除这条轨道</span><span className="context-hint">轨道上的片段一并移除</span>
        </button>
      </div>;
    })()}
  </section>;
}
