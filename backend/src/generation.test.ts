import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Provider, ProviderModel } from '@canvora/shared';
import { assertCapability, modelSupportsKind, parseImageResults } from './generation.js';

const model = (id: string, capabilities: ProviderModel['capabilities']): ProviderModel => ({ id, displayName: id, capabilities });
const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'p1', name: '测试服务商', protocol: 'openai-images', baseUrl: 'https://example.com', apiKeyRef: '',
  enabled: true, models: [], isPreset: false, createdAt: 0, ...overrides,
});

test('modelSupportsKind：图片能力不能当视频能力用', () => {
  assert.equal(modelSupportsKind(model('wan-t2i', ['text2image']), 'image'), true);
  assert.equal(modelSupportsKind(model('wan-t2i', ['text2image']), 'video'), false);
  assert.equal(modelSupportsKind(model('wan-t2v', ['text2video']), 'video'), true);
  assert.equal(modelSupportsKind(model('wan-t2v', ['text2video']), 'image'), false);
  assert.equal(modelSupportsKind(model('wan-first-last', ['firstLastFrame']), 'video'), true);
  assert.equal(modelSupportsKind(model('plain', ['text']), 'image'), false);
  assert.equal(modelSupportsKind(model('empty', []), 'image'), false);
});

test('assertCapability：停用的服务商不能生成', () => {
  const disabled = provider({ enabled: false, models: [model('m', ['text2image'])] });
  assert.throws(() => assertCapability(disabled, 'm', 'image'), /已停用/);
});

test('assertCapability：模型不存在或能力不匹配都用中文拒绝', () => {
  const p = provider({ models: [model('img', ['text2image']), model('vid', ['text2video'])] });
  assert.throws(() => assertCapability(p, 'missing', 'image'), /找不到这个模型/);
  assert.throws(() => assertCapability(p, 'img', 'video'), /不支持生成视频/);
  assert.throws(() => assertCapability(p, 'vid', 'image'), /不支持生成图片/);
  assert.doesNotThrow(() => assertCapability(p, 'img', 'image'));
  assert.doesNotThrow(() => assertCapability(p, 'vid', 'video'));
});

test('parseImageResults：url、b64_json、base64 三种返回都能认出', () => {
  const results = parseImageResults({
    data: [
      { url: 'https://cdn.example.com/a.png' },
      { b64_json: 'AAAA' },
      { base64: 'BBBB', mime_type: 'image/png' },
      { nothing: true },
    ],
  });
  assert.equal(results.length, 3);
  assert.equal(results[0].url, 'https://cdn.example.com/a.png');
  assert.equal(results[1].base64, 'AAAA');
  assert.equal(results[2].base64, 'BBBB');
  assert.equal(results[2].mime, 'image/png');
});

test('parseImageResults：返回结构不对时给空数组，而不是抛错', () => {
  assert.deepEqual(parseImageResults({}), []);
  assert.deepEqual(parseImageResults({ data: 'oops' }), []);
});
