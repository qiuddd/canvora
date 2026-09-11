/**
 * 本地 mock 服务商。
 *
 * 用途：在没有云端密钥的情况下，端到端验证「生成节点 → 适配器 → 下载落盘 → 入库 → 画布出图」这条链路。
 * 它实现了 OpenAI 兼容的 /v1/images/generations：
 *   - 返回 response_format 对应的 b64_json 或 url
 *   - 用 ffmpeg 现场合成一张图，所以产出的确实是真实图片文件，不是占位文本
 *
 * 用法：node scripts/mock-provider.mjs [端口]   （默认 18888）
 * 在 Canvora 里新增服务商，协议选「OpenAI 图像生成」，Base URL 填 http://127.0.0.1:18888 ，密钥随便填。
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const port = Number(process.argv[2] ?? 18888);

/** 按提示词生成一张可辨认的图：颜色跟着提示词走，打上尺寸和序号文字。 */
async function makeImage(prompt, size, index) {
  const dir = await mkdtemp(join(tmpdir(), 'canvora-mock-'));
  const file = join(dir, `out-${index}.png`);
  // 用十六进制颜色：hsl(...) 里的逗号会被 ffmpeg 当成滤镜分隔符
  let hash = 0;
  for (const char of `${prompt}#${index}`) hash = (hash * 31 + char.codePointAt(0)) % 0xffffff;
  const color = `0x${hash.toString(16).padStart(6, '0')}`;
  const label = prompt.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g, '').slice(0, 12) || 'MOCK';
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=${size}`,
    '-vf', `drawtext=text='${label} ${index + 1}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2-30,drawtext=text='${size}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2+30`,
    '-frames:v', '1', file,
  ], { windowsHide: true });
  const data = await readFile(file);
  await rm(dir, { recursive: true, force: true });
  return data;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const send = (status, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    return send(200, { object: 'list', data: [{ id: 'mock-image-1', object: 'model' }] });
  }

  if (req.method === 'POST' && url.pathname.endsWith('/images/generations')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { return send(400, { error: { message: 'body 不是合法 JSON' } }); }
    const prompt = String(body.prompt ?? '');
    const count = Math.max(1, Math.min(4, Number(body.n ?? 1)));
    const size = String(body.size ?? '1024x1024').replace('*', 'x');
    if (!prompt.trim()) return send(400, { error: { message: 'prompt 不能为空' } });

    try {
      const images = [];
      for (let index = 0; index < count; index += 1) images.push(await makeImage(prompt, size, index));
      if (body.response_format === 'url') {
        // 顺手验证「URL 分支」：把图挂在同一个服务的 /mock-file 下
        return send(200, { created: Math.floor(Date.now() / 1000), data: images.map((_, index) => ({ url: `http://127.0.0.1:${port}/mock-file/${index}?prompt=${encodeURIComponent(prompt)}&size=${size}` })) });
      }
      return send(200, { created: Math.floor(Date.now() / 1000), data: images.map((data) => ({ b64_json: data.toString('base64') })) });
    } catch (error) {
      return send(500, { error: { message: `mock 生成失败：${error instanceof Error ? error.message : String(error)}` } });
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/mock-file/')) {
    const index = Number(url.pathname.split('/').pop() ?? 0);
    const data = await makeImage(url.searchParams.get('prompt') ?? '', url.searchParams.get('size') ?? '1024x1024', index);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length });
    return res.end(data);
  }

  return send(404, { error: { message: `mock 服务商没有这个接口：${req.method} ${url.pathname}` } });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`本地 mock 服务商已启动：http://127.0.0.1:${port}`);
  console.log('在 Canvora 里新增服务商：协议选「OpenAI 图像生成」，Base URL 填这个地址，密钥随便填。');
});
