import { create } from 'zustand';
import type { Clip, Edl, EdlClip, ExportSettings, Timeline, Track } from '@canvora/shared';
import { clipTimelineDuration, timelineDuration } from '@canvora/shared';

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
  splitSelected: (seconds: number) => boolean;
  toggleClipMuted: (clipId: string) => void;
  toggleClipEnabled: (clipId: string) => void;
  addTrack: (kind: Track['kind']) => void;
  removeTrack: (trackId: string) => void;
  setZoom: (zoom: number) => void;
  addClip: (asset: { id: string; kind: string; durationSec?: number }, trackKind?: Track['kind'], startAt?: number) => Clip | null;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;
  removeClip: (clipId: string, ripple: boolean) => void;
  splitAt: (seconds: number) => boolean;
  buildEdl: (resolvePath: (assetId: string) => string | null, resolveAudio: (assetId: string) => boolean) => Edl;
}

const videoTrack = (): Track => ({ id: crypto.randomUUID(), kind: 'video', index: 0, muted: false, locked: false, clips: [] });
const overlayTrack = (): Track => ({ id: crypto.randomUUID(), kind: 'overlay', index: 0, muted: false, locked: false, clips: [] });

export const emptyTimeline = (projectId: string): Timeline => ({
  projectId, fps: 30, width: 1920, height: 1080, backgroundColor: '#000000',
  tracks: [videoTrack(), overlayTrack()],
});

const sortClips = (clips: Clip[]) => [...clips].sort((a, b) => a.startAt - b.startAt);

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
      const copy: Clip = { ...source, id: crypto.randomUUID(), startAt: source.startAt + duration };
      set({
        timeline: { ...state.timeline, tracks: state.timeline.tracks.map((item) => item.id === track.id ? { ...item, clips: sortClips([...item.clips, copy]) } : item) },
        selectedClipId: copy.id,
      });
      return copy.id;
    }
    return null;
  },
  /** 把播放头所在位置切成两段：光标在哪边，新选中的就是哪一段。 */
  splitSelected: (seconds) => get().splitAt(seconds),
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
    let position = Math.max(0, startAt ?? last);
    // 同一轨道上不许重叠：与已有片段相交时依次往右推到不重叠为止（PRD F2）
    const overlaps = (candidate: number) => track.clips.some((clip) => candidate < clip.startAt + clipTimelineDuration(clip) - 1e-6 && candidate + duration > clip.startAt + 1e-6);
    let guard = 0;
    while (overlaps(position) && guard < 50) {
      const blocker = track.clips
        .filter((clip) => position < clip.startAt + clipTimelineDuration(clip) - 1e-6 && position + duration > clip.startAt + 1e-6)
        .reduce((rightmost, clip) => Math.max(rightmost, clip.startAt + clipTimelineDuration(clip)), position);
      position = blocker;
      guard += 1;
    }
    const clip: Clip = {
      id: crypto.randomUUID(),
      assetId: asset.id,
      inPoint: 0,
      outPoint: duration,
      startAt: position,
      speed: 1,
      audioMode: 'keep',
      enabled: true,
    };
    set({
      timeline: { ...state.timeline, tracks: state.timeline.tracks.map((item) => item.id === track.id ? { ...item, clips: sortClips([...item.clips, clip]) } : item) },
      selectedClipId: clip.id,
    });
    return clip;
  },

  updateClip: (clipId, patch) => set((state) => ({
    timeline: {
      ...state.timeline,
      tracks: state.timeline.tracks.map((track) => ({
        ...track,
        clips: sortClips(track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip)),
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
    const track = state.timeline.tracks.find((item) => item.kind === 'video');
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

  buildEdl: (resolvePath, resolveAudio) => {
    const state = get();
    const track = state.timeline.tracks.find((item) => item.kind === 'video');
    const clips: EdlClip[] = [];
    for (const clip of sortClips((track?.clips ?? []).filter((item) => item.enabled))) {
      const path = resolvePath(clip.assetId);
      if (!path) continue;
      clips.push({
        path,
        inPoint: clip.inPoint,
        outPoint: clip.outPoint,
        startAt: clip.startAt,
        speed: clip.speed,
        hasAudio: resolveAudio(clip.assetId),
        audioMode: clip.audioMode,
        colorGrade: clip.colorGrade,
        overlays: (clip.overlays ?? []).map((overlay) => {
          const overlayPath = resolvePath(overlay.assetId) ?? '';
          return { path: overlayPath, x: overlay.x, y: overlay.y, widthRatio: overlay.widthRatio, opacity: overlay.opacity, startSec: overlay.startSec, endSec: overlay.endSec, fadeInSec: overlay.fadeInSec, fadeOutSec: overlay.fadeOutSec };
        }).filter((overlay) => overlay.path),
      });
    }
    return { fps: state.timeline.fps, width: state.timeline.width, height: state.timeline.height, backgroundColor: state.timeline.backgroundColor, clips };
  },
}));

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
