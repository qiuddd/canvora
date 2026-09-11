import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Provider, ProviderModel } from '@canvora/shared';
import { AppError } from './errors.js';
import { readSecret } from './secrets.js';
import { assetAbsolutePath, assetById, ensureWorkspace, registerGeneratedAsset } from './workspace.js';
import { createTask, getTask, updateTask } from './tasks.js';

export interface GenerationInput { assetId?: string; dataUrl?: string; kind?: 'image' | 'video' | 'audio'; role?: string }
export interface GenerationRequest { root: string; projectId: string; providerId: string; model?: string; prompt: string; params?: Record<string, unknown>; inputs?: GenerationInput[]; nodeId?: string }
export interface GenerationContext { provider: Provider; key: string; request: GenerationRequest }
export interface GenerationResult { kind: 'image' | 'text' | 'video'; assetIds?: string[]; content?: string; taskId?: string; status?: string }

const json = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const getString = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;

const IMAGE_CAPABILITIES = ['text2image', 'image2image', 'imageEdit'];
const VIDEO_CAPABILITIES = ['text2video', 'image2video', 'firstLastFrame'];

/** 某个模型是否具备指定生成方向的能力。空能力列表表示没声明，按「不支持」处理。 */
export function modelSupportsKind(model: ProviderModel, kind: 'image' | 'video'): boolean {
  const wanted = kind === 'video' ? VIDEO_CAPABILITIES : IMAGE_CAPABILITIES;
  return model.capabilities.some((capability) => wanted.includes(capability));
}

const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

/**
 * 上游连进来的素材要转成服务商能收的 data URL。
 * 只允许当前项目内的素材，避免越权读取工作区其他文件。
 */
async function resolveInputUrls(request: GenerationRequest): Promise<string[]> {
  const urls = (request.inputs ?? []).map((item) => item.dataUrl).filter((item): item is string => Boolean(item));
  const assetIds = (request.inputs ?? []).map((item) => item.assetId).filter((item): item is string => Boolean(item));
  if (!assetIds.length) return urls;
  const state = await ensureWorkspace(request.root);
  for (const assetId of assetIds) {
    const asset = assetById(state, assetId);
    if (!asset) throw new AppError('invalid-request', '参考素材不存在，请重新选择', undefined, 400);
    if (asset.projectId !== request.projectId) throw new AppError('invalid-request', '参考素材不属于当前项目', undefined, 400);
    if (asset.kind !== 'image') throw new AppError('invalid-request', '参考图只能是图片素材', undefined, 400);
    const mime = MIME_BY_EXT[extname(asset.relPath).toLowerCase()] ?? 'image/jpeg';
    const bytes = await readFile(assetAbsolutePath(state, asset));
    urls.push(`data:${mime};base64,${bytes.toString('base64')}`);
  }
  return urls;
}

/** 生成节点只能选到有对应能力的服务商和模型，服务端再校验一次，避免前端绕过。 */
export function assertCapability(provider: Provider, modelId: string | undefined, kind: 'image' | 'video'): void {
  if (!provider.enabled) throw new AppError('invalid-request', '这个服务商已停用，请到后台启用或换一个', undefined, 400);
  const model = provider.models.find((item) => item.id === modelId);
  if (!model) throw new AppError('invalid-request', '找不到这个模型，请重新选择', undefined, 400);
  if (!modelSupportsKind(model, kind)) {
    throw new AppError('invalid-request', kind === 'video' ? '这个模型不支持生成视频，请换一个' : '这个模型不支持生成图片，请换一个', undefined, 400);
  }
}

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
  const urls = await resolveInputUrls(ctx.request);
  if (ctx.provider.protocol === 'openai-images' || ctx.provider.protocol === 'dashscope-image' || ctx.provider.protocol === 'zhipu-image') {
    return { payload: await call(ctx, '/images/generations', { model: ctx.request.model, prompt: ctx.request.prompt, ...json(ctx.request.params), ...(urls.length ? { images: urls } : {}) }) };
  }
  if (ctx.provider.protocol === 'openai-compatible') return { payload: await call(ctx, '/chat/completions', { model: ctx.request.model, messages: [{ role: 'user', content: ctx.request.prompt }], ...json(ctx.request.params) }) };
  const body = { model: ctx.request.model, prompt: ctx.request.prompt, ...json(ctx.request.params), ...(urls.length ? { input: urls } : {}) };
  const payload = await call(ctx, ctx.provider.protocol === 'zhipu-video' ? '/videos/generations' : '/services/aigc/video-generation/video-synthesis', body);
  return { taskId: getString(payload.task_id) ?? getString(payload.taskId) ?? getString(payload.id) };
}

export async function poll(ctx: GenerationContext, remoteTaskId: string): Promise<Record<string, unknown>> {
  const path = ctx.provider.protocol === 'zhipu-video' ? `/videos/generations/${encodeURIComponent(remoteTaskId)}` : `/tasks/${encodeURIComponent(remoteTaskId)}`;
  return call({ ...ctx, request: ctx.request }, path, undefined, 60_000, 'GET');
}

export async function execute(request: GenerationRequest, provider: Provider, expected: 'image' | 'video' | 'text'): Promise<GenerationResult> {
  const key = await readSecret(request.root, provider.id);
  if (!key) throw new AppError('invalid-key', '请先在设置里配置该服务商密钥', undefined, 400);
  const context = { provider, key, request };
  if (expected === 'text') {
    if (provider.protocol !== 'openai-compatible') throw new AppError('invalid-request', '这个服务商不支持文本生成', undefined, 400);
    const response = (await submit(context)).payload ?? {};
    const choice = json(Array.isArray(response.choices) ? response.choices[0] : undefined);
    const message = json(choice.message);
    const content = getString(message.content) ?? '';
    if (!content) throw new AppError('provider', '服务商没有返回文本内容');
    return { kind: 'text', content };
  }
  assertCapability(provider, request.model, expected);
  if (expected === 'image') {
    if (provider.protocol === 'openai-compatible') throw new AppError('invalid-request', '这个服务商不能生图，请选择支持生图的服务商', undefined, 400);
    const results = parseImageResults((await submit(context)).payload ?? {});
    if (!results.length) throw new AppError('provider', '服务商没有返回图片结果');
    return { kind: 'image', assetIds: await Promise.all(results.map((result) => downloadResult(request.root, request.projectId, result, 'image'))), status: 'succeeded' };
  }
  const submitted = await submit(context);
  if (!submitted.taskId) throw new AppError('provider', '服务商没有返回异步任务编号');
  const task = await createTask(request.root, { projectId: request.projectId, nodeId: request.nodeId, kind: 'video', engine: 'cloud', providerId: provider.id, modelId: request.model, params: request.params ?? {}, remoteTaskId: submitted.taskId });
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
