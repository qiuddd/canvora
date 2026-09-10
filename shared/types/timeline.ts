/** 时间轴数据模型，前后端共用（对照 PRD 8.7）。 */

export interface ColorGrade {
  brightness?: number;   // -1.0 ~ 1.0
  contrast?: number;     // 0.0 ~ 3.0
  saturation?: number;   // 0.0 ~ 3.0
  gamma?: number;        // 0.1 ~ 3.0
  temperature?: number;  // -1.0 ~ 1.0，正值偏暖
  tint?: number;         // -1.0 ~ 1.0，正值偏绿
  lutPath?: string;      // .cube 的绝对路径
}

export interface Overlay {
  id: string;
  assetId: string;
  x: number;            // 归一化左上角坐标 0~1
  y: number;
  widthRatio: number;   // 宽度占画面比例 0~1
  startSec: number;     // 相对片段起点
  endSec: number;
  opacity: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export interface Clip {
  id: string;
  assetId: string;
  inPoint: number;
  outPoint: number;
  startAt: number;
  /** 1.0 = 原速。timelineDurationSec = (outPoint - inPoint) / speed，由计算得出，不单独存。 */
  speed: number;
  audioMode: 'keep' | 'mute' | 'keepPitchCorrected';
  colorGrade?: ColorGrade;
  overlays?: Overlay[];
  enabled: boolean;
}

export interface Track {
  id: string;
  kind: 'video' | 'overlay' | 'audio';
  index: number;
  muted: boolean;
  locked: boolean;
  clips: Clip[];
}

export interface Timeline {
  projectId: string;
  fps: number;
  width: number;
  height: number;
  backgroundColor: string;
  tracks: Track[];
}

export const clipSourceDuration = (clip: Clip): number => Math.max(0, clip.outPoint - clip.inPoint);
export const clipTimelineDuration = (clip: Clip): number => clipSourceDuration(clip) / (clip.speed || 1);
export const clipEnd = (clip: Clip): number => clip.startAt + clipTimelineDuration(clip);

export function timelineDuration(timeline: Timeline): number {
  let max = 0;
  for (const track of timeline.tracks) for (const clip of track.clips) if (clip.enabled) max = Math.max(max, clipEnd(clip));
  return max;
}

/** 提交给后端滤镜图编译器的结构：片段里的素材已经换成真实文件路径。 */
export interface EdlClip {
  path: string;
  inPoint: number;
  outPoint: number;
  startAt: number;
  speed: number;
  hasAudio: boolean;
  audioMode: Clip['audioMode'];
  colorGrade?: ColorGrade;
  overlays?: Array<{ path: string; x: number; y: number; widthRatio: number; opacity: number; startSec: number; endSec: number; fadeInSec: number; fadeOutSec: number }>;
}

export interface Edl {
  fps: number;
  width: number;
  height: number;
  backgroundColor: string;
  clips: EdlClip[];
}

export interface ExportSettings {
  fileName: string;
  crf: number;
  preset: string;
  encoder: 'libx264' | 'h264_nvenc';
  width: number;
  height: number;
  fps: number;
}
