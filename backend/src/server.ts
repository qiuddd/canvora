import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { HealthResponse } from '@canvora/shared';
import { ensureWorkspace, importAsset } from './workspace.js';
import { createProxy, createThumbnail, extractFrame, probeMedia } from './media/media.js';
import { publicError } from './errors.js';
import { createProvider, getProvider, listProviders, removeProvider, testProvider, updateProvider, type ProviderInput } from './providers.js';
import { listSecrets, removeSecret, upsertSecret } from './secrets.js';
import { createTask, getTask, listTasks, updateTask } from './tasks.js';

const rootOf = (request: { query?: unknown; body?: unknown }): string => { const source = (request.query ?? request.body ?? {}) as { root?: string }; return source.root ?? process.env.CANVORA_WORKSPACE ?? 'F:/Canvora'; };

export const buildServer = () => {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });
  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, service: 'canvora-backend', version: '0.1.0', timestamp: new Date().toISOString() }));
  app.get('/api/workspace', async (request, reply) => { const root = String((request.query as { root?: string }).root ?? process.env.CANVORA_WORKSPACE ?? 'F:/Canvora'); return ensureWorkspace(root); });
  app.post('/api/assets/import', async (request, reply) => { const body = request.body as { root: string; projectId: string; sourcePath: string }; try { return await importAsset(await ensureWorkspace(body.root), body.projectId, body.sourcePath); } catch (error) { return reply.status(400).send({ message: error instanceof Error ? error.message : '素材导入失败', detail: String(error) }); } });
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
  app.setErrorHandler((error, _request, reply) => reply.status(500).send({ message: '服务器发生错误，请查看日志后重试', detail: error instanceof Error ? error.message : String(error) }));
  return app;
};

const port = Number(process.env.CANVORA_PORT ?? 8787);
const app = buildServer();
app.listen({ port, host: '127.0.0.1' }).then(() => console.log(`Canvora 后端已启动：http://127.0.0.1:${port}`)).catch((error) => { console.error(error); process.exit(1); });
