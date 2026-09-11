import type { Asset, AssetGroup, GenerationTask, Job, JobKind, Project, Provider, ToolStatus } from '@canvora/shared';

interface Snapshot {
  root: string;
  version: string;
  startedAt: number;
  now: number;
  projects: Project[];
  assets: Asset[];
  groups: AssetGroup[];
  providers: Provider[];
  presets: StatusPagePreset[];
  secrets: Array<{ providerId: string; last4: string; testStatus?: 'success' | 'failed' }>;
  tasks: GenerationTask[];
  tools: ToolStatus;
  jobs: Array<{ id: string; kind: JobKind; status: Job['status']; statusText: string; progress: number; startedAt?: number; finishedAt?: number; resultAssetIds: string[] }>;
  memory: { rssMb: number; heapUsedMb: number };
}

const KIND_LABEL: Record<JobKind, string> = {
  exportFrames: '导出首尾帧', upscaleImage: '图片放大', upscaleVideo: '视频放大',
  interpolateVideo: '视频补帧', splitImage: '图片分割', exportTimeline: '导出成片',
};
const CLOUD_KIND_LABEL: Record<GenerationTask['kind'], string> = {
  image: '云端生图', video: '云端生视频', text: '云端文本', upscale: '放大',
  interpolate: '补帧', extractFrame: '抽帧', export: '导出', proxy: '代理文件',
};
const STATUS_LABEL: Record<string, string> = { queued: '排队中', running: '进行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' };
const STATUS_CLASS: Record<string, string> = { queued: 'queued', running: 'running', succeeded: 'ok', failed: 'bad', cancelled: 'idle' };
const CAPABILITY_LABEL: Record<string, string> = {
  text: '文本', text2image: '文生图', image2image: '图生图', imageEdit: '图片编辑',
  text2video: '文生视频', image2video: '图生视频', firstLastFrame: '首尾帧',
};

export interface StatusPagePreset { id: string; name: string; protocol: Provider['protocol']; baseUrl: string }
export type { Snapshot as StatusPageSnapshot };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));
const formatBytes = (mb: number) => `${mb.toFixed(0)} MB`;
const formatTime = (ms?: number) => (ms ? new Date(ms).toLocaleString('zh-CN') : '—');
const formatSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;

/**
 * 本机后端管理页。
 *
 * 它同时承担两件事：看服务是否正常（工具、内存、任务），以及管理项目 / 素材 / 服务商 / 任务。
 * 所有表单都调用已有的 JSON 接口，页面本身不参与业务逻辑。
 * 密钥只在保存时从表单提交给后端，页面永远不回显明文，只显示尾四位。
 */
export function renderStatusPage(snapshot: Snapshot): string {
  const uptimeMinutes = Math.round((snapshot.now - snapshot.startedAt) / 60000);
  const toolRow = ([['ffmpeg', snapshot.tools.ffmpeg], ['ffprobe', snapshot.tools.ffprobe], ['Real-ESRGAN', snapshot.tools.realesrgan], ['RIFE', snapshot.tools.rife]] as Array<[string, boolean]>)
    .map(([name, ok]) => `<span class="tool ${ok ? 'ok' : 'bad'}">${name} ${ok ? '就绪' : '未安装'}</span>`).join('');

  const projectOptions = snapshot.projects
    .map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');

  const projectRows = snapshot.projects.length
    ? snapshot.projects.map((project) => {
      const assets = snapshot.assets.filter((asset) => asset.projectId === project.id);
      const bytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
      return `<tr>
        <td>${escapeHtml(project.name)}</td>
        <td>${assets.length}</td>
        <td class="muted">${formatSize(bytes)}</td>
        <td class="muted">${formatTime(project.updatedAt)}</td>
        <td class="actions">
          <button class="ghost tiny" data-rename-project="${escapeHtml(project.id)}" data-name="${escapeHtml(project.name)}">重命名</button>
          <button class="danger tiny" data-delete-project="${escapeHtml(project.id)}" data-name="${escapeHtml(project.name)}">删除</button>
        </td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="5" class="muted">还没有项目。用下面的表单新建一个。</td></tr>';

  const assetRows = snapshot.assets.length
    ? snapshot.assets.slice(0, 200).map((asset) => `<tr>
        <td>${escapeHtml(asset.originalName)}</td>
        <td>${escapeHtml(snapshot.projects.find((project) => project.id === asset.projectId)?.name ?? asset.projectId)}</td>
        <td>${asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : '音频'}</td>
        <td class="muted">${formatSize(asset.sizeBytes)}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}</td>
        <td class="muted">${formatTime(asset.createdAt)}</td>
        <td class="actions">
          <button class="ghost tiny" data-rename-asset="${escapeHtml(asset.id)}" data-name="${escapeHtml(asset.originalName)}">重命名</button>
          <button class="danger tiny" data-delete-asset="${escapeHtml(asset.id)}" data-name="${escapeHtml(asset.originalName)}">删除</button>
        </td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="muted">还没有素材。</td></tr>';

  const providerRows = snapshot.providers.length
    ? snapshot.providers.map((provider) => {
      const secret = snapshot.secrets.find((item) => item.providerId === provider.id);
      const capabilities = [...new Set(provider.models.flatMap((model) => model.capabilities))]
        .map((capability) => `<span class="chip">${escapeHtml(CAPABILITY_LABEL[capability] ?? capability)}</span>`).join(' ');
      const models = provider.models.map((model) => `${model.displayName}（${model.id}）`).join('<br/>') || '<span class="muted">未配置模型</span>';
      return `<tr>
        <td>
          <strong>${escapeHtml(provider.name)}</strong>
          ${provider.enabled ? '<span class="chip ok">已启用</span>' : '<span class="chip bad">已停用</span>'}
          ${provider.isPreset ? '<span class="chip">预置</span>' : ''}
          <div class="muted tiny">${escapeHtml(provider.protocol)} · ${escapeHtml(provider.baseUrl)}</div>
        </td>
        <td class="tiny">${models}</td>
        <td>${capabilities || '<span class="muted">—</span>'}</td>
        <td class="tiny">${secret ? `尾号 ${escapeHtml(secret.last4)}${secret.testStatus === 'success' ? ' · 测试通过' : secret.testStatus === 'failed' ? ' · 测试失败' : ''}` : '<span class="muted">未配置密钥</span>'}</td>
        <td class="actions">
          <button class="ghost tiny" data-edit-provider="${escapeHtml(provider.id)}">编辑</button>
          <button class="ghost tiny" data-key-provider="${escapeHtml(provider.id)}" data-name="${escapeHtml(provider.name)}">${secret ? '更换密钥' : '填写密钥'}</button>
          <button class="ghost tiny" data-test-provider="${escapeHtml(provider.id)}">测试连接</button>
          <button class="ghost tiny" data-toggle-provider="${escapeHtml(provider.id)}" data-enabled="${provider.enabled ? '1' : '0'}">${provider.enabled ? '停用' : '启用'}</button>
          <button class="danger tiny" data-delete-provider="${escapeHtml(provider.id)}" data-name="${escapeHtml(provider.name)}">删除</button>
        </td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="5" class="muted">还没有服务商。选一个预置或自己填一个。</td></tr>';

  const presetOptions = snapshot.presets
    .map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}（${escapeHtml(preset.baseUrl)}）</option>`).join('');

  const taskRows = snapshot.tasks.length
    ? snapshot.tasks.slice(0, 50).map((task) => `<tr>
        <td>${escapeHtml(CLOUD_KIND_LABEL[task.kind] ?? task.kind)}</td>
        <td><span class="status ${STATUS_CLASS[task.status]}">${escapeHtml(STATUS_LABEL[task.status] ?? task.status)}</span></td>
        <td class="muted tiny">${escapeHtml(task.modelId ?? '默认模型')}</td>
        <td>${Math.round((task.progress ?? 0) * 100)}%</td>
        <td class="muted tiny">${escapeHtml(task.errorMessage ?? task.statusText ?? '')}</td>
        <td class="muted">${formatTime(task.finishedAt ?? task.startedAt ?? task.createdAt)}</td>
        <td class="actions">
          ${task.status === 'queued' || task.status === 'running'
            ? `<button class="ghost tiny" data-cancel-task="${escapeHtml(task.id)}">取消</button>`
            : `<button class="danger tiny" data-delete-task="${escapeHtml(task.id)}">删除</button>`}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="7" class="muted">还没有云端生成任务。</td></tr>';

  const jobRows = snapshot.jobs.length
    ? snapshot.jobs.slice(0, 30).map((job) => `<tr>
        <td>${KIND_LABEL[job.kind] ?? job.kind}</td>
        <td><span class="status ${STATUS_CLASS[job.status]}">${STATUS_LABEL[job.status] ?? job.status}</span></td>
        <td class="muted">${escapeHtml(job.statusText || '').slice(0, 60)}</td>
        <td>${Math.round((job.progress ?? 0) * 100)}%</td>
        <td class="muted">${formatTime(job.finishedAt ?? job.startedAt)}</td>
        <td class="actions">
          ${job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled'
            ? `<button class="danger tiny" data-delete-job="${escapeHtml(job.id)}">移除</button>` : '<span class="muted tiny">执行中</span>'}
        </td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="muted">还没有本地任务。</td></tr>';

  const groupRows = snapshot.groups.map((group) => `<span class="chip">${escapeHtml(group.name)}</span>`).join(' ');

  const payload = JSON.stringify({
    presets: snapshot.presets,
    providers: snapshot.providers.map((provider) => ({ id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, enabled: provider.enabled, models: provider.models })),
    projects: snapshot.projects.map((project) => ({ id: project.id, name: project.name })),
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Canvora 后台</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px 20px 60px; font-family: "Microsoft YaHei", "Segoe UI", sans-serif; background: #f4f6f8; color: #1f2937; }
  @media (prefers-color-scheme: dark) { body { background: #12161c; color: #e5e7eb; } .card { background: #1d232c !important; border-color: #303846 !important; } th { color: #cbd5e1 !important; } td { border-color: #2b3441 !important; } input, select, textarea { background: #18202a !important; color: #e5e7eb !important; border-color: #475569 !important; } }
  .wrap { max-width: 1120px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { margin: 0 0 18px; color: #64748b; font-size: 13px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
  .tabs button { padding: 7px 15px; border-radius: 8px; border: 1px solid #e5e7eb; background: #fff; color: #475569; cursor: pointer; font: inherit; font-size: 13px; }
  .tabs button.active { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  .card { padding: 18px 20px; margin-bottom: 16px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; }
  .card h2 { margin: 0 0 12px; font-size: 14px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }
  .kv { font-size: 12px; color: #475569; }
  .kv b { display: block; color: #1f2937; font-size: 14px; margin-top: 2px; word-break: break-all; }
  @media (prefers-color-scheme: dark) { .kv b { color: #e5e7eb; } }
  .tool, .chip { display: inline-block; margin: 0 6px 6px 0; padding: 4px 10px; border-radius: 7px; font-size: 12px; background: #f1f5f9; color: #475569; }
  .tool.ok, .chip.ok { color: #15803d; background: #dcfce7; }
  .tool.bad, .chip.bad { color: #b91c1c; background: #fee2e2; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { padding: 7px 8px; text-align: left; color: #64748b; border-bottom: 1px solid #e5e7eb; font-weight: 600; }
  td { padding: 7px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  .actions { white-space: nowrap; }
  .muted { color: #94a3b8; }
  .tiny { font-size: 11px; }
  .status { padding: 2px 8px; border-radius: 5px; background: #f1f5f9; color: #475569; }
  .status.ok { color: #15803d; background: #dcfce7; }
  .status.running { color: #0f766e; background: #ccfbf1; }
  .status.bad { color: #b91c1c; background: #fee2e2; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  button { padding: 9px 16px; font: inherit; font-size: 13px; color: #fff; background: #4f46e5; border: 0; border-radius: 8px; cursor: pointer; }
  button.ghost { color: #4f46e5; background: transparent; border: 1px solid #c7d2fe; }
  button.danger { background: #dc2626; }
  button.tiny { padding: 4px 10px; font-size: 11px; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  input, select, textarea { padding: 8px 10px; font: inherit; font-size: 13px; color: inherit; background: #fff; border: 1px solid #d6dde6; border-radius: 8px; }
  .form-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
  .form-row label { font-size: 12px; color: #64748b; min-width: 74px; }
  .form-row input, .form-row select { flex: 1; min-width: 160px; }
  .note { margin-top: 10px; color: #94a3b8; font-size: 11px; line-height: 1.7; }
  .panel { display: none; }
  .panel.active { display: block; }
  dialog { border: 0; border-radius: 14px; padding: 0; max-width: 640px; width: 92%; }
  dialog::backdrop { background: #0f172a99; }
  .dialog-body { padding: 20px 22px; background: #fff; color: #1f2937; }
  dialog h3 { margin: 0 0 14px; font-size: 15px; }
  @media (prefers-color-scheme: dark) { .dialog-body { background: #1d232c; color: #e5e7eb; } }
</style></head>
<body><div class="wrap">
  <h1>Canvora 后台</h1>
  <p class="sub">服务商、密钥和项目管理都在这里配置。前端界面在 <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>。</p>

  <div class="tabs">
    <button class="active" data-tab="overview">概览</button>
    <button data-tab="providers">服务商</button>
    <button data-tab="projects">项目</button>
    <button data-tab="assets">素材</button>
    <button data-tab="tasks">任务</button>
  </div>

  <section class="panel active" data-panel="overview">
    <div class="card">
      <h2>服务状态</h2>
      <div class="grid">
        <div class="kv">工作区<b>${escapeHtml(snapshot.root)}</b></div>
        <div class="kv">版本<b>${escapeHtml(snapshot.version)}</b></div>
        <div class="kv">已运行<b>${uptimeMinutes} 分钟</b></div>
        <div class="kv">项目 / 素材<b>${snapshot.projects.length} 个 / ${snapshot.assets.length} 个</b></div>
        <div class="kv">内存占用<b>${formatBytes(snapshot.memory.rssMb)}（堆 ${formatBytes(snapshot.memory.heapUsedMb)}）</b></div>
        <div class="kv">服务商 / 密钥<b>${snapshot.providers.length} 个 / ${snapshot.secrets.length} 个</b></div>
      </div>
      <div style="margin-top:14px">${toolRow}</div>
      <div class="note">内存超过 2GB 时说明有任务在吃内存；本机 16GB，放大/补帧会大量占用，同一时刻只跑 1 个。</div>
    </div>
    <div class="card">
      <h2>关闭</h2>
      <div class="row">
        <button class="danger" id="stop">关闭后端服务</button>
        <button class="ghost" id="refresh">刷新</button>
      </div>
      <div class="note">关闭后前端页面会提示"无法连接后端"；重新启动请双击项目目录下的 启动.bat。</div>
    </div>
  </section>

  <section class="panel" data-panel="providers">
    <div class="card">
      <h2>从预置添加服务商</h2>
      <div class="form-row">
        <label>预置</label>
        <select id="preset-select">${presetOptions}</select>
      </div>
      <div class="form-row">
        <label>API Key</label>
        <input id="preset-key" type="password" placeholder="只保存到本机加密文件，页面不会回显" autocomplete="off" />
      </div>
      <button id="preset-add">添加这个服务商</button>
      <div class="note">密钥保存在工作区 <code>secrets.json</code>（AES-256-GCM 加密）。建议用服务商后台创建的、带消费上限的子密钥。</div>
    </div>

    <div class="card">
      <h2>自定义服务商</h2>
      <div class="form-row"><label>名称</label><input id="new-provider-name" placeholder="例如 我的百炼账号" /></div>
      <div class="form-row"><label>协议</label>
        <select id="new-provider-protocol">
          <option value="openai-images">OpenAI 图像生成</option>
          <option value="openai-compatible">OpenAI 兼容（文本）</option>
          <option value="dashscope-image">阿里百炼 图片</option>
          <option value="dashscope-video">阿里百炼 视频</option>
          <option value="zhipu-image">智谱 图片</option>
          <option value="zhipu-video">智谱 视频</option>
          <option value="minimax-video">MiniMax 视频</option>
        </select>
      </div>
      <div class="form-row"><label>Base URL</label><input id="new-provider-url" placeholder="https://..." /></div>
      <div class="form-row"><label>模型</label><input id="new-provider-models" placeholder="模型ID:能力,模型ID:能力（如 wan2.1-t2i-turbo:text2image）" /></div>
      <div class="form-row"><label>API Key</label><input id="new-provider-key" type="password" autocomplete="off" placeholder="可留空，之后再填" /></div>
      <button id="new-provider-add">创建服务商</button>
      <div class="note">能力可选：text（文本）、text2image（文生图）、image2image（图生图）、imageEdit（图片编辑）、text2video（文生视频）、image2video（图生视频）、firstLastFrame（首尾帧）。</div>
    </div>

    <div class="card">
      <h2>已配置的服务商</h2>
      <table><thead><tr><th>服务商</th><th>模型</th><th>能力</th><th>密钥</th><th>操作</th></tr></thead>
      <tbody>${providerRows}</tbody></table>
    </div>
  </section>

  <section class="panel" data-panel="projects">
    <div class="card">
      <h2>新建项目</h2>
      <div class="form-row"><label>名称</label><input id="new-project-name" placeholder="项目名称" /></div>
      <button id="new-project-add">新建项目</button>
    </div>
    <div class="card">
      <h2>项目列表</h2>
      <table><thead><tr><th>名称</th><th>素材数</th><th>占用</th><th>最后更新</th><th>操作</th></tr></thead>
      <tbody>${projectRows}</tbody></table>
      <div class="note">删除项目会连同里面的素材文件一起删除，操作不可恢复。</div>
    </div>
  </section>

  <section class="panel" data-panel="assets">
    <div class="card">
      <h2>素材（最多显示 200 个）</h2>
      ${groupRows ? `<div style="margin-bottom:10px">分组：${groupRows}</div>` : ''}
      <table><thead><tr><th>文件名</th><th>项目</th><th>类型</th><th>大小</th><th>导入时间</th><th>操作</th></tr></thead>
      <tbody>${assetRows}</tbody></table>
      <div class="note">删除素材会同时删掉工作区里的文件。素材的新增请在前端画布拖入或点「导入素材」。</div>
    </div>
  </section>

  <section class="panel" data-panel="tasks">
    <div class="card">
      <h2>云端生成任务</h2>
      <table><thead><tr><th>类型</th><th>状态</th><th>模型</th><th>进度</th><th>说明</th><th>时间</th><th>操作</th></tr></thead>
      <tbody>${taskRows}</tbody></table>
    </div>
    <div class="card">
      <h2>本地任务</h2>
      <table><thead><tr><th>类型</th><th>状态</th><th>说明</th><th>进度</th><th>时间</th><th>操作</th></tr></thead>
      <tbody>${jobRows}</tbody></table>
    </div>
  </section>
</div>

<dialog id="provider-dialog">
  <div class="dialog-body">
    <h3 id="provider-dialog-title">编辑服务商</h3>
    <input type="hidden" id="edit-id" />
    <div class="form-row"><label>名称</label><input id="edit-name" /></div>
    <div class="form-row"><label>Base URL</label><input id="edit-url" /></div>
    <div class="form-row"><label>模型</label><input id="edit-models" placeholder="模型ID:能力,模型ID:能力" /></div>
    <div class="form-row"><label>状态</label>
      <select id="edit-enabled"><option value="1">启用</option><option value="0">停用</option></select>
    </div>
    <div class="row" style="margin-top:14px">
      <button id="edit-save">保存</button>
      <button class="ghost" id="edit-cancel">取消</button>
    </div>
  </div>
</dialog>

<script>
  const DATA = ${payload};
  const api = async (path, options) => {
    const response = await fetch(path, options);
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
    if (!response.ok) throw new Error(payload.message || ('请求失败（' + response.status + '）'));
    return payload;
  };
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const done = (message) => { alert(message); location.reload(); };
  const fail = (error) => alert(error.message || String(error));

  document.querySelectorAll('.tabs button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((item) => item.classList.toggle('active', item === button));
      document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === button.dataset.tab));
    });
  });

  document.getElementById('stop').addEventListener('click', async () => {
    if (!confirm('确定关闭后端服务吗？正在跑的任务会被中断，刷新页面也不会恢复，需要重新双击 启动.bat。')) return;
    try {
      await fetch('/api/shutdown', { method: 'POST' });
      document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:sans-serif"><h1>后端已关闭</h1><p>可以关闭这个页面了。重新启动请双击项目目录下的 启动.bat。</p></div>';
    } catch (error) { fail(error); }
  });
  document.getElementById('refresh').addEventListener('click', () => location.reload());

  // ── 服务商 ──
  const modelInput = (models) => models.map((model) => model.id + ':' + (model.capabilities || []).join('+')).join(',');
  const parseModels = (text) => text.split(',').map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const [id, capabilities] = chunk.split(':');
    return { id: id.trim(), displayName: id.trim(), capabilities: (capabilities || 'text').split('+').map((item) => item.trim()).filter(Boolean) };
  });

  document.getElementById('preset-add').addEventListener('click', async (event) => {
    const presetId = document.getElementById('preset-select').value;
    const apiKey = document.getElementById('preset-key').value.trim();
    event.target.disabled = true;
    try {
      await api('/api/providers/from-preset', json('POST', { presetId, apiKey }));
      done('服务商已添加。');
    } catch (error) { fail(error); event.target.disabled = false; }
  });

  document.getElementById('new-provider-add').addEventListener('click', async (event) => {
    const body = {
      name: document.getElementById('new-provider-name').value.trim(),
      protocol: document.getElementById('new-provider-protocol').value,
      baseUrl: document.getElementById('new-provider-url').value.trim(),
      models: parseModels(document.getElementById('new-provider-models').value),
      apiKey: document.getElementById('new-provider-key').value.trim(),
      enabled: true,
    };
    event.target.disabled = true;
    try { await api('/api/providers', json('POST', body)); done('服务商已创建。'); }
    catch (error) { fail(error); event.target.disabled = false; }
  });

  document.querySelectorAll('[data-test-provider]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = '测试中…';
    try {
      const result = await api('/api/providers/' + encodeURIComponent(button.dataset.testProvider) + '/test', { method: 'POST' });
      done(result.message || '连接成功');
    } catch (error) { fail(error); button.disabled = false; button.textContent = '测试连接'; }
  }));

  document.querySelectorAll('[data-toggle-provider]').forEach((button) => button.addEventListener('click', async () => {
    try { await api('/api/providers/' + encodeURIComponent(button.dataset.toggleProvider), json('PATCH', { enabled: button.dataset.enabled !== '1' })); location.reload(); }
    catch (error) { fail(error); }
  }));

  document.querySelectorAll('[data-delete-provider]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('删除服务商「' + button.dataset.name + '」？它保存的密钥也会一起删掉。')) return;
    try { await api('/api/providers/' + encodeURIComponent(button.dataset.deleteProvider), { method: 'DELETE' }); location.reload(); }
    catch (error) { fail(error); }
  }));

  document.querySelectorAll('[data-key-provider]').forEach((button) => button.addEventListener('click', async () => {
    const value = prompt('为「' + button.dataset.name + '」输入 API Key（只会保存在本机加密文件里，页面不会回显）：');
    if (!value) return;
    try { await api('/api/providers/' + encodeURIComponent(button.dataset.keyProvider), json('PATCH', { apiKey: value })); done('密钥已保存。'); }
    catch (error) { fail(error); }
  }));

  const dialog = document.getElementById('provider-dialog');
  document.querySelectorAll('[data-edit-provider]').forEach((button) => button.addEventListener('click', () => {
    const provider = DATA.providers.find((item) => item.id === button.dataset.editProvider);
    if (!provider) return;
    document.getElementById('edit-id').value = provider.id;
    document.getElementById('edit-name').value = provider.name;
    document.getElementById('edit-url').value = provider.baseUrl;
    document.getElementById('edit-models').value = modelInput(provider.models);
    document.getElementById('edit-enabled').value = provider.enabled ? '1' : '0';
    dialog.showModal();
  }));
  document.getElementById('edit-cancel').addEventListener('click', () => dialog.close());
  document.getElementById('edit-save').addEventListener('click', async () => {
    const id = document.getElementById('edit-id').value;
    try {
      await api('/api/providers/' + encodeURIComponent(id), json('PATCH', {
        name: document.getElementById('edit-name').value.trim(),
        baseUrl: document.getElementById('edit-url').value.trim(),
        models: parseModels(document.getElementById('edit-models').value),
        enabled: document.getElementById('edit-enabled').value === '1',
      }));
      done('已保存。');
    } catch (error) { fail(error); }
  });

  // ── 项目 ──
  document.getElementById('new-project-add').addEventListener('click', async (event) => {
    const name = document.getElementById('new-project-name').value.trim();
    if (!name) return;
    event.target.disabled = true;
    try { await api('/api/projects', json('POST', { name })); done('项目已创建。'); }
    catch (error) { fail(error); event.target.disabled = false; }
  });
  document.querySelectorAll('[data-rename-project]').forEach((button) => button.addEventListener('click', async () => {
    const name = prompt('新的项目名称：', button.dataset.name);
    if (!name || name === button.dataset.name) return;
    try { await api('/api/projects/' + encodeURIComponent(button.dataset.renameProject), json('PATCH', { name })); location.reload(); }
    catch (error) { fail(error); }
  }));
  document.querySelectorAll('[data-delete-project]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('删除项目「' + button.dataset.name + '」？项目里的素材文件会一起删除，且不可恢复。')) return;
    try {
      const result = await api('/api/projects/' + encodeURIComponent(button.dataset.deleteProject), { method: 'DELETE' });
      done('已删除项目，清理了 ' + (result.deletedFiles ?? 0) + ' 个文件。');
    } catch (error) { fail(error); }
  }));

  // ── 素材 ──
  document.querySelectorAll('[data-rename-asset]').forEach((button) => button.addEventListener('click', async () => {
    const name = prompt('新的文件名：', button.dataset.name);
    if (!name || name === button.dataset.name) return;
    try { await api('/api/assets/' + encodeURIComponent(button.dataset.renameAsset), json('PATCH', { originalName: name })); location.reload(); }
    catch (error) { fail(error); }
  }));
  document.querySelectorAll('[data-delete-asset]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('删除素材「' + button.dataset.name + '」？工作区里的文件也会删掉。')) return;
    try { await api('/api/assets/' + encodeURIComponent(button.dataset.deleteAsset), { method: 'DELETE' }); location.reload(); }
    catch (error) { fail(error); }
  }));

  // ── 任务 ──
  document.querySelectorAll('[data-cancel-task]').forEach((button) => button.addEventListener('click', async () => {
    try { await api('/api/generation/' + encodeURIComponent(button.dataset.cancelTask) + '/cancel', { method: 'POST' }); location.reload(); }
    catch (error) { fail(error); }
  }));
  document.querySelectorAll('[data-delete-task]').forEach((button) => button.addEventListener('click', async () => {
    try { await api('/api/tasks/' + encodeURIComponent(button.dataset.deleteTask), { method: 'DELETE' }); location.reload(); }
    catch (error) { fail(error); }
  }));
  document.querySelectorAll('[data-delete-job]').forEach((button) => button.addEventListener('click', async () => {
    try { await api('/api/jobs/' + encodeURIComponent(button.dataset.deleteJob), { method: 'DELETE' }); location.reload(); }
    catch (error) { fail(error); }
  }));

  const running = ${snapshot.jobs.some((job) => job.status === 'running' || job.status === 'queued') || snapshot.tasks.some((task) => task.status === 'running' || task.status === 'queued')};
  if (running) setTimeout(() => location.reload(), 4000);
</script>
</body></html>`;
}
