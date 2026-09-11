import type { Job, JobKind, ToolStatus } from '@canvora/shared';

interface Snapshot {
  root: string;
  version: string;
  startedAt: number;
  now: number;
  projects: Array<{ id: string; name: string; assets: number; updatedAt: number }>;
  totalAssets: number;
  tools: ToolStatus;
  jobs: Array<{ id: string; kind: JobKind; status: Job['status']; statusText: string; progress: number; startedAt?: number; finishedAt?: number }>;
  secretProviders: string[];
  memory: { rssMb: number; heapUsedMb: number };
}

const KIND_LABEL: Record<JobKind, string> = {
  exportFrames: '导出首尾帧', upscaleImage: '图片放大', upscaleVideo: '视频放大',
  interpolateVideo: '视频补帧', splitImage: '图片分割', exportTimeline: '导出成片',
};
const STATUS_LABEL: Record<Job['status'], string> = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const STATUS_CLASS: Record<Job['status'], string> = { queued: 'queued', running: 'running', succeeded: 'ok', failed: 'bad', cancelled: 'idle' };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));
const formatBytes = (mb: number) => `${mb.toFixed(0)} MB`;
const formatTime = (ms?: number) => (ms ? new Date(ms).toLocaleString('zh-CN') : '—');

/**
 * 后端自带的状态页。用户不用打开前端也能看到服务是否正常、工具是否就绪、任务跑到哪了，
 * 并且可以在这里安全地关掉后台。
 */
export function renderStatusPage(snapshot: Snapshot): string {
  const uptimeMinutes = Math.round((snapshot.now - snapshot.startedAt) / 60000);
  const toolRow = ([['ffmpeg', snapshot.tools.ffmpeg], ['ffprobe', snapshot.tools.ffprobe], ['Real-ESRGAN', snapshot.tools.realesrgan], ['RIFE', snapshot.tools.rife]] as Array<[string, boolean]>)
    .map(([name, ok]) => `<span class="tool ${ok ? 'ok' : 'bad'}">${name} ${ok ? '就绪' : '未安装'}</span>`).join('');

  const projectRows = snapshot.projects.length
    ? snapshot.projects.map((project) => `<tr><td>${escapeHtml(project.name)}</td><td>${project.assets}</td><td>${formatTime(project.updatedAt)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">还没有项目</td></tr>';

  const jobRows = snapshot.jobs.length
    ? snapshot.jobs.slice(0, 20).map((job) => `<tr>
        <td>${KIND_LABEL[job.kind] ?? job.kind}</td>
        <td><span class="status ${STATUS_CLASS[job.status]}">${STATUS_LABEL[job.status] ?? job.status}</span></td>
        <td class="muted">${escapeHtml(job.statusText || '').slice(0, 60)}</td>
        <td>${Math.round((job.progress ?? 0) * 100)}%</td>
        <td class="muted">${formatTime(job.finishedAt ?? job.startedAt)}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="muted">还没有任务</td></tr>';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Canvora 后台</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px 24px 60px; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f4f6f8; color: #1f2937; }
  @media (prefers-color-scheme: dark) { body { background: #12161c; color: #e5e7eb; } .card { background: #1d232c !important; border-color: #303846 !important; } th { color: #cbd5e1 !important; } td { border-color: #2b3441 !important; } }
  .wrap { max-width: 940px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { margin: 0 0 22px; color: #64748b; font-size: 13px; }
  .card { padding: 18px 20px; margin-bottom: 16px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; }
  .card h2 { margin: 0 0 12px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .kv { font-size: 12px; color: #475569; }
  .kv b { display: block; color: #1f2937; font-size: 14px; margin-top: 2px; word-break: break-all; }
  @media (prefers-color-scheme: dark) { .kv b { color: #e5e7eb; } }
  .tool { display: inline-block; margin: 0 8px 8px 0; padding: 5px 11px; border-radius: 7px; font-size: 12px; }
  .tool.ok { color: #15803d; background: #dcfce7; }
  .tool.bad { color: #b91c1c; background: #fee2e2; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { padding: 7px 8px; text-align: left; color: #64748b; border-bottom: 1px solid #e5e7eb; font-weight: 600; }
  td { padding: 7px 8px; border-bottom: 1px solid #f1f5f9; }
  .muted { color: #94a3b8; }
  .status { padding: 2px 8px; border-radius: 5px; background: #f1f5f9; color: #475569; }
  .status.ok { color: #15803d; background: #dcfce7; }
  .status.running { color: #0f766e; background: #ccfbf1; }
  .status.bad { color: #b91c1c; background: #fee2e2; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  button { padding: 9px 16px; font: inherit; font-size: 13px; color: #fff; background: #4f46e5; border: 0; border-radius: 8px; cursor: pointer; }
  button.ghost { color: #4f46e5; background: transparent; border: 1px solid #c7d2fe; }
  button.danger { background: #dc2626; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .note { margin-top: 10px; color: #94a3b8; font-size: 11px; }
</style></head>
<body><div class="wrap">
  <h1>Canvora 后台</h1>
  <p class="sub">这是后端服务的状态页。前端界面在 <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>。</p>

  <div class="card">
    <h2>服务状态</h2>
    <div class="grid">
      <div class="kv">工作区<b>${escapeHtml(snapshot.root)}</b></div>
      <div class="kv">版本<b>${snapshot.version}</b></div>
      <div class="kv">已运行<b>${uptimeMinutes} 分钟</b></div>
      <div class="kv">项目 / 素材<b>${snapshot.projects.length} 个 / ${snapshot.totalAssets} 个</b></div>
      <div class="kv">内存占用<b>${formatBytes(snapshot.memory.rssMb)}（堆 ${formatBytes(snapshot.memory.heapUsedMb)}）</b></div>
      <div class="kv">已存密钥<b>${snapshot.secretProviders.length ? snapshot.secretProviders.map(escapeHtml).join('、') : '未配置'}</b></div>
    </div>
    <div style="margin-top:14px">${toolRow}</div>
    <div class="note">内存超过 2GB 时说明有任务在吃内存；本机 16GB，放大/补帧会大量占用，同一时刻只跑 1 个。</div>
  </div>

  <div class="card">
    <h2>本地任务（最近 20 条）</h2>
    <table><thead><tr><th>类型</th><th>状态</th><th>说明</th><th>进度</th><th>时间</th></tr></thead>
    <tbody>${jobRows}</tbody></table>
  </div>

  <div class="card">
    <h2>项目</h2>
    <table><thead><tr><th>名称</th><th>素材数</th><th>最后更新</th></tr></thead>
    <tbody>${projectRows}</tbody></table>
  </div>

  <div class="card">
    <h2>关闭</h2>
    <div class="row">
      <button class="danger" id="stop">关闭后端服务</button>
      <button class="ghost" id="refresh">刷新状态</button>
    </div>
    <div class="note">关闭后前端页面会提示"无法连接后端"；重新启动请双击项目目录下的 启动.bat。</div>
  </div>
</div>
<script>
  const stopBtn = document.getElementById('stop');
  stopBtn.addEventListener('click', async () => {
    if (!confirm('确定关闭后端服务吗？正在跑的任务会被中断，刷新页面也不会恢复，需要重新双击 启动.bat。')) return;
    stopBtn.disabled = true;
    stopBtn.textContent = '正在关闭…';
    try {
      await fetch('/api/shutdown', { method: 'POST' });
      document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:sans-serif"><h1>后端已关闭</h1><p>可以关闭这个页面了。重新启动请双击项目目录下的 启动.bat。</p></div>';
    } catch (error) {
      stopBtn.disabled = false;
      stopBtn.textContent = '关闭后端服务';
      alert('关闭请求失败：' + error.message);
    }
  });
  document.getElementById('refresh').addEventListener('click', () => location.reload());
  // 有任务在跑就自动刷新，方便看进度
  const hasRunning = ${snapshot.jobs.some((job) => job.status === 'running' || job.status === 'queued')};
  if (hasRunning) setTimeout(() => location.reload(), 3000);
</script>
</body></html>`;
}
