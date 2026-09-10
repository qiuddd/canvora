import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, Clip, ExportSettings, Timeline } from '@canvora/shared';
import { clipTimelineDuration } from '@canvora/shared';
import { assetFileUrl, assetThumbUrl } from '../api/client';
import { defaultExportSettings, useTimelineStore } from '../stores/timeline-store';

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
  const removeClip = useTimelineStore((state) => state.removeClip);
  const splitAt = useTimelineStore((state) => state.splitAt);
  const toggleEdgeMode = useTimelineStore((state) => state.toggleEdgeMode);
  const buildEdl = useTimelineStore((state) => state.buildEdl);

  const [settings, setSettings] = useState<ExportSettings>(() => defaultExportSettings(timeline));
  const [speedBadge, setSpeedBadge] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const videoTrack = timeline.tracks.find((track) => track.kind === 'video');
  const clips = useMemo(() => [...(videoTrack?.clips ?? [])].sort((a, b) => a.startAt - b.startAt), [videoTrack]);
  const total = clips.reduce((max, clip) => Math.max(max, clip.startAt + clipTimelineDuration(clip)), 0);
  const assetById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  const activeClip: Clip | null = useMemo(() => clips.find((clip) => playhead >= clip.startAt && playhead < clip.startAt + clipTimelineDuration(clip)) ?? null, [clips, playhead]);
  const activeAsset = activeClip ? assetById.get(activeClip.assetId) ?? null : null;
  const sourceTime = activeClip ? activeClip.inPoint + (playhead - activeClip.startAt) * activeClip.speed : 0;

  // 预览：只挂载播放头所在片段的视频，seek 到源时间；播放时用同一元素推进。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeClip) return;
    const target = Math.max(0, sourceTime);
    if (Math.abs(video.currentTime - target) > 0.25) video.currentTime = target;
    video.playbackRate = Math.min(4, Math.max(0.25, activeClip.speed));
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [activeClip, sourceTime, playing]);

  // 走带：按真实时间推进播放头，跨片段时由上面的 effect 换源。
  useEffect(() => {
    if (!playing) { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; return; }
    lastTickRef.current = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      const next = playhead + dt;
      if (total > 0 && next >= total) { setPlayhead(total); setPlaying(false); return; }
      setPlayhead(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playing, playhead, setPlayhead, setPlaying, total]);

  const addAsset = useCallback((assetId: string, startAt?: number) => {
    const asset = assetById.get(assetId);
    if (!asset) return;
    if (asset.kind === 'image') { onNotice('图片作为片段时默认占 5 秒（本期时间轴只支持视频片段）'); }
    const clip = addClip({ id: asset.id, kind: asset.kind, durationSec: asset.kind === 'image' ? 5 : asset.durationSec }, 'video', startAt);
    if (clip) onNotice(`已把「${asset.originalName}」加入时间轴`);
  }, [addClip, assetById, onNotice]);

  const onTrackDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const assetId = event.dataTransfer.getData('application/x-canvora-asset');
    if (!assetId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const raw = Math.max(0, (event.clientX - rect.left) / zoom);
    // 轨道为空时第一段直接贴到起点：否则很容易在开头留下看不见的空隙，拖动播放头会看到黑屏
    if (clips.length === 0) { addAsset(assetId, 0); return; }
    // 否则吸附到轨道起点、播放头和已有片段的边缘
    const threshold = 10 / zoom;
    const anchors = [0, playhead, ...clips.flatMap((clip) => [clip.startAt, clip.startAt + clipTimelineDuration(clip)])];
    const nearest = anchors.reduce((best, candidate) => Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best, raw);
    addAsset(assetId, Math.abs(nearest - raw) <= threshold ? nearest : raw);
  };

  // 片段左右边缘拖拽：默认改速度（源时长不变），切到裁剪模式则改入点/出点。
  const onEdgePointerDown = (event: React.PointerEvent<HTMLDivElement>, clip: Clip, edge: 'left' | 'right') => {
    event.stopPropagation();
    selectClip(clip.id);
    const mode = edgeModes[clip.id] ?? 'speed';
    const startX = event.clientX;
    const original = { startAt: clip.startAt, inPoint: clip.inPoint, outPoint: clip.outPoint, speed: clip.speed };
    const sourceDuration = original.outPoint - original.inPoint;
    let badge = mode === 'speed' ? `${original.speed.toFixed(2)}x` : '裁剪';
    setSpeedBadge(badge);
    const target = event.currentTarget;

    const onMove = (moveEvent: PointerEvent) => {
      const deltaSeconds = (moveEvent.clientX - startX) / zoom;
      if (mode === 'speed') {
        const newTimelineDuration = edge === 'right'
          ? (original.outPoint - original.inPoint) / original.speed + deltaSeconds
          : original.startAt + clipTimelineDuration({ ...clip, ...original }) - (original.startAt + deltaSeconds);
        const clampedDuration = Math.max(sourceDuration / MAX_SPEED, Math.min(sourceDuration / MIN_SPEED, newTimelineDuration));
        const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, sourceDuration / clampedDuration));
        const patch: Partial<Clip> = { speed };
        if (edge === 'left') patch.startAt = Math.max(0, original.startAt + (sourceDuration / original.speed - sourceDuration / speed));
        updateClip(clip.id, patch);
        badge = `${speed.toFixed(2)}x${speed <= MIN_SPEED + 1e-6 ? '（已最慢）' : speed >= MAX_SPEED - 1e-6 ? '（已最快）' : ''}`;
      } else if (edge === 'right') {
        const outPoint = Math.max(original.inPoint + 0.1, Math.min(original.outPoint + deltaSeconds * original.speed, original.outPoint + 600));
        updateClip(clip.id, { outPoint });
        badge = `裁剪 ${(outPoint - original.inPoint).toFixed(1)}秒`;
      } else {
        const inPoint = Math.max(0, Math.min(original.outPoint - 0.1, original.inPoint + deltaSeconds * original.speed));
        const delta = inPoint - original.inPoint;
        updateClip(clip.id, { inPoint, startAt: Math.max(0, original.startAt + delta / original.speed) });
        badge = `裁剪 ${(original.outPoint - inPoint).toFixed(1)}秒`;
      }
      setSpeedBadge(badge);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setSpeedBadge(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    // 指针捕获放在监听之后并容错：捕获失败不能让整段拖拽逻辑中断
    try { target.setPointerCapture(event.pointerId); } catch { /* 合成事件没有活动指针时会失败，忽略即可 */ }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
      if (event.key === 'ArrowRight') setPlayhead(playhead + (event.shiftKey ? 1 : 1 / timeline.fps));
      if (event.key === 'ArrowLeft') setPlayhead(Math.max(0, playhead - (event.shiftKey ? 1 : 1 / timeline.fps)));
      if (event.key === 'Home') setPlayhead(0);
      if (event.key === 'End') setPlayhead(total);
      if (event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey) {
        if (splitAt(playhead)) onNotice('已在播放头处分割'); else onNotice('播放头不在任何片段内部，没法分割');
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedClipId) {
        removeClip(selectedClipId, !event.altKey);
        onNotice(event.altKey ? '已删除片段并保留空隙' : '已删除片段，后面的片段已前移');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNotice, playhead, playing, removeClip, selectedClipId, setPlayhead, setPlaying, splitAt, timeline.fps, total]);

  const doExport = () => {
    const edl = buildEdl(
      (assetId) => {
        const asset = assetById.get(assetId);
        if (!asset) return null;
        // 后端用工作区里的绝对路径读文件
        return `${root.replace(/\/$/, '')}/${asset.relPath}`;
      },
      (assetId) => Boolean(assetById.get(assetId)?.hasAudio),
    );
    if (!edl.clips.length) { onNotice('时间轴还没有片段，先把素材拖进来'); return; }
    onExport({ ...settings, width: timeline.width, height: timeline.height, fps: timeline.fps });
    onNotice('已提交导出任务');
  };

  const ticks = useMemo(() => {
    const step = zoom > 90 ? 1 : zoom > 40 ? 2 : 5;
    const count = Math.ceil(Math.max(10, total + 5) / step) + 1;
    return Array.from({ length: count }, (_, index) => index * step);
  }, [total, zoom]);

  const renderClip = (clip: Clip) => {
    const asset = assetById.get(clip.assetId);
    const width = clipTimelineDuration(clip) * zoom;
    const mode = edgeModes[clip.id] ?? 'speed';
    return <div
      className={`timeline-clip ${selectedClipId === clip.id ? 'selected' : ''} mode-${mode}`}
      key={clip.id}
      style={{ left: clip.startAt * zoom, width: Math.max(12, width) }}
      onPointerDown={(event) => { event.stopPropagation(); selectClip(clip.id); }}
      onDoubleClick={() => toggleEdgeMode(clip.id)}
      title={`${asset?.originalName ?? '素材'} · ${mode === 'speed' ? '拖动边缘改变速度（双击切换模式）' : '拖动边缘裁剪（双击切换模式）'}`}
    >
      {asset && <img className="clip-thumb" src={assetThumbUrl(root, asset.id)} alt="" />}
      <span className="clip-name">{asset?.originalName ?? '素材'}</span>
      <span className="clip-badge">{clip.speed === 1 ? (mode === 'speed' ? '1.0x' : '裁剪') : `${clip.speed.toFixed(2)}x`}</span>
      <div className="clip-edge left" onPointerDown={(event) => onEdgePointerDown(event, clip, 'left')} />
      <div className="clip-edge right" onPointerDown={(event) => onEdgePointerDown(event, clip, 'right')} />
    </div>;
  };

  return <section className="timeline-editor">
    <div className="timeline-toolbar">
      <button className="small-button" onClick={() => setPlaying(!playing)}>{playing ? '暂停' : '播放'}</button>
      <button className="small-button" onClick={() => setPlayhead(Math.max(0, playhead - 1 / timeline.fps))}>上一帧</button>
      <button className="small-button" onClick={() => setPlayhead(playhead + 1 / timeline.fps)}>下一帧</button>
      <button className="small-button" onClick={() => { if (splitAt(playhead)) onNotice('已在播放头处分割'); else onNotice('播放头不在任何片段内部'); }}>分割（S）</button>
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
      <span className="muted tiny">预览为低清近似，导出为原画质</span>
    </div>
    <div className="timeline-main">
      <div className="timeline-preview">
        {activeAsset
          ? <video ref={videoRef} key={activeClip?.id} src={assetFileUrl(root, activeAsset.id)} controls={false} muted={false} playsInline />
          : <div className="preview-empty">{clips.length ? '播放头在空白区间，往右拖或按 Home 回到开头' : '把素材拖到下面的轨道上开始剪辑'}</div>}
      </div>
      <div className="timeline-tracks" onPointerDown={() => selectClip(null)}>
        <div className="timeline-ruler" onPointerDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPlayhead(Math.max(0, (event.clientX - rect.left) / zoom)); }}>
          {ticks.map((tick) => <span key={tick} className="tick" style={{ left: tick * zoom }}>{formatTime(tick)}</span>)}
        </div>
        <div className="timeline-track video-track" onDragOver={(event) => event.preventDefault()} onDrop={onTrackDrop}>
          <div className="track-line">{clips.map(renderClip)}</div>
          {!clips.length && <div className="track-hint">把素材库或画布上的视频拖到这里</div>}
        </div>
        <div className="timeline-track overlay-track"><div className="track-line" />{!clips.length && <div className="track-hint muted">贴图轨（本期只支持视频片段拼接）</div>}</div>
        <div className="playhead" style={{ left: playhead * zoom }} />
        {speedBadge && <div className="speed-badge" style={{ left: playhead * zoom }}>{speedBadge}</div>}
      </div>
    </div>
    {selectedClipId && <div className="clip-inspector">
      {(() => {
        const clip = clips.find((item) => item.id === selectedClipId);
        if (!clip) return null;
        const asset = assetById.get(clip.assetId);
        return <>
          <strong>{asset?.originalName ?? '素材'}</strong>
          <span>源时长 {(clip.outPoint - clip.inPoint).toFixed(2)} 秒</span>
          <span>时间轴占用 {clipTimelineDuration(clip).toFixed(2)} 秒</span>
          <label>速度<input type="number" min={MIN_SPEED} max={MAX_SPEED} step={0.1} value={clip.speed} onChange={(event) => updateClip(clip.id, { speed: Math.max(MIN_SPEED, Math.min(MAX_SPEED, Number(event.target.value) || 1)) })} /></label>
          <label>音频
            <select value={clip.audioMode} onChange={(event) => updateClip(clip.id, { audioMode: event.target.value as Clip['audioMode'] })}>
              <option value="keep">保留原声并变速</option>
              <option value="mute">静音</option>
              <option value="keepPitchCorrected">保留原声并保持音调</option>
            </select>
          </label>
          <span className="muted tiny">边缘拖拽当前是「{edgeModes[clip.id] === 'trim' ? '裁剪' : '变速'}」模式，双击片段可切换</span>
        </>;
      })()}
    </div>}
  </section>;
}
