import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRangeHeader } from './media/media.js';

test('parseRangeHeader：无 Range 头或空范围时返回整文件', () => {
  assert.deepEqual(parseRangeHeader(undefined, 1000), { kind: 'full' });
  assert.deepEqual(parseRangeHeader('bytes=-', 1000), { kind: 'full' });
  // 只有 "bytes=" 没有横杠，不是合法的 Range 单位串，按 416 处理
  assert.equal(parseRangeHeader('bytes=', 1000).kind, 'invalid');
});

test('parseRangeHeader：开头-结尾、开口、后缀三种形式', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-499', 1000), { kind: 'range', start: 0, end: 499 });
  assert.deepEqual(parseRangeHeader('bytes=500-', 1000), { kind: 'range', start: 500, end: 999 });
  assert.deepEqual(parseRangeHeader('bytes=-200', 1000), { kind: 'range', start: 800, end: 999 });
  // end 越界按规范截到文件尾
  assert.deepEqual(parseRangeHeader('bytes=900-9999', 1000), { kind: 'range', start: 900, end: 999 });
  // 大小写不敏感
  assert.deepEqual(parseRangeHeader('BYTES=0-0', 1000), { kind: 'range', start: 0, end: 0 });
});

test('parseRangeHeader：越界与非法头返回 invalid（响应 416）', () => {
  assert.equal(parseRangeHeader('bytes=1000-', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('bytes=1001-2000', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('bytes=500-100', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('bytes=abc-', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('items=0-1', 1000).kind, 'invalid');
  assert.equal(parseRangeHeader('bytes=-0', 1000).kind, 'invalid');
  // 空文件任何分段都无效
  assert.equal(parseRangeHeader('bytes=0-', 0).kind, 'invalid');
});
