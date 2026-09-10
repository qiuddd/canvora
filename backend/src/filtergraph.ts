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
