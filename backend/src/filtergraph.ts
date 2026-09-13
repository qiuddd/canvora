import type { ColorGrade, Edl, EdlClip, ExportSettings } from '@canvora/shared';

export function buildAtempoChain(speed: number): string {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('变速必须是正数');
  if (speed === 1) return '';
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2) { factors.push(2); remaining /= 2; }
  while (remaining < 0.5) { factors.push(0.5); remaining /= 0.5; }
  factors.push(remaining);
  const rounded = factors.map((factor) => Number(factor.toFixed(8)));
  const correction = speed / rounded.reduce((product, factor) => product * factor, 1);
  rounded[rounded.length - 1] = Number((rounded[rounded.length - 1] * correction).toFixed(8));
  const twoDecimalProduct = rounded.reduce((product, factor) => product * Number(factor.toFixed(2)), 1);
  const precision = Math.abs(twoDecimalProduct - speed) < 1e-6 ? 2 : 8;
  return rounded.map((factor) => `atempo=${factor.toFixed(precision)}`).join(',');
}

export interface FilterClip {
  input: string;
  inPoint: number;
  outPoint: number;
  speed: number;
  hasAudio?: boolean;
}
export interface OverlayFilter { input: string; start: number; end: number; x?: string; y?: string }
export interface FilterGraphEdl { clips: FilterClip[]; overlays?: OverlayFilter[] }

export function compileFilterGraph(edl: FilterGraphEdl): string {
  if (edl.clips.length === 0) throw new Error('至少需要一个片段');
  const lines: string[] = [];
  edl.clips.forEach((clip, index) => {
    if (clip.inPoint >= clip.outPoint || clip.speed < 0.1 || clip.speed > 20) throw new Error(`片段 ${index + 1} 参数无效`);
    const duration = clip.outPoint - clip.inPoint;
    const videoInput = clip.input.includes(':') ? clip.input : `${clip.input}:v`;
    const audioInput = clip.input.includes(':') ? `${clip.input.split(':')[0]}:a` : `${clip.input}:a`;
    lines.push(`[${videoInput}]trim=start=${clip.inPoint}:end=${clip.outPoint},setpts=PTS-STARTPTS,setpts=${(1 / clip.speed).toFixed(6)}*PTS[v${index}]`);
    const audio = clip.hasAudio === false ? `anullsrc=r=48000:cl=stereo,atrim=duration=${(duration / clip.speed).toFixed(6)}` : `[${audioInput}]atrim=start=${clip.inPoint}:end=${clip.outPoint},asetpts=PTS-STARTPTS`;
    const atempo = buildAtempoChain(clip.speed);
    lines.push(`${audio}${atempo ? `,${atempo}` : ''},aresample=48000[a${index}]`);
  });
  const concatInputs = edl.clips.flatMap((_, index) => [`[v${index}]`, `[a${index}]`]).join('');
  lines.push(`${concatInputs}concat=n=${edl.clips.length}:v=1:a=1[vcat][acat]`);
  let video = '[vcat]';
  for (const [index, overlay] of (edl.overlays ?? []).entries()) {
    if (overlay.start < 0 || overlay.end < overlay.start) throw new Error('贴图时间窗无效');
    const x = overlay.x ?? 'main_w-overlay_w';
    const y = overlay.y ?? 'main_h-overlay_h';
    const next = `vo${index}`;
    lines.push(`[${overlay.input}]format=rgba[ov${index}];${video}[ov${index}]overlay=${x}:${y}:enable='between(t\\,${overlay.start}\\,${overlay.end})'[${next}]`);
    video = `[${next}]`;
  }
  lines.push(`${video}copy[vout]`);
  return lines.join(';\n');
}

// ── 时间轴导出编译器（PRD 10.1 / TASKS 7.1）──────────────

/** 变速的合法区间（PRD 10.1 第 1 步）。 */
export const MIN_CLIP_SPEED = 0.1;
export const MAX_CLIP_SPEED = 20;

/**
 * 传给编译器的附加参数。
 * `graphFile` 是调用方准备把滤镜图写进哪个文件（导出任务用 `-filter_complex_script` 传它）。
 * 编译器本身是纯函数、不落盘，这个字段只是让调用方在同一个对象里带上路径信息。
 */
export interface CompileOptions { graphFile?: string }

export interface CompiledEdl {
  filterGraph: string;
  /**
   * 按顺序传给 ffmpeg 的输入（先是各片段，再是各贴图）。
   * 图片输入没有时间长度，必须带 `-loop 1 -t 时长` 循环成视频流，
   * 否则整段只有 1 帧：主轨图片片段会音画错位，贴图的 alpha 淡入淡出会整段透明。
   */
  inputs: Array<{ path: string; imageDurationSec?: number; imageFramerate?: number }>;
  /** `-map` 参数，已经拼成 key/value 成对的形式。 */
  maps: string[];
  outputArgs: string[];
}

/** ffmpeg 滤镜里的数字：固定 6 位小数后去掉尾巴，避免 0.30000000000000004 这类噪音。 */
const seconds = (value: number): string => String(Number(value.toFixed(6)));

const isNonDefault = (value: number | undefined, base = 0): value is number => typeof value === 'number' && Number.isFinite(value) && value !== base;

const isPositiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0;

/** 成片时长 = 各片段「(出点 − 入点) ÷ 变速」之和。 */
export function totalTimelineDuration(edl: Edl): number {
  return edl.clips.reduce((sum, clip) => sum + Math.max(0, clip.outPoint - clip.inPoint) / (clip.speed || 1), 0);
}

/**
 * lut3d 的 file 参数。
 *
 * 两件事都必须做（实测 ffmpeg 7.1）：
 * 1. 反斜杠换成正斜杠——反斜杠是滤镜语法的转义符（AGENTS.md 4.6）。
 * 2. 盘符后的冒号要转义成 `\:`，并且整个路径用单引号包起来。只把反斜杠换成
 *    正斜杠是不够的：`lut3d=file=C:/x.cube` 会被 ffmpeg 的滤镜选项解析器在 `:` 处切开，
 *    报 “No option name near '/x.cube'” 直接失败（AGENTS.md 4.6 只说了前一半）。
 */
export function lut3dFileArg(path: string): string {
  const forward = path.replaceAll('\\', '/');
  return `'${forward.replaceAll(':', '\\:').replaceAll("'", "\\'")}'`;
}

/** 补边颜色：接受 #RRGGBB / 0xRRGGBB / 颜色名，其它一律按黑色处理。 */
export function padColor(background: string | undefined): string {
  const value = (background ?? '').trim();
  const hex = /^#?([0-9a-fA-F]{6})$/.exec(value);
  if (hex) return `0x${hex[1].toLowerCase()}`;
  if (/^[a-zA-Z]{3,}$/.test(value)) return value.toLowerCase();
  return 'black';
}

/**
 * 调色滤镜链：eq（亮度/对比度/饱和度/伽马）→ colorbalance（色温/色调）→ lut3d。
 * 全部是默认值时不生成任何滤镜——白跑一次调色只会掉画质。
 * 色温映射：偏暖 = 中间调加红减蓝；色调正值 = 加绿。
 */
export function gradeFilterSteps(grade: ColorGrade | undefined): string[] {
  if (!grade) return [];
  const steps: string[] = [];
  const eq: string[] = [];
  if (isNonDefault(grade.brightness)) eq.push(`brightness=${grade.brightness.toFixed(6)}`);
  if (isNonDefault(grade.contrast, 1)) eq.push(`contrast=${grade.contrast.toFixed(6)}`);
  if (isNonDefault(grade.saturation, 1)) eq.push(`saturation=${grade.saturation.toFixed(6)}`);
  if (isNonDefault(grade.gamma, 1)) eq.push(`gamma=${grade.gamma.toFixed(6)}`);
  if (eq.length > 0) steps.push(`eq=${eq.join(':')}`);

  const balance: string[] = [];
  if (isNonDefault(grade.temperature)) {
    balance.push(`rm=${grade.temperature.toFixed(6)}`, `bm=${(-grade.temperature).toFixed(6)}`);
  }
  if (isNonDefault(grade.tint)) balance.push(`gm=${grade.tint.toFixed(6)}`);
  if (balance.length > 0) steps.push(`colorbalance=${balance.join(':')}`);

  if (grade.lutPath) steps.push(`lut3d=file=${lut3dFileArg(grade.lutPath)}`);
  return steps;
}

/** yuv420p 要求偶数尺寸：scale/pad 的目标尺寸向下取偶，否则奇数列会让 pad 直接报错。 */
export function evenDimension(value: number): number {
  const rounded = Math.floor(value);
  return Math.max(2, rounded % 2 === 0 ? rounded : rounded - 1);
}

/**
 * 导出前校验（PRD 10.1 第 1 步 / TASKS 7.1.2）。
 * 只做与本模块有关的结构校验；素材文件是否真的存在由任务层查（那边才知道工作区路径）。
 * 错误信息是中文，并指明是哪一条不合格。
 */
export function validateEdl(edl: Edl, settings: ExportSettings): void {
  if (!edl || !Array.isArray(edl.clips) || edl.clips.length === 0) throw new Error('时间轴上没有可导出的片段，请先往时间轴放素材');
  if (!isPositiveInteger(settings.width) || !isPositiveInteger(settings.height)) throw new Error('导出分辨率无效，请重新选择分辨率');
  if (!Number.isFinite(settings.fps) || settings.fps <= 0) throw new Error('导出帧率无效，请重新选择帧率');
  if (!Number.isFinite(settings.crf) || settings.crf < 0 || settings.crf > 51) throw new Error('导出画质（CRF）只能是 0 到 51 之间的数值');

  const total = totalTimelineDuration(edl);
  // 先逐片段报错再报总时长：入点出点反了的时候，用户要看的是「哪一段反了」，不是「时长是 0」
  edl.clips.forEach((clip, index) => {
    const position = `片段 ${index + 1}：`;
    if (typeof clip.path !== 'string' || !clip.path.trim()) throw new Error(`${position}没有对应的素材文件，请重新导入素材`);
    if (!Number.isFinite(clip.inPoint) || !Number.isFinite(clip.outPoint)) throw new Error(`${position}入点或出点不是有效数字`);
    if (clip.inPoint < 0) throw new Error(`${position}入点不能是负数（当前 ${seconds(clip.inPoint)} 秒）`);
    if (!(clip.inPoint < clip.outPoint)) throw new Error(`${position}入点必须小于出点（当前 ${seconds(clip.inPoint)} 秒 → ${seconds(clip.outPoint)} 秒）`);
    if (!Number.isFinite(clip.speed) || clip.speed < MIN_CLIP_SPEED || clip.speed > MAX_CLIP_SPEED) {
      throw new Error(`${position}变速超出支持范围，只能是 ${MIN_CLIP_SPEED} 到 ${MAX_CLIP_SPEED} 倍（当前 ${String(clip.speed)} 倍）`);
    }
    (clip.overlays ?? []).forEach((overlay, overlayIndex) => {
      const label = `片段 ${index + 1} 的第 ${overlayIndex + 1} 个贴图：`;
      if (!Number.isFinite(overlay.startSec) || !Number.isFinite(overlay.endSec)) throw new Error(`${label}时间窗不是有效数字`);
      if (overlay.startSec < 0) throw new Error(`${label}开始时间不能是负数（当前 ${seconds(overlay.startSec)} 秒）`);
      if (!(overlay.startSec < overlay.endSec)) throw new Error(`${label}时间窗无效，开始时间必须早于结束时间（${seconds(overlay.startSec)} 秒 → ${seconds(overlay.endSec)} 秒）`);
      if (overlay.endSec > total + 0.5) throw new Error(`${label}时间窗超出成片时长（成片 ${seconds(total)} 秒，贴图结束在 ${seconds(overlay.endSec)} 秒）`);
      if (!Number.isFinite(overlay.widthRatio) || overlay.widthRatio <= 0 || overlay.widthRatio > 1) throw new Error(`${label}宽度比例必须在 0 到 1 之间（当前 ${String(overlay.widthRatio)}）`);
    });
  });

  if (!(total > 0)) throw new Error('成片时长是 0 秒，请检查每个片段的入点和出点');
}

/**
 * 单个片段的音频链：atrim → asetpts=PTS-STARTPTS → atempo 链 → aresample=48000。
 * 静音段（没有音轨或用户选了静音）必须补 anullsrc，否则 concat 的音频输入个数对不上会直接失败。
 * 静音段直接按成片时长生成，不再套 atempo——对静音变速只会让音画长度对不上。
 */
function clipAudioChain(clip: EdlClip, index: number): string {
  const timelineDuration = Math.max(0, clip.outPoint - clip.inPoint) / (clip.speed || 1);
  if (clip.audioMode === 'mute' || !clip.hasAudio) {
    return `anullsrc=r=48000:cl=stereo,atrim=duration=${timelineDuration.toFixed(6)},asetpts=PTS-STARTPTS,aresample=48000[a${index}]`;
  }
  const steps = [`atrim=start=${seconds(clip.inPoint)}:end=${seconds(clip.outPoint)}`, 'asetpts=PTS-STARTPTS'];
  const atempo = buildAtempoChain(clip.speed);
  if (atempo) steps.push(atempo);
  steps.push('aresample=48000');
  return `[${index}:a]${steps.join(',')}[a${index}]`;
}

/** 编码与封装参数（PRD 10.1 第 6 步 / TASKS 7.1.8）。硬件编码不支持 -crf，改用 -cq。 */
export function buildExportOutputArgs(settings: ExportSettings): string[] {
  const args = settings.encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', settings.preset, '-cq', String(settings.crf)]
    : ['-c:v', 'libx264', '-crf', String(settings.crf), '-preset', settings.preset];
  args.push('-pix_fmt', 'yuv420p', '-r', String(settings.fps), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  return args;
}

/**
 * 把 EDL 编译成一次导出用的滤镜图与命令行参数。
 *
 * 每个片段的视频链顺序固定为：trim → setpts=PTS-STARTPTS（时间归零）→ scale/pad（统一尺寸）→
 * setpts（变速）→ 调色 → setsar=1。顺序错了会出现「变速后裁切错位」「调色被缩放抹掉」这类只能靠成片发现的问题。
 * 贴图统一接在 concat 之后，enable 用的是成片的绝对时间。
 */
export function compileEdl(edl: Edl, settings: ExportSettings): CompiledEdl {
  validateEdl(edl, settings);

  const width = evenDimension(settings.width);
  const height = evenDimension(settings.height);
  const color = padColor(edl.backgroundColor);
  const lines: string[] = [];
  const inputs: CompiledEdl['inputs'] = [];

  edl.clips.forEach((clip, index) => {
    inputs.push({
      path: clip.path,
      imageDurationSec: clip.kind === 'image' ? Math.max(0.1, (clip.outPoint - clip.inPoint) / (clip.speed || 1)) : undefined,
      imageFramerate: clip.kind === 'image' ? settings.fps : undefined,
    });
    const steps = [
      `trim=start=${seconds(clip.inPoint)}:end=${seconds(clip.outPoint)}`,
      'setpts=PTS-STARTPTS',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${color}`,
    ];
    // 恰好原速时不加 setpts，避免无意义的滤镜与浮点误差
    if (clip.speed !== 1) steps.push(`setpts=${(1 / clip.speed).toFixed(6)}*PTS`);
    steps.push(...gradeFilterSteps(clip.colorGrade));
    steps.push('setsar=1');
    lines.push(`[${index}:v]${steps.join(',')}[v${index}]`);
    lines.push(clipAudioChain(clip, index));
  });

  const concatInputs = edl.clips.flatMap((_, index) => [`[v${index}]`, `[a${index}]`]).join('');
  lines.push(`${concatInputs}concat=n=${edl.clips.length}:v=1:a=1[vcat][acat]`);

  let videoLabel = 'vcat';
  let overlayInputIndex = edl.clips.length;
  for (const clip of edl.clips) {
    for (const overlay of clip.overlays ?? []) {
      // 贴图图片循环到窗口结束 + 淡出收尾，再留半秒余量；但不能超过成片总长，
      // 否则 overlay 滤镜跟随最长输入，成片尾部会多出一段冻结帧（实测多 0.5 秒）
      const totalOutput = totalTimelineDuration(edl);
      inputs.push({
        path: overlay.path,
        imageDurationSec: Math.min(Math.max(0.1, overlay.endSec + overlay.fadeOutSec + 0.5), Math.max(0.1, totalOutput)),
        imageFramerate: settings.fps,
      });
      const overlayWidth = Math.max(2, Math.round(overlay.widthRatio * width));
      const steps = [`scale=${overlayWidth}:-2`, 'format=rgba'];
      if (overlay.fadeInSec > 0) steps.push(`fade=in:st=${seconds(overlay.startSec)}:d=${seconds(overlay.fadeInSec)}:alpha=1`);
      if (overlay.fadeOutSec > 0) steps.push(`fade=out:st=${seconds(overlay.endSec - overlay.fadeOutSec)}:d=${seconds(overlay.fadeOutSec)}:alpha=1`);
      const overlayLabel = `ov${overlayInputIndex}`;
      const nextLabel = `vo${overlayInputIndex}`;
      // enable 里的逗号必须转义：走 -filter_complex_script 也一样（AGENTS.md 4.6）
      const enable = `enable='between(t\\,${seconds(overlay.startSec)}\\,${seconds(overlay.endSec)})'`;
      const x = Math.max(0, Math.round(overlay.x * width));
      const y = Math.max(0, Math.round(overlay.y * height));
      lines.push(`[${overlayInputIndex}:v]${steps.join(',')}[${overlayLabel}]`);
      lines.push(`[${videoLabel}][${overlayLabel}]overlay=${x}:${y}:${enable}[${nextLabel}]`);
      videoLabel = nextLabel;
      overlayInputIndex += 1;
    }
  }

  return {
    filterGraph: lines.join(';\n'),
    inputs,
    maps: ['-map', `[${videoLabel}]`, '-map', '[acat]'],
    outputArgs: buildExportOutputArgs(settings),
  };
}
