import { mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Provider, ProviderModel } from '@canvora/shared';
import { AppError } from './errors.js';
import { readSecret } from './secrets.js';
import { ensureWorkspace, registerGeneratedAsset } from './workspace.js';
import { createTask, getTask, updateTask } from './tasks.js';

export interface GenerationRequest { root: string; projectId: string; providerId: string; model?: string; prompt: string; params?: Record<string, unknown>; inputs?: Array<{ dataUrl?: string; assetId?: string }> }
export interface GenerationContext { provider: Provider; key: string; request: GenerationRequest }
export interface GenerationResult { kind: 'image' | 'text' | 'video'; assetIds?: string[]; content?: string; taskId?: string; status?: string }

const json = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const getString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

async function call(ctx: GenerationContext, path: string, body: unknown, timeout = 180_000, method: 'GET' | 'POST' = 'POST', extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${ctx.provider.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { Authorization: `Bearer ${ctx.key}`, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) { throw new AppError('unreachable', '无法连接服务商接口，请检查网络和服务商地址', error instanceof Error ? error.message : String(error), 502); }
  const text = await response.text();
  if (!response.ok) throw new AppError(response.status === 401 ? 'invalid-key' : 'provider', response.status === 401 ? '服务商密钥无效' : `服务商接口返回错误（${response.status}）`, text, response.status);
  try { return json(JSON.parse(text)); } catch { throw new AppError('provider', '服务商返回内容无法解析', text); }
}

function inputUrls(request: GenerationRequest): string[] { return (request.inputs ?? []).map((item) => item.dataUrl).filter((item): item is string => Boolean(item)); }
function imagePayload(request: GenerationRequest): Record<string, unknown> { return { model: request.model, prompt: request.prompt, ...json(request.params), ...(inputUrls(request).length ? { images: inputUrls(request) } : {}) }; }

export function parseImageResults(payload: Record<string, unknown>): Array<{ url?: string; base64?: string; mime?: string }> {
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.map((item) => { const row = json(item); return { url: getString(row.url), base64: getString(row.b64_json) ?? getString(row.base64), mime: getString(row.mime_type) }; }).filter((item) => item.url || item.base64);
}

async function downloadResult(root: string, projectId: string, result: { url?: string; base64?: string; mime?: string }, kind: 'image' | 'video'): Promise<string> {
  const state = await ensureWorkspace(root);
  const ext = kind === 'video' ? '.mp4' : result.mime?.includes('png') ? '.png' : '.jpg';
  const assetDir = join(state.root, 'projects', projectId, 'assets');
  const target = join(assetDir, `${nanoid()}${ext}`);
  await mkdir(assetDir, { recursive: true });
  if (result.base64) await writeFile(target, Buffer.from(result.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'));
  else {
    if (!result.url || !/^https?:\/\//i.test(result.url)) throw new AppError('provider', '服务商返回了不安全的结果地址');
    let response: Response;
    try {
      response = await fetch(result.url, { signal: AbortSignal.timeout(180_000) });
    } catch (error) { throw new AppError('unreachable', '下载生成结果失败，请稍后重试', error instanceof Error ? error.message : String(error), 502); }
    if (!response.ok) throw new AppError('provider', '下载生成结果失败', `${response.status} ${result.url}`, response.status);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > 2 * 1024 * 1024 * 1024) throw new AppError('provider', '生成结果超过 2 GB，已拒绝写入');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new AppError('provider', '服务商返回的结果文件为空');
    await writeFile(target, bytes);
  }
  const statResult = await stat(target);
  if (!statResult.size) throw new AppError('provider', '服务商返回的结果文件为空');
  const asset = await registerGeneratedAsset(root, projectId, target, kind === 'video' ? 'AI 生成视频.mp4' : `AI 生成图片${ext}`, kind === 'video' ? 'exported' : 'exportedFrame');
  return asset.id;
}

export async function submit(ctx: GenerationContext): Promise<{ taskId?: string; payload?: Record<string, unknown> }> {
  if (ctx.provider.protocol === 'openai-images' || ctx.provider.protocol === 'dashscope-image' || ctx.provider.protocol === 'zhipu-image') return { payload: await call(ctx, ctx.provider.protocol === 'openai-images' ? '/images/generations' : '/images/generations', imagePayload(ctx.request)) };
  if (ctx.provider.protocol === 'openai-compatible') return { payload: await call(ctx, '/chat/completions', { model: ctx.request.model, messages: [{ role: 'user', content: ctx.request.prompt }], ...json(ctx.request.params) }) };
  const body = { model: ctx.request.model, prompt: ctx.request.prompt, ...json(ctx.request.params), ...(inputUrls(ctx.request).length ? { input: inputUrls(ctx.request) } : {}) };
  const payload = await call(ctx, ctx.provider.protocol === 'zhipu-video' ? '/videos/generations' : '/services/aigc/video-generation/video-synthesis', body);
  return { taskId: getString(payload.task_id) ?? getString(payload.taskId) ?? getString(payload.id) };
}

export async function poll(ctx: GenerationContext, remoteTaskId: string): Promise<Record<string, unknown>> {
  const path = ctx.provider.protocol === 'zhipu-video' ? `/videos/generations/${encodeURIComponent(remoteTaskId)}` : `/tasks/${encodeURIComponent(remoteTaskId)}`;
  return call({ ...ctx, request: ctx.request }, path, undefined, 60_000, 'GET');
}

export async function execute(request: GenerationRequest, provider: Provider): Promise<GenerationResult> {
  const key = await readSecret(request.root, provider.id);
  if (!key) throw new AppError('invalid-key', '请先在设置里配置该服务商密钥', undefined, 400);
  const context = { provider, key, request };
  if (provider.protocol === 'openai-compatible') {
    const response = (await submit(context)).payload ?? {};
    const choice = json(Array.isArray(response.choices) ? response.choices[0] : undefined);
    const message = json(choice.message);
    const content = getString(message.content) ?? '';
    if (!content) throw new AppError('provider', '服务商没有返回文本内容');
    return { kind: 'text', content };
  }
  if (provider.protocol === 'openai-images' || provider.protocol === 'dashscope-image' || provider.protocol === 'zhipu-image') {
    const results = parseImageResults((await submit(context)).payload ?? {});
    if (!results.length) throw new AppError('provider', '服务商没有返回图片结果');
    return { kind: 'image', assetIds: await Promise.all(results.map((result) => downloadResult(request.root, request.projectId, result, 'image'))), status: 'succeeded' };
  }
  const submitted = await submit(context);
  if (!submitted.taskId) throw new AppError('provider', '服务商没有返回异步任务编号');
  const task = await createTask(request.root, { projectId: request.projectId, kind: 'video', engine: 'cloud', providerId: provider.id, modelId: request.model, params: request.params ?? {}, remoteTaskId: submitted.taskId });
  void runVideoTask(context, task.id, submitted.taskId);
  return { kind: 'video', taskId: task.id, status: 'queued' };
}

async function runVideoTask(context: GenerationContext, taskId: string, remoteTaskId: string): Promise<void> {
  await updateTask(context.request.root, taskId, { status: 'running', statusText: '正在生成视频', startedAt: Date.now(), progress: 10 });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const payload = await poll(context, remoteTaskId);
      const status = (getString(payload.status) ?? getString(payload.task_status) ?? '').toLowerCase();
      const result = json(payload.video_result ?? payload.output ?? payload.result);
      const url = getString(result.url) ?? getString(payload.video_url) ?? getString(payload.url);
      if (url || ['succeeded', 'success', 'completed'].includes(status)) {
        if (!url) throw new AppError('provider', '视频任务完成但没有返回下载地址');
        const assetId = await downloadResult(context.request.root, context.request.projectId, { url, mime: 'video/mp4' }, 'video');
        await updateTask(context.request.root, taskId, { status: 'succeeded', statusText: '视频已生成', progress: 100, resultAssetIds: [assetId], finishedAt: Date.now() });
        return;
      }
      if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) throw new AppError('provider', '视频生成失败', JSON.stringify(payload));
      await updateTask(context.request.root, taskId, { progress: Math.min(95, 10 + attempt), statusText: '服务商正在生成视频' });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    throw new AppError('timeout', '视频生成等待超时，请到任务中心查看');
  } catch (error) { await updateTask(context.request.root, taskId, { status: 'failed', statusText: '生成失败', errorMessage: error instanceof AppError ? error.message : '视频生成失败', errorDetail: error instanceof Error ? error.message : String(error), finishedAt: Date.now() }); }
}

export async function cancelGeneration(root: string, id: string): Promise<boolean> { const task = await getTask(root, id); if (!task || !['queued', 'running'].includes(task.status)) return false; await updateTask(root, id, { status: 'cancelled', statusText: '已取消', finishedAt: Date.now() }); return true; }
