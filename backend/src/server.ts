import Fastify from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cors from '@fastify/cors';
import { nanoid } from 'nanoid';
import type { HealthResponse } from '@canvora/shared';
import { assetAbsolutePath, defaultProjectId, ensureWorkspace, importAsset, importAssetFromUpload, removeFileIfExists } from './workspace.js';
import { createProxy, createThumbnail, extractFrame, probeMedia } from './media/media.js';
import { publicError } from './errors.js';
import { createProvider, getProvider, listProviders, removeProvider, testProvider, updateProvider, type ProviderInput } from './providers.js';
import { listSecrets, removeSecret, upsertSecret } from './secrets.js';
import { createTask, getTask, listTasks, updateTask } from './tasks.js';

const DEFAULT_ROOT = process.env.CANVORA_WORKSPACE ?? 'F:/Canvora';
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

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, service: 'canvora-backend', version: '0.1.0', timestamp: new Date().toISOString() }));

  app.get('/api/workspace', async (request) => ensureWorkspace(rootOf(request)));

  app.get('/api/assets', async (request) => { const state = await ensureWorkspace(rootOf(request)); return { root: state.root, assets: state.assets }; });

  app.get<{ Params: { id: string } }>('/api/assets/:id/file', async (request, reply) => {
    const state = await ensureWorkspace(rootOf(request));
    const asset = state.assets.find((item) => item.id === request.params.id);
    if (!asset) return reply.status(404).send({ message: '素材不存在或已被删除' });
    return reply.type(mimeFor(asset.ext, asset.kind)).send(createReadStream(assetAbsolutePath(state, asset)));
  });

  app.get<{ Params: { id: string } }>('/api/assets/:id/thumb', async (request, reply) => {
    const state = await ensureWorkspace(rootOf(request));
    const asset = state.assets.find((item) => item.id === request.params.id);
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
      return await importAsset(state, body.projectId ?? defaultProjectId(state), body.sourcePath);
    } catch (error) { return reply.status(400).send({ message: error instanceof Error ? error.message : '素材导入失败', detail: String(error) }); }
  });

  app.post('/api/assets/upload', async (request, reply) => {
    const query = request.query as { root?: string; projectId?: string; filename?: string };
    const upload = request.body as { tempPath?: string; bytes?: number } | undefined;
    if (!upload?.tempPath) return reply.status(400).send({ message: '没有收到文件内容，请重新选择文件' });
    if (!upload.bytes) { await removeFileIfExists(upload.tempPath); return reply.status(400).send({ message: '文件是空的，请换一个文件' }); }
    try {
      const state = await ensureWorkspace(query.root ?? DEFAULT_ROOT);
      return await importAssetFromUpload(state, query.projectId ?? defaultProjectId(state), query.filename ?? '素材', upload.tempPath);
    } catch (error) {
      return reply.status(400).send({ message: error instanceof Error ? error.message : '素材导入失败', detail: String(error) });
    } finally {
      await removeFileIfExists(upload.tempPath);
    }
  });

  app.post('/api/media/probe', async (request, reply) => { try { const body = request.body as { inputPath: string; ffprobe?: string }; return await probeMedia(body.inputPath, body.ffprobe); } catch (error) { return reply.status(400).send({ message: '媒体信息读取失败', detail: String(error) }); } });
  app.post('/api/media/proxy', async (request, reply) => { try { const body = request.body as { inputPath: string; outputPath: string; ffmpeg?: string }; const result = await createProxy(body.inputPath, body.outputPath, body.ffmpeg); if (result.exitCode !== 0) return reply.status(400).send({ message: '代理文件生成失败', detail: result.stderr }); return { ok: true }; } catch (error) { return reply.status(400).send({ message: '代理文件生成失败', detail: String(error) }); } });
  app.post('/api/media/frame', async (request, reply) => { try { const body = request.body as { inputPath: string; outputPath: string; atSeconds: number; ffmpeg?: string }; const result = await extractFrame(body.inputPath, body.outputPath, body.atSeconds, body.ffmpeg); if (result.exitCode !== 0) return reply.status(400).send({ message: '抽帧失败', detail: result.stderr }); return { ok: true }; } catch (error) { return reply.status(400).send({ message: '抽帧失败', detail: String(error) }); } });

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

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ message: status === 413 ? '文件太大，超出了单次上传上限' : '服务器发生错误，请查看日志后重试', detail: error instanceof Error ? error.message : String(error) });
  });
  return app;
};

const port = Number(process.env.CANVORA_PORT ?? 8787);
const app = buildServer();
app.listen({ port, host: '127.0.0.1' }).then(() => console.log(`Canvora 后端已启动：http://127.0.0.1:${port}`)).catch((error) => { console.error(error); process.exit(1); });
