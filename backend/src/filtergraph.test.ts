import test from 'node:test';
import assert from 'node:assert/strict';
import type { Edl, EdlClip, ExportSettings } from '@canvora/shared';
import { buildAtempoChain, compileEdl, compileFilterGraph, gradeFilterSteps, lut3dFileArg, padColor, totalTimelineDuration, validateEdl } from './filtergraph.js';

const speeds = [0.1, 0.2, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 10, 15, 20];
test('buildAtempoChain covers supported speeds', () => {
  for (const speed of speeds) {
    const chain = buildAtempoChain(speed);
    if (speed === 1) { assert.equal(chain, ''); continue; }
    const factors = chain.split(',').map((part) => Number(part.split('=')[1]));
    assert.ok(factors.every((factor) => factor >= 0.5 && factor <= 2));
    assert.ok(Math.abs(factors.reduce((product, factor) => product * factor, 1) - speed) < 1e-6);
  }
});

test('compileFilterGraph emits clip, speed and escaped overlay filters', () => {
  const graph = compileFilterGraph({ clips: [
    { input: '0:v', inPoint: 0, outPoint: 4, speed: 2, hasAudio: true },
    { input: '1:v', inPoint: 1, outPoint: 3, speed: 0.25, hasAudio: false },
  ], overlays: [{ input: '2:v', start: 3, end: 8 }] });
  assert.match(graph, /concat=n=2:v=1:a=1/);
  assert.match(graph, /setpts=0\.500000\*PTS/);
  assert.match(graph, /setpts=4\.000000\*PTS/);
  assert.match(graph, /atempo=0\.50,atempo=0\.50/);
  assert.match(graph, /between\(t\\,3\\,8\)/);
});

// ── compileEdl：时间轴导出编译器（PRD 10.1 / TASKS 7.1.10）──

const settings = (patch: Partial<ExportSettings> = {}): ExportSettings => ({
  fileName: '成片.mp4', crf: 18, preset: 'medium', encoder: 'libx264', width: 1280, height: 720, fps: 30, ...patch,
});

const clip = (patch: Partial<EdlClip> = {}): EdlClip => ({
  path: 'C:/Canvora/projects/p1/assets/a.mp4', inPoint: 0, outPoint: 4, startAt: 0, speed: 1,
  hasAudio: true, audioMode: 'keep', ...patch,
});

const edl = (clips: EdlClip[], patch: Partial<Edl> = {}): Edl => ({
  fps: 30, width: 1280, height: 720, backgroundColor: '#000000', clips, ...patch,
});

test('compileEdl：片段数量、输入顺序与输出映射', () => {
  const compiled = compileEdl(edl([
    clip({ path: 'C:/x/a.mp4', inPoint: 0, outPoint: 4 }),
    clip({ path: 'C:/x/b.mp4', inPoint: 2, outPoint: 6, speed: 2 }),
  ]), settings());
  assert.deepEqual(compiled.inputs.map((input) => input.path), ['C:/x/a.mp4', 'C:/x/b.mp4']);
  assert.equal(compiled.inputs.every((input) => input.imageDurationSec === undefined), true, '视频片段不需要图片循环');
  assert.match(compiled.filterGraph, /concat=n=2:v=1:a=1\[vcat\]\[acat\]/);
  assert.match(compiled.filterGraph, /\[v0\]/);
  assert.match(compiled.filterGraph, /\[v1\]/);
  assert.match(compiled.filterGraph, /\[a0\]/);
  assert.match(compiled.filterGraph, /\[a1\]/);
  assert.deepEqual(compiled.maps, ['-map', '[vcat]', '-map', '[acat]']);
  assert.equal(totalTimelineDuration(edl([clip({ inPoint: 0, outPoint: 4 }), clip({ inPoint: 2, outPoint: 6, speed: 2 })])), 6);
});

test('compileEdl：10 倍速的 setpts 系数与 atempo 链', () => {
  const compiled = compileEdl(edl([clip({ inPoint: 0, outPoint: 20, speed: 10 })]), settings());
  assert.match(compiled.filterGraph, /setpts=0\.100000\*PTS/);
  assert.match(compiled.filterGraph, /atempo=2\.00,atempo=2\.00,atempo=2\.00,atempo=1\.25/);
  // 10 倍速成片 2 秒：静音段的时长要按变速后的时长算
  assert.match(compiled.filterGraph, /concat=n=1:v=1:a=1/);
});

test('compileEdl：speed=1 时不加 setpts，也不加 atempo', () => {
  const compiled = compileEdl(edl([clip({ inPoint: 1, outPoint: 4, speed: 1 })]), settings());
  assert.equal(compiled.filterGraph.includes('*PTS'), false, '原速不该出现变速用的 setpts');
  assert.equal(compiled.filterGraph.includes('atempo'), false);
  assert.match(compiled.filterGraph, /setpts=PTS-STARTPTS/);
});

test('compileEdl：视频链顺序固定为 trim→setpts 归零→scale/pad→变速→调色→setsar', () => {
  const compiled = compileEdl(edl([clip({ inPoint: 1.5, outPoint: 4, speed: 2, colorGrade: { brightness: 0.2 } })]), settings({ width: 1920, height: 1080 }));
  const line = compiled.filterGraph.split('\n').find((item) => item.includes('[v0]'));
  assert.ok(line);
  const order = ['trim=start=1.5:end=4', 'setpts=PTS-STARTPTS', 'scale=1920:1080:force_original_aspect_ratio=decrease', 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x000000', 'setpts=0.500000*PTS', 'eq=brightness=0.200000', 'setsar=1'];
  let cursor = -1;
  for (const step of order) {
    const at = line!.indexOf(step);
    assert.ok(at > cursor, `${step} 的位置不对：${line}`);
    cursor = at;
  }
});

test('compileEdl：没有音轨或用户选静音时用 anullsrc 补静音，时长按变速后算', () => {
  const compiled = compileEdl(edl([
    clip({ inPoint: 0, outPoint: 4, speed: 2, hasAudio: false }),
    clip({ inPoint: 0, outPoint: 3, speed: 1, hasAudio: true, audioMode: 'mute' }),
  ]), settings());
  const nulls = compiled.filterGraph.match(/anullsrc=r=48000:cl=stereo,atrim=duration=/g) ?? [];
  assert.equal(nulls.length, 2, '无音轨与静音两种片段都要补静音，否则 concat 的音频输入个数对不上');
  assert.match(compiled.filterGraph, /anullsrc=r=48000:cl=stereo,atrim=duration=2\.000000,asetpts=PTS-STARTPTS,aresample=48000\[a0\]/);
  assert.match(compiled.filterGraph, /anullsrc=r=48000:cl=stereo,atrim=duration=3\.000000,asetpts=PTS-STARTPTS,aresample=48000\[a1\]/);
});

test('compileEdl：有音轨的片段走 atrim→asetpts→atempo→aresample', () => {
  const compiled = compileEdl(edl([clip({ inPoint: 2, outPoint: 6, speed: 2 })]), settings());
  assert.match(compiled.filterGraph, /\[0:a\]atrim=start=2:end=6,asetpts=PTS-STARTPTS,atempo=2\.00,aresample=48000\[a0\]/);
});

test('compileEdl：贴图接在 concat 之后，enable 的逗号转义，淡入淡出用 rgba+fade', () => {
  const compiled = compileEdl(edl([clip({
    inPoint: 0, outPoint: 10,
    overlays: [{ path: 'C:/x/logo.png', x: 0.8, y: 0.85, widthRatio: 0.2, opacity: 1, startSec: 3, endSec: 8, fadeInSec: 1, fadeOutSec: 0.5 }],
  })]), settings({ width: 1000, height: 500 }));
  assert.deepEqual(compiled.inputs.map((input) => input.path), ['C:/Canvora/projects/p1/assets/a.mp4', 'C:/x/logo.png']);
  // 贴图是图片：循环到窗口结束 + 淡出 + 0.5 秒余量（未超成片总长 10 秒时取全值）
  assert.deepEqual(compiled.inputs[1], { path: 'C:/x/logo.png', imageDurationSec: 9, imageFramerate: 30 });
  assert.match(compiled.filterGraph, /between\(t\\,3\\,8\)/);
  assert.match(compiled.filterGraph, /\[1:v\]scale=200:-2,format=rgba,fade=in:st=3:d=1:alpha=1,fade=out:st=7\.5:d=0\.5:alpha=1\[ov1\]/);
  assert.match(compiled.filterGraph, /\[vcat\]\[ov1\]overlay=800:425:enable='between\(t\\,3\\,8\)'\[vo1\]/);
  assert.deepEqual(compiled.maps, ['-map', '[vo1]', '-map', '[acat]']);
  // concat 必须出现在贴图之前
  assert.ok(compiled.filterGraph.indexOf('concat=n=1') < compiled.filterGraph.indexOf('[ov1]overlay='));
});

test('compileEdl：图片片段标记成图片输入，循环时长按变速后的时间轴时长算', () => {
  const compiled = compileEdl(edl([
    clip({ path: 'C:/x/pic.png', kind: 'image', inPoint: 0, outPoint: 5, speed: 1, hasAudio: false }),
    clip({ path: 'C:/x/pic2.png', kind: 'image', inPoint: 0, outPoint: 8, speed: 2, hasAudio: false }),
  ]), settings());
  assert.deepEqual(compiled.inputs, [
    { path: 'C:/x/pic.png', imageDurationSec: 5, imageFramerate: 30 },
    { path: 'C:/x/pic2.png', imageDurationSec: 4, imageFramerate: 30 },
  ]);
});

test('compileEdl：贴图循环不超过成片总长（否则 overlay 跟随最长输入，尾部多冻结帧）', () => {
  // 成片总长 6 秒，贴图窗口 4→6 + 淡出 0.5 + 余量 0.5 = 7.5，被钳到 6
  const compiled = compileEdl(edl([clip({
    inPoint: 0, outPoint: 6,
    overlays: [{ path: 'C:/x/logo.png', x: 0.5, y: 0.5, widthRatio: 0.2, opacity: 1, startSec: 4, endSec: 6, fadeInSec: 0, fadeOutSec: 0.5 }],
  })]), settings());
  assert.equal(compiled.inputs[1].imageDurationSec, 6);
});

test('compileEdl：LUT 路径换正斜杠、盘符冒号转义并加引号（否则冒号会把滤镜切开）', () => {
  const compiled = compileEdl(edl([clip({ colorGrade: { lutPath: 'C:\\Canvora\\luts\\cinema.cube' } })]), settings());
  assert.match(compiled.filterGraph, /lut3d=file='C\\:\/Canvora\/luts\/cinema\.cube'/);
  assert.equal(compiled.filterGraph.includes('\\Canvora'), false, '反斜杠不能留着');
  assert.equal(lut3dFileArg('C:\\Canvora\\luts\\带 空格\\x.cube'), "'C\\:/Canvora/luts/带 空格/x.cube'");
  assert.equal(lut3dFileArg("D:/a'b/c.cube"), "'D\\:/a\\'b/c.cube'");
});

test('compileEdl：调色全部是默认值时不加任何调色滤镜', () => {
  const plain = compileEdl(edl([clip({ colorGrade: { brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature: 0, tint: 0 } })]), settings());
  assert.equal(plain.filterGraph.includes('eq='), false);
  assert.equal(plain.filterGraph.includes('colorbalance='), false);
  assert.equal(plain.filterGraph.includes('lut3d='), false);
  // 真的调了亮度才出现 eq
  assert.match(compileEdl(edl([clip({ colorGrade: { brightness: 0.2 } })]), settings()).filterGraph, /eq=brightness=0\.200000/);
  assert.deepEqual(gradeFilterSteps(undefined), []);
});

test('compileEdl：色温映射成 colorbalance 加红减蓝', () => {
  const steps = gradeFilterSteps({ temperature: 0.5 });
  assert.deepEqual(steps, ['colorbalance=rm=0.500000:bm=-0.500000']);
  assert.deepEqual(gradeFilterSteps({ temperature: -0.4 }), ['colorbalance=rm=-0.400000:bm=0.400000']);
});

test('compileEdl：pad 用导出尺寸与背景色，奇数列向下取偶', () => {
  const compiled = compileEdl(edl([clip()], { backgroundColor: '#102030' }), settings({ width: 1081, height: 721 }));
  assert.match(compiled.filterGraph, /scale=1080:720:force_original_aspect_ratio=decrease/);
  assert.match(compiled.filterGraph, /pad=1080:720:\(ow-iw\)\/2:\(oh-ih\)\/2:color=0x102030/);
  assert.equal(padColor('#000000'), '0x000000');
  assert.equal(padColor('white'), 'white');
  assert.equal(padColor('乱写的'), 'black');
  assert.equal(padColor(undefined), 'black');
});

test('compileEdl：输出参数符合 PRD 10.1 第 6 步，nvenc 走 -cq 而不是 -crf', () => {
  const soft = compileEdl(edl([clip()]), settings());
  for (const expected of [['-c:v', 'libx264'], ['-crf', '18'], ['-preset', 'medium'], ['-pix_fmt', 'yuv420p'], ['-r', '30'], ['-c:a', 'aac'], ['-b:a', '192k'], ['-movflags', '+faststart']]) {
    const at = soft.outputArgs.indexOf(expected[0]);
    assert.ok(at >= 0, `缺少 ${expected[0]}`);
    assert.equal(soft.outputArgs[at + 1], expected[1]);
  }
  const hard = compileEdl(edl([clip()]), settings({ encoder: 'h264_nvenc' }));
  assert.ok(hard.outputArgs.includes('h264_nvenc'));
  assert.equal(hard.outputArgs.includes('-crf'), false);
  assert.equal(hard.outputArgs[hard.outputArgs.indexOf('-cq') + 1], '18');
});

test('validateEdl：不合格的输入给出中文原因，且指明是哪一条', () => {
  const bad = (clips: EdlClip[], patch: Partial<ExportSettings> = {}) => assert.throws(() => compileEdl(edl(clips), settings(patch)));
  assert.throws(() => compileEdl(edl([]), settings()), /没有可导出的片段/);
  assert.throws(() => validateEdl(edl([clip({ inPoint: 5, outPoint: 3 })]), settings()), /片段 1：入点必须小于出点/);
  assert.throws(() => validateEdl(edl([clip({ inPoint: 3, outPoint: 3 })]), settings()), /入点必须小于出点/);
  assert.throws(() => validateEdl(edl([clip({ speed: 25 })]), settings()), /片段 1：变速超出支持范围/);
  assert.throws(() => validateEdl(edl([clip({ speed: 0.05 })]), settings()), /片段 1：变速超出支持范围/);
  assert.throws(() => validateEdl(edl([clip({ speed: 0 })]), settings()), /变速超出支持范围/);
  bad([clip({ inPoint: Number.NaN })]);
  assert.throws(() => validateEdl(edl([clip({ overlays: [{ path: 'x.png', x: 0, y: 0, widthRatio: 0.2, opacity: 1, startSec: 8, endSec: 3, fadeInSec: 0, fadeOutSec: 0 }] })]), settings()), /第 1 个贴图：时间窗无效/);
  assert.throws(() => validateEdl(edl([clip({ overlays: [{ path: 'x.png', x: 0, y: 0, widthRatio: 0.2, opacity: 1, startSec: 0, endSec: 99, fadeInSec: 0, fadeOutSec: 0 }] })]), settings()), /超出成片时长/);
  assert.throws(() => validateEdl(edl([clip()]), settings({ width: 0 })), /导出分辨率无效/);
  assert.throws(() => validateEdl(edl([clip()]), settings({ fps: 0 })), /导出帧率无效/);
  assert.throws(() => validateEdl(edl([clip()]), settings({ crf: 99 })), /CRF/);
});

test('compileEdl：单片段原速原样导出也能编译出干净的命令', () => {
  const compiled = compileEdl(edl([clip({ inPoint: 0, outPoint: 2 })]), settings());
  assert.deepEqual(compiled.maps, ['-map', '[vcat]', '-map', '[acat]']);
  assert.match(compiled.filterGraph, /\[0:v\]trim=start=0:end=2,setpts=PTS-STARTPTS,scale=1280:720/);
  assert.equal(compiled.filterGraph.includes('overlay='), false);
});
