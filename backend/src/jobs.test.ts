import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBatchExtractArgs,
  buildConcatArgs,
  buildExportFrameArgs,
  buildGridFilterGraph,
  buildGridSplitArgs,
  buildExportTimelineArgs,
  buildMuxAudioArgs,
  buildRealEsrganArgs,
  buildRifeArgs,
  buildSegmentArgs,
  cancelJob,
  concatListLine,
  enqueueJob,
  estimateSpaceBytes,
  formatDurationCn,
  formatFramerate,
  formatGigabytes,
  frameDisplayName,
  frameFileExtension,
  getJob,
  gridCellDisplayName,
  halveTile,
  interpolatedFps,
  isGpuMemoryError,
  isSpaceInsufficient,
  listJobs,
  missingToolError,
  parseFfmpegProgress,
  parseFrameCount,
  parseFrameRate,
  parseGridDivision,
  parseNcnnProgress,
  planFrameBatches,
  planGridCells,
  queueStatusText,
  readExportTimelineOptions,
  restoreJobs,
  sanitizeExportFileName,
  splitAxis,
} from './jobs.js';
import { compileEdl } from './filtergraph.js';

/**
 * 这里只测不被外部工具（ffmpeg / realesrgan / rife）阻塞的纯逻辑。
 * 真正调工具的路径要靠手动跑任务验收，不放进单测（PRD 各条判据）。
 */

// ── 空间估算（PRD E2 第 2 步 / AGENTS.md 磁盘红线）──────

test('estimateSpaceBytes 按帧数×单帧体积×份数估算，0 帧不占空间', () => {
  assert.equal(estimateSpaceBytes(0), 0);
  assert.equal(estimateSpaceBytes(-5), 0);
  assert.equal(estimateSpaceBytes(100), 100 * 350 * 1024 * 2);
  assert.equal(estimateSpaceBytes(10, 1000, 1), 10000);
});

test('isSpaceInsufficient 超过可用空间一半才拒绝，恰好一半放行', () => {
  const free = 10 * 1024 ** 3;
  assert.equal(isSpaceInsufficient(free * 0.5, free), false);
  assert.equal(isSpaceInsufficient(free * 0.5 + 1, free), true);
  assert.equal(isSpaceInsufficient(1, 0), true);
});

test('formatGigabytes 用 GB 显示，供中文提示使用', () => {
  assert.equal(formatGigabytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(formatGigabytes(0), '0.0 GB');
});

// ── 批次切分（PRD E2 第 3 步：每批 200 帧）──────────────

test('planFrameBatches 切分出连续的批次，最后一批可能不满', () => {
  assert.deepEqual(planFrameBatches(0), []);
  assert.deepEqual(planFrameBatches(200, 200), [{ index: 1, startFrame: 0, frameCount: 200 }]);
  assert.deepEqual(planFrameBatches(201, 200), [
    { index: 1, startFrame: 0, frameCount: 200 },
    { index: 2, startFrame: 200, frameCount: 1 },
  ]);
  const batches = planFrameBatches(1000, 200);
  assert.equal(batches.length, 5);
  assert.deepEqual(batches.map((batch) => batch.startFrame), [0, 200, 400, 600, 800]);
  assert.equal(batches.reduce((sum, batch) => sum + batch.frameCount, 0), 1000);
});

test('planFrameBatches 对非法批大小有兜底，不会死循环', () => {
  // 非法批大小退回默认的 200 帧一批，而不是切出 0 帧的批次
  assert.deepEqual(planFrameBatches(5, 0), [{ index: 1, startFrame: 0, frameCount: 5 }]);
  assert.deepEqual(planFrameBatches(10, -3), [{ index: 1, startFrame: 0, frameCount: 10 }]);
  assert.deepEqual(planFrameBatches(3, 1).map((batch) => batch.frameCount), [1, 1, 1]);
});

test('帧号与帧率/时间换算：-ss 目标时间落在目标帧内', () => {
  // 200 帧、30fps → 第 201 帧的时间是 6.6666…，减半帧后是 6.65（稳妥落在同一帧）
  const args = buildBatchExtractArgs('in.mp4', 'frames/%08d.jpg', 200, 200, 30);
  assert.equal(args[args.indexOf('-ss') + 1], '6.650000');
  assert.equal(args[args.indexOf('-frames:v') + 1], '200');
  assert.ok(args.includes('image2'));
  assert.equal(args[args.indexOf('-q:v') + 1], '2');
  assert.equal(args.at(-1), 'frames/%08d.jpg');
  assert.ok(args.includes('pipe:1'), '抽帧要带 -progress pipe:1 才能按帧报进度');
});

test('第一批不写 -ss，避免多余的定位开销', () => {
  const args = buildBatchExtractArgs('in.mp4', 'frames/%08d.jpg', 0, 200, 30);
  assert.equal(args.includes('-ss'), false);
});

// ── 抽帧参数（首帧 / 尾帧）─────────────────────────────

test('首帧不定位，直接取第 1 帧', () => {
  const args = buildExportFrameArgs('in.mp4', 'out.jpg', 'first');
  assert.deepEqual(args, ['-y', '-i', 'in.mp4', '-frames:v', '1', '-q:v', '2', 'out.jpg']);
});

test('尾帧的 -ss 必须在 -i 之后（-sseof 会取错帧）', () => {
  const args = buildExportFrameArgs('in.mp4', 'out.jpg', 'last', 12.5);
  assert.ok(args.indexOf('-ss') > args.indexOf('-i'), '-ss 必须放在 -i 之后才是帧精确定位');
  assert.equal(args[args.indexOf('-ss') + 1], '12.460');
  assert.equal(args.includes('-sseof'), false, '尾帧不许用 -sseof');
  assert.deepEqual(args.slice(0, 2), ['-y', '-i']);
});

test('尾帧时长短于 0.04 秒也不会出现负数定位', () => {
  const args = buildExportFrameArgs('in.mp4', 'out.jpg', 'last', 0.01);
  assert.equal(args[args.indexOf('-ss') + 1], '0.000');
});

test('抽帧结果的中文显示名带首帧/尾帧后缀', () => {
  assert.equal(frameDisplayName('clip.mp4', 'first'), 'clip-首帧.jpg');
  assert.equal(frameDisplayName('clip.mov', 'last'), 'clip-尾帧.jpg');
  assert.equal(frameDisplayName('没有扩展名', 'last'), '没有扩展名-尾帧.jpg');
  assert.equal(frameDisplayName('   ', 'first'), '素材-首帧.jpg', '空名字要有兜底，素材名不能是空的');
});

// ── 音轨映射：无音轨不报错 ─────────────────────────────

test('复制音轨一律用带问号的 -map 1:a?', () => {
  const withAudio = buildMuxAudioArgs('merged.mp4', 'source.mp4', 'out.mp4', true);
  const withoutAudio = buildMuxAudioArgs('merged.mp4', 'source.mp4', 'out.mp4', false);
  for (const args of [withAudio, withoutAudio]) {
    assert.ok(args.includes('1:a?'), '音频映射必须带问号，源视频没音轨时才不会报错');
    assert.equal(args.includes('1:a'), false, '不能出现不带问号的 1:a');
    assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'copy']);
    assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 2), ['-c:v', 'copy']);
    assert.equal(args.at(-1), 'out.mp4');
  }
  // 没音轨时不能加 -shortest：否则视频会被按“音频 0 秒”截短
  assert.ok(withAudio.includes('-shortest'));
  assert.equal(withoutAudio.includes('-shortest'), false);
});

// ── ncnn 工具参数 ─────────────────────────────────────

test('buildRealEsrganArgs 用参数数组，顺序符合约定', () => {
  const args = buildRealEsrganArgs({ input: 'in.png', output: 'out.png', model: 'realesrgan-x4plus', scale: 4, tile: 128 });
  assert.deepEqual(args, ['-i', 'in.png', '-o', 'out.png', '-n', 'realesrgan-x4plus', '-s', '4', '-t', '128']);
});

test('给了模型目录才追加 -m，默认不写', () => {
  const args = buildRealEsrganArgs({ input: 'in.png', output: 'out.png', model: 'realesrgan-x4plus-anime', scale: 2, tile: 64, modelPath: 'F:/Canvora/bin/models' });
  assert.deepEqual(args.slice(-2), ['-m', 'F:/Canvora/bin/models']);
});

test('buildRifeArgs 的 -n 传的是目标总帧数而不是倍率', () => {
  // RIFE 的 -n 是目标总帧数：60 帧输入要 2 倍就传 120，传 2 只会得到零点几秒的残片
  assert.deepEqual(buildRifeArgs('frames', 'frames_2x', 'rife-v4.6', 120), ['-i', 'frames', '-o', 'frames_2x', '-m', 'rife-v4.6', '-n', '120']);
  assert.deepEqual(buildRifeArgs('frames', 'frames_4x', 'rife-v4.6', 240), ['-i', 'frames', '-o', 'frames_4x', '-m', 'rife-v4.6', '-n', '240']);
});

test('halveTile 给显存不足重试用，不低于 ncnn 的 32 下限', () => {
  assert.equal(halveTile(128), 64);
  assert.equal(halveTile(64), 32);
  assert.equal(halveTile(32), 32);
  assert.equal(halveTile(33), 32);
  assert.equal(halveTile(0), 0, '0 表示自动，不能变成别的值');
});

test('isGpuMemoryError 能认出显存不足的各种说法', () => {
  assert.equal(isGpuMemoryError('vkAllocateMemory failed'), true);
  assert.equal(isGpuMemoryError('VK_ERROR_OUT_OF_DEVICE_MEMORY'), true);
  assert.equal(isGpuMemoryError('Error: out of memory'), true);
  assert.equal(isGpuMemoryError('invalid model file'), false);
  assert.equal(isGpuMemoryError(''), false);
});

// ── 工具缺失时的中文提示 ───────────────────────────────

test('realesrgan 缺失时给出中文提示与期望路径', () => {
  const expected = 'F:/Canvora/bin/realesrgan-ncnn-vulkan.exe';
  const error = missingToolError('realesrgan', expected);
  assert.ok(error.message.includes('Real-ESRGAN'), error.message);
  assert.ok(error.message.includes('还没安装'), error.message);
  assert.ok(error.message.includes('node scripts/fetch-tools.mjs'), error.message);
  assert.ok(error.detail.includes(expected), error.detail);
});

test('rife 缺失时给出中文提示与期望路径', () => {
  const expected = 'F:/Canvora/bin/rife-ncnn-vulkan.exe';
  const error = missingToolError('rife', expected);
  assert.ok(error.message.includes('RIFE'), error.message);
  assert.ok(error.message.includes('node scripts/fetch-tools.mjs'), error.message);
  assert.ok(error.detail.includes(expected), error.detail);
});

// ── 进度解析 ──────────────────────────────────────────

test('parseFfmpegProgress 解析 -progress pipe:1 的输出', () => {
  const chunk = 'frame=15\nfps=0.00\nout_time_us=5000000\nout_time_ms=5000000\nspeed=1.0x\nprogress=continue\n';
  assert.equal(parseFfmpegProgress(chunk, 10), 0.5);
  assert.equal(parseFfmpegProgress('progress=end\n', 10), 1);
  assert.equal(parseFfmpegProgress('frame=1\n', 10), undefined);
  assert.equal(parseFfmpegProgress('out_time_us=5000000\n', 0), undefined, '没有总时长就无法换算');
  assert.equal(parseFfmpegProgress('out_time_us=999999999\n', 10), 1, '进度不超过 1');
});

test('parseFrameCount 取最后一个 frame=，抽帧进度靠它', () => {
  assert.equal(parseFrameCount('frame=1\nframe=2\nframe=7\n'), 7);
  assert.equal(parseFrameCount('frame=N/A\n'), undefined);
  assert.equal(parseFrameCount('nothing here'), undefined);
});

test('parseNcnnProgress 从工具打印的百分比里捡进度', () => {
  assert.equal(parseNcnnProgress('1.00%\r2.50%\r50.00%\r'), 0.5);
  assert.equal(parseNcnnProgress('done'), undefined);
  assert.equal(parseNcnnProgress('120.00%'), 1);
});

test('parseFrameRate 解析 ffprobe 的分数帧率', () => {
  assert.equal(parseFrameRate('30/1'), 30);
  assert.equal(parseFrameRate('30000/1001'), 29.97);
  assert.equal(parseFrameRate('0/0'), undefined);
  assert.equal(parseFrameRate('30'), undefined);
  assert.equal(parseFrameRate(undefined), undefined);
  assert.equal(interpolatedFps(29.97, 2), 59.94);
});

test('formatFramerate 不把浮点尾巴写进命令行', () => {
  assert.equal(formatFramerate(29.97002997), '29.97');
  assert.equal(formatFramerate(30), '30');
  assert.ok(buildSegmentArgs('frames/%08d.jpg', 29.97002997, 'seg.mp4').includes('29.97'));
});

// ── 合段 / 拼接参数 ───────────────────────────────────

test('合段用 libx264 + yuv420p，保证各段能被 concat 直接拼接', () => {
  const args = buildSegmentArgs('frames_up/%08d.jpg', 30, 'seg/0001.mp4');
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 8), ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']);
  assert.ok(args.includes('-an'), '中间段不带音轨，音轨最后从原视频复制');
  assert.ok(args.includes('-progress'));
});

test('concat 清单用正斜杠并转义单引号，否则 Window 路径会让拼接静默失败', () => {
  assert.equal(concatListLine('F:\\Canvora\\projects\\p1\\temp\\seg\\0001.mp4'), "file 'F:/Canvora/projects/p1/temp/seg/0001.mp4'");
  assert.equal(concatListLine("C:\\a'b\\x.mp4"), "file 'C:/a'\\''b/x.mp4'");
  const args = buildConcatArgs('segments.txt', 'merged.mp4');
  assert.ok(args.includes('concat'));
  assert.deepEqual(args.slice(args.indexOf('-safe'), args.indexOf('-safe') + 2), ['-safe', '0'], '绝对路径必须配 -safe 0');
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'copy']);
});

test('frameFileExtension 只认帧序列文件名', () => {
  assert.equal(frameFileExtension('00000001.jpg'), '.jpg');
  assert.equal(frameFileExtension('0001.PNG'), '.png');
  assert.equal(frameFileExtension('0001.png'), '.png');
  assert.equal(frameFileExtension('01.png'), undefined);
  assert.equal(frameFileExtension('cover.png'), undefined);
  assert.equal(frameFileExtension('0001.txt'), undefined);
});

// ── 中文文案 ──────────────────────────────────────────

test('queueStatusText 显示「前面还有 N 个」', () => {
  assert.equal(queueStatusText(0), '排队中（马上开始）');
  assert.equal(queueStatusText(1), '排队中（前面还有 1 个）');
  assert.equal(queueStatusText(3), '排队中（前面还有 3 个）');
});

test('formatDurationCn 用中文时长，供进度与预计剩余显示', () => {
  assert.equal(formatDurationCn(0), '0 秒');
  assert.equal(formatDurationCn(45), '45 秒');
  assert.equal(formatDurationCn(60), '1 分');
  assert.equal(formatDurationCn(80), '1 分 20 秒');
  assert.equal(formatDurationCn(3725), '1 小时 2 分');
});

// ── 队列行为（不依赖外部工具：用不存在的素材让任务立刻失败）──

const tempRoot = async (t: { after: (fn: () => Promise<void>) => void }): Promise<string> => {
  const dir = join(tmpdir(), `canvora-jobs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
};

const settled = (job: { status: string }) => job.status === 'failed' || job.status === 'succeeded' || job.status === 'cancelled';

test('restoreJobs 把上次 running 的任务标记为失败并给出中文原因', async (t) => {
  const root = await tempRoot(t);
  await writeFile(join(root, 'jobs.json'), JSON.stringify({ jobs: [{
    id: 'job-1', projectId: 'p1', kind: 'upscaleVideo', status: 'running', progress: 0.4,
    statusText: '第 100/9000 帧', assetIds: ['asset-1'], resultAssetIds: [], createdAt: 1, startedAt: 2,
  }] }), 'utf8');

  await restoreJobs(root);

  const job = getJob(root, 'job-1');
  assert.equal(job?.status, 'failed');
  assert.equal(job?.errorMessage, '上次运行被中断，请重新执行');
  assert.equal(job?.statusText, '上次运行被中断，请重新执行');
  assert.ok(job?.errorDetail?.includes('ffmpeg'), 'detail 要写清子进程死了这个技术细节');
  assert.equal(job?.finishedAt !== undefined, true);

  const saved = JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')) as { jobs: Array<{ status: string }> };
  assert.equal(saved.jobs[0].status, 'failed', '恢复结果要落盘，避免下次启动又当成中断任务');
});

test('本地任务严格串行：同一时刻最多 1 个在跑，其余排队并显示前面还有几个', async (t) => {
  const root = await tempRoot(t);
  const ids = [0, 1, 2].map(() => enqueueJob(root, { projectId: 'p1', kind: 'upscaleImage', assetIds: ['不存在的素材'] }).id);

  const afterEnqueue = listJobs(root);
  assert.equal(afterEnqueue.length, 3, '三个任务都要记进队列');
  assert.equal(afterEnqueue.filter((job) => job.status === 'running').length, 1, '第一个立刻开跑');
  const queued = afterEnqueue.filter((job) => job.status === 'queued');
  assert.deepEqual(queued.map((job) => job.statusText), ['排队中（马上开始）', '排队中（前面还有 1 个）']);
  assert.deepEqual(queued.map((job) => job.progress), [0, 0]);

  let maxRunning = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    maxRunning = Math.max(maxRunning, listJobs(root).filter((job) => job.status === 'running').length);
    if (listJobs(root).every(settled)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(maxRunning, 1, '任何时刻都不能有两个任务同时跑（16GB 机器的硬约束）');
  for (const id of ids) {
    const job = getJob(root, id);
    assert.equal(job?.status, 'failed', '素材不存在，三个任务都该失败而不是卡住');
    assert.equal(job?.errorMessage, '素材不存在或已被删除，请重新选择素材');
  }
  const saved = JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')) as { jobs: unknown[] };
  assert.equal(saved.jobs.length, 3, '任务要持久化到 <工作区>/jobs.json');
});

test('cancelJob 对不存在或已结束的任务返回 false', async (t) => {
  const root = await tempRoot(t);
  assert.equal(await cancelJob(root, '没有这个任务'), false);

  const job = enqueueJob(root, { projectId: 'p1', kind: 'upscaleVideo', assetIds: [] });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !settled(getJob(root, job.id) ?? { status: 'running' })) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getJob(root, job.id)?.errorMessage, '这个任务没有指定素材，请重新选择素材后再执行');
  assert.equal(await cancelJob(root, job.id), false, '已经结束的任务不能再取消');
});

// ── 图片分割：网格切分（不依赖 ffmpeg 的纯逻辑）──────────

const gridCases: Array<[number, number, number, number]> = [
  [754, 882, 2, 2],
  [754, 882, 3, 3],
  [754, 882, 1, 3],
  [1920, 1080, 3, 2],
  [1920, 1080, 4, 4],
  [1920, 1080, 1, 1],
  [100, 100, 8, 8],
  [17, 5, 3, 4],
];

test('planGridCells：格子不越界、数量正确、面积之和等于原图面积', () => {
  for (const [width, height, cols, rows] of gridCases) {
    const cells = planGridCells(width, height, cols, rows);
    assert.equal(cells.length, cols * rows, `${width}x${height} 切 ${cols}x${rows} 的格子数量不对`);
    for (const cell of cells) {
      assert.ok(cell.x + cell.width <= width, `${width} 宽的图出现了越界的格子：${JSON.stringify(cell)}`);
      assert.ok(cell.y + cell.height <= height, `${height} 高的图出现了越界的格子：${JSON.stringify(cell)}`);
      assert.ok(cell.width >= 1 && cell.height >= 1, `格子不能是 0 像素：${JSON.stringify(cell)}`);
      assert.ok(cell.row >= 1 && cell.row <= rows && cell.col >= 1 && cell.col <= cols);
    }
    const area = cells.reduce((sum, cell) => sum + cell.width * cell.height, 0);
    assert.equal(area, width * height, `${width}x${height} 切 ${cols}x${rows} 后面积不守恒（丢像素或重叠）`);
  }
});

test('planGridCells：逐像素检查覆盖整张图且互不重叠', () => {
  const width = 101;
  const height = 73;
  const covered = new Set<string>();
  for (const cell of planGridCells(width, height, 4, 3)) {
    for (let y = cell.y; y < cell.y + cell.height; y += 1) {
      for (let x = cell.x; x < cell.x + cell.width; x += 1) {
        const key = `${x},${y}`;
        assert.equal(covered.has(key), false, `像素 ${key} 被切了两次`);
        covered.add(key);
      }
    }
  }
  assert.equal(covered.size, width * height, '每个像素都必须恰好被切到一次');
});

test('splitAxis：前 n-1 格取整除尺寸、最后一格吃掉余数，绝不出 0 像素', () => {
  assert.deepEqual(splitAxis(754, 3, '宽'), [251, 251, 252]);
  assert.deepEqual(splitAxis(882, 3, '高'), [294, 294, 294]);
  assert.deepEqual(splitAxis(1920, 3, '宽'), [640, 640, 640]);
  assert.deepEqual(splitAxis(1080, 2, '高'), [540, 540]);
  assert.deepEqual(splitAxis(7, 4, '宽'), [1, 1, 1, 4]);
  // 「每格都向上取整」的算法在 4 像素切 3 格时会给出 0 像素的最后一格，这里必须不是
  assert.deepEqual(splitAxis(4, 3, '宽'), [1, 1, 2]);
  assert.throws(() => splitAxis(2, 3, '宽'), /切不成 3 格/);
});

test('planGridCells 的坐标顺序是左上到右下，行列从 1 开始', () => {
  assert.deepEqual(planGridCells(1920, 1080, 3, 2).map((cell) => [cell.row, cell.col, cell.x, cell.y, cell.width, cell.height]), [
    [1, 1, 0, 0, 640, 540],
    [1, 2, 640, 0, 640, 540],
    [1, 3, 1280, 0, 640, 540],
    [2, 1, 0, 540, 640, 540],
    [2, 2, 640, 540, 640, 540],
    [2, 3, 1280, 540, 640, 540],
  ]);
  assert.deepEqual(planGridCells(754, 882, 1, 1), [{ row: 1, col: 1, x: 0, y: 0, width: 754, height: 882 }]);
});

test('行列数超出 1~8 或用非整数时用中文拒绝', () => {
  for (const value of [0, 9, -1, -8, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'abc', null, undefined, {}]) {
    assert.throws(() => planGridCells(754, 882, value, 2), /必须是整数|只能是 1 到 8 之间的整数/);
    assert.throws(() => planGridCells(754, 882, 2, value), /必须是整数|只能是 1 到 8 之间的整数/);
    assert.throws(() => parseGridDivision(value, '行数'), /必须是整数|只能是 1 到 8 之间的整数/);
  }
  assert.equal(parseGridDivision(1, '列数'), 1);
  assert.equal(parseGridDivision(8, '行数'), 8);
  assert.equal(parseGridDivision('3', '列数'), 3, '前端传字符串数字也要收');
  // 图太小切不出目标格数时要明确拒绝，而不是产出 0 像素的格子
  assert.throws(() => planGridCells(2, 2, 3, 3), /切不成 3 格/);
  assert.throws(() => planGridCells(0, 100, 2, 2), /读不出图片的真实尺寸/);
});

test('切块的显示名与 ffmpeg 参数按约定生成', () => {
  const cells = planGridCells(754, 882, 3, 3);
  assert.equal(gridCellDisplayName('小猫咪.jpg', cells[0]), '小猫咪-第1行第1列.png');
  assert.equal(gridCellDisplayName('小猫咪.jpg', cells[4]), '小猫咪-第2行第2列.png');
  assert.equal(gridCellDisplayName('小猫咪.jpg', cells[8]), '小猫咪-第3行第3列.png');
  assert.equal(gridCellDisplayName('没有扩展名', cells[1]), '没有扩展名-第1行第2列.png');
  assert.equal(gridCellDisplayName('   ', cells[0]), '素材-第1行第1列.png');

  const graph = buildGridFilterGraph(planGridCells(754, 882, 2, 2));
  // 先转 rgb24：4:2:0 素材（JPEG）在奇数坐标上 crop 会被强行对齐到偶数，会丢像素
  assert.match(graph, /\[0:v\]format=rgb24,split=4\[s0\]\[s1\]\[s2\]\[s3\]/);
  assert.match(graph, /\[s0\]crop=377:441:0:0\[c0\]/);
  assert.match(graph, /\[s1\]crop=377:441:377:0\[c1\]/);
  assert.match(graph, /\[s3\]crop=377:441:377:441\[c3\]/);

  const args = buildGridSplitArgs('C:/素材/小猫咪.jpg', 'C:/temp/grid.txt', ['o0.png', 'o1.png', 'o2.png', 'o3.png']);
  assert.deepEqual(args, [
    '-y', '-i', 'C:/素材/小猫咪.jpg', '-filter_complex_script', 'C:/temp/grid.txt',
    '-map', '[c0]', 'o0.png', '-map', '[c1]', 'o1.png', '-map', '[c2]', 'o2.png', '-map', '[c3]', 'o3.png',
  ]);
  assert.equal(args.includes('&&'), false, '一律参数数组 spawn，不许拼 shell 字符串');
});

// ── 时间轴导出：设置解析与导出前校验 ───────────────────

test('导出命令行只传 -filter_complex_script，绝不把滤镜拼进命令行', () => {
  const compiled = compileEdl(
    { fps: 30, width: 1280, height: 720, backgroundColor: '#000000', clips: [
      { path: 'C:/x/a.mp4', inPoint: 0, outPoint: 4, startAt: 0, speed: 2, hasAudio: true, audioMode: 'keep' },
    ] },
    { fileName: '成片.mp4', crf: 18, preset: 'medium', encoder: 'libx264', width: 1280, height: 720, fps: 30 },
  );
  const args = buildExportTimelineArgs(compiled, 'C:\\临时\\export.txt', 'C:\\临时\\out.mp4');
  assert.equal(args[args.indexOf('-filter_complex_script') + 1], 'C:\\临时\\export.txt');
  assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
  assert.deepEqual(args.slice(args.indexOf('-i'), args.indexOf('-filter_complex_script')), ['-i', 'C:/x/a.mp4']);
  const maps = args.indexOf('-map');
  assert.deepEqual(args.slice(maps, maps + 4), ['-map', '[vcat]', '-map', '[acat]']);
  assert.equal(args.at(-1), 'C:\\临时\\out.mp4');
  // 滤镜文本一个字符都不能出现在命令行里（AGENTS.md 4.6 的红线）
  for (const banned of ['trim=', 'concat=', 'between(', 'atempo=', 'filter_complex=']) {
    assert.equal(args.some((arg) => arg.includes(banned)), false, `命令行里不该出现 ${banned}`);
  }
});

test('sanitizeExportFileName 清掉 Windows 非法字符并保证是 mp4', () => {
  assert.equal(sanitizeExportFileName('我的成片.mp4'), '我的成片.mp4');
  assert.equal(sanitizeExportFileName('我的成片'), '我的成片.mp4');
  assert.equal(sanitizeExportFileName('a/b\\c:d*e?f.mp4'), 'abcdef.mp4');
  assert.equal(sanitizeExportFileName('  spacing  多  空格  '), 'spacing 多 空格.mp4');
  assert.equal(sanitizeExportFileName('   '), '成片.mp4');
  assert.equal(sanitizeExportFileName('...'), '成片.mp4');
  assert.equal(sanitizeExportFileName('.mp4'), '成片.mp4');
  assert.equal(sanitizeExportFileName(undefined), '成片.mp4');
});

test('readExportTimelineOptions 缺内容时给中文提示，不缺时补默认值', () => {
  assert.throws(() => readExportTimelineOptions(undefined), /没有收到时间轴内容/);
  assert.throws(() => readExportTimelineOptions({ settings: {} }), /没有收到时间轴内容/);
  assert.throws(() => readExportTimelineOptions({ edl: { clips: [] } }), /没有收到导出设置|没有可导出的片段/);
  assert.throws(() => readExportTimelineOptions({ edl: { clips: [] }, settings: {} }), /没有可导出的片段/);
  assert.throws(() => readExportTimelineOptions({ edl: { clips: [{}] }, settings: {} }), /没有对应的素材文件/);

  const { edl, settings } = readExportTimelineOptions({
    edl: { fps: 30, width: 1920, height: 1080, clips: [{ path: 'C:/a.mp4', inPoint: 1, outPoint: 5 }] },
    settings: { fileName: '成片' },
  });
  assert.equal(settings.fileName, '成片.mp4');
  assert.equal(settings.crf, 18);
  assert.equal(settings.preset, 'medium');
  assert.equal(settings.encoder, 'libx264');
  assert.equal(settings.width, 1920);
  assert.equal(settings.height, 1080);
  assert.equal(settings.fps, 30);
  assert.equal(edl.backgroundColor, '#000000');
  assert.equal(edl.clips[0].speed, 1, '没写变速就按原速');
  assert.equal(edl.clips[0].hasAudio, false);
  assert.equal(edl.clips[0].audioMode, 'keep');
});

test('导出任务：片段的入点出点不合法时用中文拒绝，且不会去调 ffmpeg', async (t) => {
  const root = await tempRoot(t);
  const job = enqueueJob(root, {
    projectId: 'p1',
    kind: 'exportTimeline',
    assetIds: [],
    options: {
      edl: { fps: 30, width: 1280, height: 720, backgroundColor: '#000000', clips: [
        { path: join(root, '随便.mp4'), inPoint: 5, outPoint: 2, startAt: 0, speed: 1, hasAudio: true, audioMode: 'keep' },
      ] },
      settings: { fileName: '成片', crf: 18, preset: 'medium', encoder: 'libx264', width: 1280, height: 720, fps: 30 },
    },
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !settled(getJob(root, job.id) ?? { status: 'running' })) await new Promise((resolve) => setTimeout(resolve, 10));
  const finished = getJob(root, job.id);
  assert.equal(finished?.status, 'failed');
  assert.match(String(finished?.errorMessage), /片段 1：入点必须小于出点/);
});

test('导出任务：素材文件缺失时先拒绝，并列出缺了哪些', async (t) => {
  const root = await tempRoot(t);
  const missing = join(root, '已经删掉的素材.mp4');
  const job = enqueueJob(root, {
    projectId: 'p1',
    kind: 'exportTimeline',
    assetIds: [],
    options: {
      edl: { fps: 30, width: 1280, height: 720, backgroundColor: '#000000', clips: [
        { path: missing, inPoint: 0, outPoint: 4, startAt: 0, speed: 1, hasAudio: true, audioMode: 'keep' },
      ] },
      settings: { fileName: '成片', crf: 18, preset: 'medium', encoder: 'libx264', width: 1280, height: 720, fps: 30 },
    },
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !settled(getJob(root, job.id) ?? { status: 'running' })) await new Promise((resolve) => setTimeout(resolve, 10));
  const finished = getJob(root, job.id);
  assert.equal(finished?.status, 'failed');
  assert.match(String(finished?.errorMessage), /素材文件找不到了/);
  assert.ok(finished?.errorDetail?.includes(missing), finished?.errorDetail);
});

