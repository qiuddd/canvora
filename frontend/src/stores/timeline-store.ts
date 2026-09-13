import { create } from 'zustand';
import type { Clip, ColorGrade, Edl, EdlClip, ExportSettings, OverlayLayout, Timeline, Track } from '@canvora/shared';
import { clipTimelineDuration, defaultOverlayLayout, timelineDuration } from '@canvora/shared';

/** 时间轴状态独立于画布状态（AGENTS 硬约束：两个 store 不许混在一起）。 */
interface TimelineState {
  timeline: Timeline;
  playhead: number;
  playing: boolean;
  selectedClipId: string | null;
  /**
   * 片段边缘拖拽模式。**默认是裁剪**（往左拉就是把后半段裁掉，保留 1~7 秒这种），
   * 因为这才是剪辑软件的常规语义；变速模式需要双击片段显式切换。
   */
  edgeModes: Record<string, 'trim' | 'speed'>;
  zoom: number;
  setTimeline: (timeline: Timeline) => void;
  setPlayhead: (seconds: number) => void;
  setPlaying: (playing: boolean) => void;
  selectClip: (id: string | null) => void;
  toggleEdgeMode: (id: string) => void;
  setEdgeMode: (id: string, mode: 'trim' | 'speed') => void;
  duplicateClip: (clipId: string) => string | null;
  toggleClipMuted: (clipId: string) => void;
  toggleClipEnabled: (clipId: string) => void;
  addTrack: (kind: Track['kind']) => void;
  removeTrack: (trackId: string) => void;
  setZoom: (zoom: number) => void;
  addClip: (asset: { id: string; kind: string; durationSec?: number }, trackKind?: Track['kind'], startAt?: number) => Clip | null;
  /** 拖动片段改位置：跨同类型轨道移动，落点吸附到最近的空隙，绝不与已有片段重叠。 */
  moveClip: (clipId: string, targetTrackId: string, startAt: number) => void;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;
  setClipLayout: (clipId: string, patch: Partial<OverlayLayout>) => void;
  setClipGrade: (clipId: string, patch: Partial<ColorGrade>) => void;
  removeClip: (clipId: string, ripple: boolean) => void;
  splitAt: (seconds: number) => boolean;
  buildEdl: (
    resolvePath: (assetId: string) => string | null,
    resolveAudio: (assetId: string) => boolean,
    resolveKind?: (assetId: string) => 'image' | 'video' | undefined,
  ) => Edl;
}

const videoTrack = (): Track => ({ id: crypto.randomUUID(), kind: 'video', index: 0, muted: false, locked: false, clips: [] });
const overlayTrack = (): Track => ({ id: crypto.randomUUID(), kind: 'overlay', index: 0, muted: false, locked: false, clips: [] });

export const emptyTimeline = (projectId: string): Timeline => ({
  projectId, fps: 30, width: 1920, height: 1080, backgroundColor: '#000000',
  tracks: [videoTrack(), overlayTrack()],
});

const sortClips = (clips: Clip[]) => [...clips].sort((a, b) => a.startAt - b.startAt);

/** 主视频轨：预览与导出都以它为成片序列（后端 EDL 是顺序拼接模型）。 */
export const mainVideoTrackOf = (timeline: Timeline): Track | undefined => timeline.tracks.find((track) => track.kind === 'video');

export const useTimelineStore = create<TimelineState>((set, get) => ({
  timeline: emptyTimeline('local'),
  playhead: 0,
  playing: false,
  selectedClipId: null,
  edgeModes: {},
  zoom: 60,

  setTimeline: (timeline) => set({ timeline: { ...timeline, tracks: timeline.tracks.map((track) => ({ ...track, clips: sortClips(track.clips) })) } }),
  setPlayhead: (seconds) => set({ playhead: Math.max(0, seconds) }),
  setPlaying: (playing) => set({ playing }),
  selectClip: (selectedClipId) => set({ selectedClipId }),
  toggleEdgeMode: (id) => set((state) => ({ edgeModes: { ...state.edgeModes, [id]: state.edgeModes[id] === 'speed' ? 'trim' : 'speed' } })),
  setEdgeMode: (id, mode) => set((state) => ({ edgeModes: { ...state.edgeModes, [id]: mode } })),
  duplicateClip: (clipId) => {
    const state = get();
    for (const track of state.timeline.tracks) {
      const source = track.clips.find((clip) => clip.id === clipId);
      if (!source) continue;
      const duration = clipTimelineDuration(source);
      // 复制件放在源片段结束处；撞上后面的片段时由 addClip 同款推挤逻辑落到下一个空隙
      const copy: Clip = { ...source, id: crypto.randomUUID(), startAt: source.startAt + duration };
      const placed = placeWithoutOverlap(copy, track.clips.filter((clip) => clip.id !== clipId));
      set({
        timeline: { ...state.timeline, tracks: state.timeline.tracks.map((item) => item.id === track.id ? { ...item, clips: sortClips([...item.clips.filter((clip) => clip.id !== clipId), placed]) } : item) },
        selectedClipId: copy.id,
      });
      return copy.id;
    }
    return null;
  },
  toggleClipMuted: (clipId) => set((state) => ({
    timeline: { ...state.timeline, tracks: state.timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, audioMode: clip.audioMode === 'mute' ? 'keep' : 'mute' } : clip) })) },
  })),
  toggleClipEnabled: (clipId) => set((state) => ({
    timeline: { ...state.timeline, tracks: state.timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, enabled: !clip.enabled } : clip) })) },
  })),
  addTrack: (kind) => set((state) => {
    const sameKind = state.timeline.tracks.filter((track) => track.kind === kind);
    const track: Track = { id: crypto.randomUUID(), kind, index: sameKind.length, muted: false, locked: false, clips: [] };
    // 视频轨放在贴图轨之前，保持「主轨在上、叠加层在下」的直觉顺序
    const tracks = kind === 'video'
      ? [...state.timeline.tracks.filter((item) => item.kind === 'video'), track, ...state.timeline.tracks.filter((item) => item.kind !== 'video')]
      : [...state.timeline.tracks, track];
    return { timeline: { ...state.timeline, tracks } };
  }),
  removeTrack: (trackId) => set((state) => ({ timeline: { ...state.timeline, tracks: state.timeline.tracks.filter((track) => track.id !== trackId) } })),
  setZoom: (zoom) => set({ zoom: Math.min(400, Math.max(8, zoom)) }),

  addClip: (asset, trackKind = 'video', startAt) => {
    const state = get();
    const track = state.timeline.tracks.find((item) => item.kind === trackKind);
    if (!track) return null;
    const duration = Math.max(0.2, asset.durationSec && asset.durationSec > 0 ? asset.durationSec : 5);
    const last = track.clips.reduce((max, clip) => Math.max(max, clip.startAt + clipTimelineDuration(clip)), 0);
    const wanted: Clip = {
      id: crypto.randomUUID(),
      assetId: asset.id,
      inPoint: 0,
      outPoint: duration,
      startAt: Math.max(0, startAt ?? last),
      speed: 1,
      audioMode: 'keep',
      enabled: true,
      // 贴图轨片段带默认摆放：右上角、28% 宽，可在预览里直接拖动微调
      layout: trackKind === 'overlay' ? defaultOverlayLayout() : undefined,
    };
    const clip = placeWithoutOverlap(wanted, track.clips);
    set({
      timeline: { ...state.timeline, tracks: state.timeline.tracks.map((item) => item.id === track.id ? { ...item, clips: sortClips([...item.clips, clip]) } : item) },
      selectedClipId: clip.id,
    });
    return clip;
  },

  moveClip: (clipId, targetTrackId, startAt) => set((state) => {
    const source = state.timeline.tracks.find((track) => track.clips.some((clip) => clip.id === clipId));
    if (!source) return {};
    const target = state.timeline.tracks.find((track) => track.id === targetTrackId);
    if (!target || target.kind !== source.kind) return {};
    const clip = source.clips.find((item) => item.id === clipId);
    if (!clip) return {};
    const duration = clipTimelineDuration(clip);
    const others = target.clips.filter((item) => item.id !== clipId);
    const placed = placeWithoutOverlap({ ...clip, startAt: Math.max(0, startAt) }, others);
    const tracks = state.timeline.tracks.map((track) => {
      if (track.id === source.id && track.id === target.id) {
        return { ...track, clips: sortClips([...track.clips.filter((item) => item.id !== clipId), placed]) };
      }
      if (track.id === source.id) return { ...track, clips: track.clips.filter((item) => item.id !== clipId) };
      if (track.id === target.id) return { ...track, clips: sortClips([...track.clips, placed]) };
      return track;
    });
    return { timeline: { ...state.timeline, tracks } };
  }),

  updateClip: (clipId, patch) => set((state) => ({
    timeline: {
      ...state.timeline,
      tracks: state.timeline.tracks.map((track) => ({
        ...track,
        clips: sortClips(track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip)),
      })),
    },
  })),

  setClipLayout: (clipId, patch) => set((state) => ({
    timeline: {
      ...state.timeline,
      tracks: state.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, layout: { ...(clip.layout ?? defaultOverlayLayout()), ...patch } } : clip),
      })),
    },
  })),

  setClipGrade: (clipId, patch) => set((state) => ({
    timeline: {
      ...state.timeline,
      tracks: state.timeline.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, colorGrade: { ...(clip.colorGrade ?? {}), ...patch } } : clip),
      })),
    },
  })),

  removeClip: (clipId, ripple) => set((state) => {
    const tracks = state.timeline.tracks.map((track) => {
      const target = track.clips.find((clip) => clip.id === clipId);
      if (!target) return track;
      const removedDuration = clipTimelineDuration(target);
      const rest = track.clips.filter((clip) => clip.id !== clipId);
      // 默认让后面的片段前移补齐空隙（PRD F2）；按住 Alt 时保留空隙
      const shifted = ripple ? rest.map((clip) => clip.startAt > target.startAt ? { ...clip, startAt: Math.max(0, clip.startAt - removedDuration) } : clip) : rest;
      return { ...track, clips: sortClips(shifted) };
    });
    return { timeline: { ...state.timeline, tracks }, selectedClipId: null };
  }),

  splitAt: (seconds) => {
    const state = get();
    const track = mainVideoTrackOf(state.timeline);
    if (!track) return false;
    const target = track.clips.find((clip) => clip.enabled && seconds > clip.startAt + 0.05 && seconds < clip.startAt + clipTimelineDuration(clip) - 0.05);
    if (!target) return false;
    const elapsed = seconds - target.startAt;
    const cutSource = target.inPoint + elapsed * target.speed;
    const first: Clip = { ...target, outPoint: cutSource };
    const second: Clip = { ...target, id: crypto.randomUUID(), inPoint: cutSource, startAt: seconds };
    // 贴图按片段绑定，切开时跟随第一段（本期只做基础切分）
    set({
      timeline: {
        ...state.timeline,
        tracks: state.timeline.tracks.map((item) => item.id === track.id
          ? { ...item, clips: sortClips([...item.clips.filter((clip) => clip.id !== target.id), first, second]) }
          : item),
      },
      selectedClipId: second.id,
    });
    return true;
  },

  buildEdl: (resolvePath, resolveAudio, resolveKind) => {
    const state = get();
    const mainTrack = mainVideoTrackOf(state.timeline);
    const mainClips = sortClips((mainTrack?.clips ?? []).filter((item) => item.enabled));

    // 成片（concat 输出）里每个主轨片段的起点：等于前面片段的时长之和。
    // 片段之间的空白在导出时会被吃掉，所以贴图时间窗必须换算成输出时间，不能直接用时间轴时间。
    let outputCursor = 0;
    const outputStarts = new Map<string, number>();
    for (const clip of mainClips) {
      outputStarts.set(clip.id, outputCursor);
      outputCursor += clipTimelineDuration(clip);
    }

    // 贴图轨片段 → 与它时间重叠的每个主轨片段各挂一条 overlay（enable 用成片绝对时间）
    const overlaysByClip = new Map<string, NonNullable<EdlClip['overlays']>>();
    for (const track of state.timeline.tracks) {
      if (track.kind !== 'overlay') continue;
      for (const overlayClip of track.clips) {
        if (!overlayClip.enabled) continue;
        const overlayPath = resolvePath(overlayClip.assetId);
        if (!overlayPath) continue;
        const layout = overlayClip.layout ?? defaultOverlayLayout();
        const windowStart = overlayClip.startAt;
        const windowEnd = overlayClip.startAt + clipTimelineDuration(overlayClip);
        for (const clip of mainClips) {
          const clipStart = clip.startAt;
          const clipEnd = clip.startAt + clipTimelineDuration(clip);
          const start = Math.max(windowStart, clipStart);
          const end = Math.min(windowEnd, clipEnd);
          if (end - start < 0.05) continue;
          const outStart = outputStarts.get(clip.id) ?? 0;
          overlaysByClip.set(clip.id, [
            ...(overlaysByClip.get(clip.id) ?? []),
            {
              path: overlayPath,
              x: layout.x,
              y: layout.y,
              widthRatio: layout.widthRatio,
              opacity: layout.opacity,
              startSec: outStart + (start - clipStart),
              endSec: outStart + (end - clipStart),
              fadeInSec: layout.fadeInSec,
              fadeOutSec: layout.fadeOutSec,
            },
          ]);
        }
      }
    }

    const clips: EdlClip[] = [];
    for (const clip of mainClips) {
      const path = resolvePath(clip.assetId);
      if (!path) continue;
      clips.push({
        path,
        kind: resolveKind ? resolveKind(clip.assetId) : undefined,
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        startAt: clip.startAt,
        speed: clip.speed,
        hasAudio: resolveAudio(clip.assetId),
        audioMode: clip.audioMode,
        colorGrade: clip.colorGrade,
        overlays: overlaysByClip.get(clip.id),
      });
    }
    return { fps: state.timeline.fps, width: state.timeline.width, height: state.timeline.height, backgroundColor: state.timeline.backgroundColor, clips };
  },
}));

/**
 * 把片段放进一条轨道而不与已有片段重叠：目标位置落在占用区里时，
 * 就近落到能容纳它的空隙（左边挤到前一段结束，或右边退到后一段开始）。
 */
function placeWithoutOverlap(wanted: Clip, others: Clip[]): Clip {
  const duration = clipTimelineDuration(wanted);
  const sorted = [...others].sort((a, b) => a.startAt - b.startAt);
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const other of sorted) {
    const otherEnd = other.startAt + clipTimelineDuration(other);
    if (other.startAt - cursor > 1e-6) gaps.push({ start: cursor, end: other.startAt });
    cursor = Math.max(cursor, otherEnd);
  }
  gaps.push({ start: cursor, end: Number.POSITIVE_INFINITY });
  let best = Math.max(0, wanted.startAt);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const gap of gaps) {
    if (gap.end - gap.start < duration - 1e-6) continue;
    const ceiling = Number.isFinite(gap.end) ? gap.end - duration : Math.max(wanted.startAt, gap.start);
    const candidate = Math.min(Math.max(wanted.startAt, gap.start), ceiling);
    const distance = Math.abs(candidate - wanted.startAt);
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = Math.max(0, candidate);
    }
  }
  return { ...wanted, startAt: best };
}

export const defaultExportSettings = (timeline: Timeline): ExportSettings => ({
  fileName: `导出-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.mp4`,
  crf: 18,
  preset: 'medium',
  encoder: 'libx264',
  width: timeline.width,
  height: timeline.height,
  fps: timeline.fps,
});

export const timelineTotal = (timeline: Timeline) => timelineDuration(timeline);
