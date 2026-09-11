import Fastify, { type FastifyReply } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';
import type { ChatMessage, HealthResponse, JobKind } from '@canvora/shared';
import {
  assetAbsolutePath, assetById, assignAssetsToGroup, createGroup, createProject, deleteProject,
  deleteAsset, ensureWorkspace, importAsset, importAssetFromUpload, readCanvas, removeFileIfExists, removeGroup, renameProject, updateAssetMetadata, writeCanvas,
} from './workspace.js';
import { createProxy, createThumbnail, extractFrame, probeMedia } from './media/media.js';
import { publicError } from './errors.js';
import { createProvider, getProvider, listProviders, removeProvider, testProvider, updateProvider, listProviderPresets, presetById, type ProviderInput } from './providers.js';
import { cancelGeneration, execute } from './generation.js';
import { listSecrets, markSecretTest, removeSecret, upsertSecret } from './secrets.js';
import { createTask, deleteTask, getTask, listTasks, updateTask } from './tasks.js';
import { DEEPSEEK_PROVIDER_ID, chatCompletion, testDeepSeekKey } from './chat.js';
import { cancelJob, deleteJob, enqueueJob, getJob, listJobs, restoreJobs, toolStatus } from './jobs.js';
import { renderStatusPage } from './status-page.js';

const DEFAULT_ROOT = process.env.CANVORA_WORKSPACE ?? 'F:/Canvora';
const snapshotVersion = '0.0.2';
const STARTED_AT = Date.now();
const rootOf = (request: { query?: unknown; body?: unknown }): string => { const source = (request.query ?? request.body ?? {}) as { root?: string }; return source.root ?? DEFAULT_ROOT; };

const mimeFor = (ext: string, kind: string): string => {
  if (kind === 'video') return ext === '.webm' ? 'video/webm' : 'video/mp4';
  if (kind === 'audio') return 'audio/mpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
};

export const buildServer = () => {
  // 视频素材可能很大，走流式上传而不是整体读进内存（本机只有 16GB 内存）。
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 * 1024 });
  app.register(cors, { origin: true });

  app.addContentTypeParser('application/octet-stream', (request, payload, done) => {
    const tempPath = join(tmpdir(), `canvora-upload-${nanoid()}.bin`);
    const sink = createWriteStream(tempPath);
    let bytes = 0;
    payload.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    payload.once('error', (error: Error) => { sink.destroy(); done(error); });
    sink.once('error', (error) => done(error));
    sink.once('finish', () => done(null, { tempPath, bytes }));
    payload.pipe(sink);
  });

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, service: 'canvora-backend', version: snapshotVersion, timestamp: new Date().toISOString() }));

  // 后端管理页：服务状态 + 项目 / 素材 / 服务商 / 任务的增删改查
  app.get('/', async (request, reply) => {
    const root = rootOf(request);
    const state = await ensureWorkspace(root);
    const jobs = listJobs(root);
    const secrets = await listSecrets(root);
    const memory = process.memoryUsage();
    return reply.type('text/html; charset=utf-8').send(renderStatusPage({
      root,
      version: snapshotVersion,
      startedAt: STARTED_AT,
      now: Date.now(),
      projects: state.projects,
      assets: state.assets,
      groups: state.groups ?? [],
      providers: await listProviders(root),
      presets: listProviderPresets().map((preset) => ({ id: preset.id, name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl })),
      secrets: secrets.map((secret) => ({ providerId: secret.providerId, last4: secret.last4, testStatus: secret.testStatus })),
      tasks: await listTasks(root),
      tools: await toolStatus(root),
      jobs: jobs.slice(0, 30).map((job) => ({ id: job.id, kind: job.kind, status: job.status, statusText: job.statusText, progress: job.progress, startedAt: job.startedAt, finishedAt: job.finishedAt, resultAssetIds: job.resultAssetIds })),
      memory: { rssMb: memory.rss / 1024 / 1024, heapUsedMb: memory.heapUsed / 1024 / 1024 },
    }));
  });

  app.post('/api/shutdown', async (_request, reply) => {
    reply.send({ ok: true, message: '后端正在关闭' });
    // 先把响应发出去，再退出，否则前端拿不到确认
    setTimeout(() => {
      console.log('收到关闭请求，Canvora 后端即将退出');
      process.exit(0);
    }, 300);
    return reply;
  });

  app.get('/api/workspace', async (request) => ensureWorkspace(rootOf(request)));

  app.get('/api/tools', async (request) => toolStatus(rootOf(request)));

  // ── 项目 ─────────────────────────────────────────────
  app.post('/api/projects', async (request, reply) => {
    try { return await createProject(rootOf(request), (request.body as { name?: string } | undefined)?.name ?? '新项目'); }
    catch (error) { return reply.status(400).send(publicError(error)); }
  });
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = await renameProject(rootOf(request), request.params.id, (request.body as { name?: string })?.name ?? '');
    return project ?? reply.status(404).send({ message: '项目不存在' });
  });
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const result = await deleteProject(rootOf(request), request.params.id);
    return result.project ? { ok: true, deletedFiles: result.fileCount, deletedBytes: result.totalBytes } : reply.status(404).send({ message: '项目不存在' });
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/canvas', async (request) => readCanvas(await ensureWorkspace(rootOf(request)), request.params.id));
  app.put<{ Params: { id: string } }>('/api/projects/:id/canvas', async (request) => {
    const body = request.body as { nodes?: unknown[]; edges?: unknown[] } | undefined;
    const snapshot = { nodes: (body?.nodes ?? []) as never[], edges: (body?.edges ?? []) as never[] };
    await writeCanvas(rootOf(request), request.params.id, snapshot);
    return { ok: true, nodes: snapshot.nodes.length, edges: snapshot.edges.length };
  });

  // ── 素材 ─────────────────────────────────────────────
  app.get('/api/assets', async (request) => { const state = await ensureWorkspace(rootOf(request)); return { root: state.root, assets: state.assets }; });

  app.get<{ Params: { id: string } }>('/api/assets/:id/file', async (request, reply) => {
    const state = await ensureWorkspace(rootOf(request));
    const asset = assetById(state, request.params.id);
    if (!asset) return reply.status(404).send({ message: '素材不存在或已被删除' });
    return reply.type(mimeFor(asset.ext, asset.kind)).send(createReadStream(assetAbsolutePath(state, asset)));
  });

  app.get<{ Params: { id: string } }>('/api/assets/:id/thumb', async (request, reply) => {
    const state = await ensureWorkspace(rootOf(request));
    const asset = assetById(state, request.params.id);
    if (!asset) return reply.status(404).send({ message: '素材不存在或已被删除' });
    if (asset.kind !== 'video') return reply.redirect(`/api/assets/${asset.id}/file?root=${encodeURIComponent(state.root)}`);
    const thumbPath = join(state.root, 'cache', 'thumbs', `${asset.id}.jpg`);
    const result = await createThumbnail(assetAbsolutePath(state, asset), thumbPath, 1);
    if (result.exitCode !== 0) return reply.status(500).send({ message: '缩略图生成失败', detail: result.stderr });
    return reply.type('image/jpeg').send(createReadStream(thumbPath));
  });

  app.post('/api/assets/import', async (request, reply) => {
    const body = request.body as { root: string; projectId?: string; sourcePath: string };
    try {
      const state = await ensureWorkspace(body.root ?? DEFAULT_ROOT);
      const projectId = body.projectId ?? state.projects[0]?.id;
      if (!projectId) return reply.status(400).send({ message: '请先新建一个项目' });
      return await importAsset(state.root, projectId, body.sourcePath);
    } catch (error) { return reply.status(400).send(publicError(error)); }
  });

  app.post('/api/assets/upload', async (request, reply) => {
    const query = request.query as { root?: string; projectId?: string; filename?: string };
    const upload = request.body as { tempPath?: string; bytes?: number } | undefined;
    if (!upload?.tempPath) return reply.status(400).send({ message: '没有收到文件内容，请重新选择文件' });
    if (!upload.bytes) { await removeFileIfExists(upload.tempPath); return reply.status(400).send({ message: '文件是空的，请换一个文件' }); }
    try {
      const state = await ensureWorkspace(query.root ?? DEFAULT_ROOT);
      const projectId = query.projectId ?? state.projects[0]?.id;
      if (!projectId) return reply.status(400).send({ message: '请先新建一个项目，再导入素材' });
      return await importAssetFromUpload(state.root, projectId, query.filename ?? '素材', upload.tempPath);
    } catch (error) {
      return reply.status(400).send(publicError(error));
    } finally {
      await removeFileIfExists(upload.tempPath);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/assets/:id', async (request, reply) => {
    const removed = await deleteAsset(rootOf(request), request.params.id);
    return removed ? { ok: true } : reply.status(404).send({ message: '素材不存在' });
  });

  // ── 素材分组 ─────────────────────────────────────────
  app.post('/api/groups', async (request, reply) => {
    const body = request.body as { projectId: string; name: string; assetIds?: string[] };
    if (!body?.projectId) return reply.status(400).send({ message: '缺少项目信息' });
    try { return await createGroup(rootOf(request), body.projectId, body.name, body.assetIds ?? []); }
    catch (error) { return reply.status(400).send(publicError(error)); }
  });
  app.patch<{ Params: { id: string } }>('/api/groups/:id/assets', async (request) => {
    const body = request.body as { assetIds?: string[]; groupId?: string | null };
    await assignAssetsToGroup(rootOf(request), body.groupId ?? request.params.id, body.assetIds ?? []);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/groups/:id', async (request) => {
    await removeGroup(rootOf(request), request.params.id);
    return { ok: true };
  });

  // ── 本地批量任务 ─────────────────────────────────────
  app.get('/api/jobs', async (request) => listJobs(rootOf(request)));
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => getJob(rootOf(request), request.params.id) ?? reply.status(404).send({ message: '任务不存在' }));
  app.post('/api/jobs', async (request, reply) => {
    const body = request.body as { projectId?: string; kind?: JobKind; assetIds?: string[]; options?: Record<string, unknown> };
    if (!body?.kind) return reply.status(400).send({ message: '缺少任务类型' });
    // 导出成片不需要素材 id：它的输入是整条 EDL
    if (body.kind !== 'exportTimeline' && !body.assetIds?.length) return reply.status(400).send({ message: '请先选择要处理的素材' });
    const state = await ensureWorkspace(rootOf(request));
    const projectId = body.projectId ?? state.projects[0]?.id;
    if (!projectId) return reply.status(400).send({ message: '请先新建一个项目' });
    try { return enqueueJob(state.root, { projectId, kind: body.kind, assetIds: body.assetIds ?? [], options: body.options }); }
    catch (error) { return reply.status(400).send(publicError(error)); }
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request) => ({ ok: await cancelJob(rootOf(request), request.params.id) }));

  // ── DeepSeek 对话 ────────────────────────────────────
  app.post('/api/chat', async (request, reply) => {
    const body = request.body as { messages?: ChatMessage[]; model?: string; temperature?: number };
    try { return await chatCompletion(rootOf(request), body?.messages ?? [], { model: body?.model, temperature: body?.temperature }); }
    catch (error) { return reply.status((error as { statusCode?: number }).statusCode ?? 502).send(publicError(error)); }
  });

  app.get('/api/chat/status', async (request) => {
    const root = rootOf(request);
    const secrets = await listSecrets(root);
    const record = secrets.find((item) => item.providerId === DEEPSEEK_PROVIDER_ID);
    return { configured: Boolean(record), last4: record?.last4 ?? null, testStatus: record?.testStatus ?? null, defaultModel: 'deepseek-flash' };
  });

  app.put('/api/chat/key', async (request, reply) => {
    const body = request.body as { value?: string };
    try {
      const summary = await upsertSecret(rootOf(request), DEEPSEEK_PROVIDER_ID, body?.value ?? '');
      return { ok: true, last4: summary.last4 };
    } catch (error) { return reply.status(400).send(publicError(error)); }
  });

  app.post('/api/chat/test', async (request, reply) => {
    const root = rootOf(request);
    const body = request.body as { apiKey?: string } | undefined;
    try {
      const result = await testDeepSeekKey(root, body?.apiKey);
      if (!body?.apiKey) await markSecretTest(root, DEEPSEEK_PROVIDER_ID, true);
      return result;
    } catch (error) {
      if (!body?.apiKey) await markSecretTest(root, DEEPSEEK_PROVIDER_ID, false);
      return reply.status((error as { statusCode?: number }).statusCode ?? 502).send(publicError(error));
    }
  });

  // ── 媒体工具 ─────────────────────────────────────────
  app.post('/api/media/probe', async (request, reply) => { try { const body = request.body as { inputPath: string; ffprobe?: string }; return await probeMedia(body.inputPath, body.ffprobe); } catch (error) { return reply.status(400).send(publicError(error, '媒体信息读取失败')); } });
  app.post('/api/media/proxy', async (request, reply) => { try { const body = request.body as { inputPath: string; outputPath: string; ffmpeg?: string }; const result = await createProxy(body.inputPath, body.outputPath, body.ffmpeg); if (result.exitCode !== 0) return reply.status(400).send({ message: '代理文件生成失败', detail: result.stderr }); return { ok: true }; } catch (error) { return reply.status(400).send(publicError(error, '代理文件生成失败')); } });
  app.post('/api/media/frame', async (request, reply) => { try { const body = request.body as { inputPath: string; outputPath: string; atSeconds: number; ffmpeg?: string }; const result = await extractFrame(body.inputPath, body.outputPath, body.atSeconds, body.ffmpeg); if (result.exitCode !== 0) return reply.status(400).send({ message: '抽帧失败', detail: result.stderr }); return { ok: true }; } catch (error) { return reply.status(400).send(publicError(error, '抽帧失败')); } });

  // ── AI 生成 ───────────────────────────────────────────
  const runGeneration = async (request: { body?: unknown }, reply: FastifyReply, expected: 'image' | 'video' | 'text', fallback: string) => {
    const body = (request.body ?? {}) as import('./generation.js').GenerationRequest;
    try {
      const root = body.root ?? DEFAULT_ROOT;
      const provider = await getProvider(root, body.providerId);
      if (!provider) return reply.status(404).send({ message: '服务商不存在，请到后端管理页重新配置' });
      if (!body.projectId) return reply.status(400).send({ message: '缺少项目信息，请先打开一个项目' });
      return await execute({ ...body, root }, provider, expected);
    } catch (error) { return reply.status((error as { statusCode?: number }).statusCode ?? 502).send(publicError(error, fallback)); }
  };
  app.post('/api/generation/image', async (request, reply) => runGeneration(request, reply, 'image', '图片生成失败'));
  app.post('/api/generation/text', async (request, reply) => runGeneration(request, reply, 'text', '文本生成失败'));
  app.post('/api/generation/video', async (request, reply) => runGeneration(request, reply, 'video', '视频生成失败'));
  app.post<{ Params: { id: string } }>('/api/generation/:id/cancel', async (request) => ({ ok: await cancelGeneration(rootOf(request), request.params.id) }));

  // ── 服务商与旧任务接口（保留兼容）────────────────────
  app.get('/api/providers/presets', async () => listProviderPresets());
  app.post('/api/providers/from-preset', async (request, reply) => {
    const body = request.body as { presetId?: string; apiKey?: string };
    const preset = presetById(body?.presetId ?? '');
    if (!preset) return reply.status(404).send({ message: '找不到这个服务商预置' });
    try { return await createProvider(rootOf(request), { ...preset, enabled: true, apiKey: body.apiKey, isPreset: true }); }
    catch (error) { return reply.status(400).send(publicError(error)); }
  });
  app.post('/api/providers', async (request, reply) => { try { return await createProvider(rootOf(request), request.body as ProviderInput); } catch (error) { return reply.status(400).send(publicError(error)); } });
  app.get('/api/providers', async (request) => listProviders(rootOf(request)));
  app.patch<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) => (await updateProvider(rootOf(request), request.params.id, request.body as Partial<ProviderInput>)) ?? reply.status(404).send({ message: '服务商不存在' }));
  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request, reply) => { const removed = await removeProvider(rootOf(request), request.params.id); return removed ? { ok: true } : reply.status(404).send({ message: '服务商不存在' }); });
  app.post<{ Params: { id: string } }>('/api/providers/:id/test', async (request, reply) => { const provider = await getProvider(rootOf(request), request.params.id); if (!provider) return reply.status(404).send({ message: '服务商不存在' }); try { return await testProvider(rootOf(request), provider, (request.body as { apiKey?: string } | undefined)?.apiKey); } catch (error) { return reply.status((error as { statusCode?: number }).statusCode ?? 502).send(publicError(error)); } });
  app.get('/api/secrets', async (request) => listSecrets(rootOf(request)));
  app.put<{ Params: { id: string } }>('/api/secrets/:id', async (request) => { const body = request.body as { providerId: string; value: string }; return upsertSecret(rootOf(request), body.providerId, body.value, request.params.id); });
  app.delete<{ Params: { id: string } }>('/api/secrets/:id', async (request) => { await removeSecret(rootOf(request), request.params.id); return { ok: true }; });
  app.get('/api/tasks', async (request) => listTasks(rootOf(request)));
  app.post('/api/tasks', async (request) => createTask(rootOf(request), request.body as Parameters<typeof createTask>[1]));
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => (await getTask(rootOf(request), request.params.id)) ?? reply.status(404).send({ message: '任务不存在' }));
  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => (await updateTask(rootOf(request), request.params.id, request.body as Parameters<typeof updateTask>[2])) ?? reply.status(404).send({ message: '任务不存在' }));
  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const id = request.params.id;
    const task = await getTask(rootOf(request), id);
    if (!task) return reply.status(404).send({ message: '任务不存在' });
    if (task.status === 'queued' || task.status === 'running') return reply.status(400).send({ message: '任务还在执行，先取消再删除' });
    return { ok: await deleteTask(rootOf(request), id) };
  });
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request, reply) => {
    const removed = await deleteJob(rootOf(request), request.params.id);
    return removed ? { ok: true } : reply.status(400).send({ message: '任务不存在，或还在执行中' });
  });
  app.patch<{ Params: { id: string } }>('/api/assets/:id', async (request, reply) => {
    const body = request.body as { originalName?: string; tags?: string[]; favorite?: boolean };
    const asset = await updateAssetMetadata(rootOf(request), request.params.id, body);
    return asset ?? reply.status(404).send({ message: '素材不存在' });
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ message: status === 413 ? '文件太大，超出了单次上传上限' : '服务器发生错误，请查看日志后重试', detail: error instanceof Error ? error.message : String(error) });
  });
  return app;
};

const port = Number(process.env.CANVORA_PORT ?? 8787);
const app = buildServer();
app.listen({ port, host: '127.0.0.1' })
  .then(async () => {
    await restoreJobs(DEFAULT_ROOT).catch(() => undefined);
    console.log(`Canvora 后端已启动：http://127.0.0.1:${port}`);
  })
  .catch((error) => { console.error(error); process.exit(1); });
