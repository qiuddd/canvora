import type { ChatMessage, ChatReply } from '@canvora/shared';
import { AppError } from './errors.js';
import { readSecret } from './secrets.js';

/** 内置的 DeepSeek 服务商标识，密钥存在工作区 secrets.json 里（加密）。 */
export const DEEPSEEK_PROVIDER_ID = 'deepseek';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

export async function resolveDeepSeekKey(workspaceRoot: string): Promise<string> {
  // 环境变量只是兜底，正常路径是从加密的 secrets.json 读。
  const stored = await readSecret(workspaceRoot, DEEPSEEK_PROVIDER_ID);
  const key = stored ?? process.env.DEEPSEEK_API_KEY;
  if (!key) throw new AppError('invalid-key', '还没有配置 DeepSeek 密钥，请先在设置里填写', undefined, 400);
  return key;
}

interface DeepSeekChoice { message?: { content?: string } }
interface DeepSeekResponse { model?: string; choices?: DeepSeekChoice[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }

/**
 * 调用 DeepSeek 的 OpenAI 兼容对话接口。
 * 密钥只在服务端使用，永远不会返回给前端。
 */
export async function chatCompletion(
  workspaceRoot: string,
  messages: ChatMessage[],
  options: { model?: string; temperature?: number; baseUrl?: string } = {},
): Promise<ChatReply> {
  if (messages.length === 0) throw new AppError('invalid-request', '对话内容不能为空', undefined, 400);
  const key = await resolveDeepSeekKey(workspaceRoot);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model ?? DEFAULT_MODEL,
        messages,
        temperature: options.temperature ?? 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError('timeout', reason.includes('timeout') ? 'DeepSeek 接口响应超时，请稍后重试' : '无法连接 DeepSeek 接口，请检查网络', reason, 504);
  }

  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401) throw new AppError('invalid-key', 'DeepSeek 密钥无效，请到服务商后台确认', text, 401);
    if (response.status === 402) throw new AppError('insufficient-balance', 'DeepSeek 账户余额不足，请先充值', text, 402);
    if (response.status === 429) throw new AppError('forbidden', '请求太频繁被限流，请稍后再试', text, 429);
    throw new AppError('provider', `DeepSeek 接口返回错误（${response.status}）`, text, response.status);
  }

  let payload: DeepSeekResponse;
  try { payload = JSON.parse(text) as DeepSeekResponse; } catch { throw new AppError('provider', 'DeepSeek 返回的内容无法解析', text); }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new AppError('provider', 'DeepSeek 没有返回内容', text);
  return {
    content,
    model: payload.model ?? options.model ?? DEFAULT_MODEL,
    usage: payload.usage ? { promptTokens: payload.usage.prompt_tokens ?? 0, completionTokens: payload.usage.completion_tokens ?? 0 } : undefined,
  };
}

/** 用最小请求验证密钥是否可用。 */
export async function testDeepSeekKey(workspaceRoot: string, apiKey?: string): Promise<{ ok: true; models: string[] }> {
  const key = apiKey ?? await resolveDeepSeekKey(workspaceRoot);
  let response: Response;
  try {
    response = await fetch(`${DEFAULT_BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new AppError('unreachable', '无法连接 DeepSeek 接口，请检查网络', error instanceof Error ? error.message : String(error), 502);
  }
  if (!response.ok) {
    if (response.status === 401) throw new AppError('invalid-key', 'DeepSeek 密钥无效', await response.text(), 401);
    throw new AppError('provider', `DeepSeek 接口返回错误（${response.status}）`, await response.text(), response.status);
  }
  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return { ok: true, models: (payload.data ?? []).map((item) => item.id ?? '').filter(Boolean) };
}
