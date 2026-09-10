import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtempoChain, compileFilterGraph } from './filtergraph.js';

const speeds = [0.1, 0.2, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 10, 15, 20];
test('buildAtempoChain covers supported speeds', () => {
  for (const speed of speeds) {
    const chain = buildAtempoChain(speed);
    if (speed === 1) { assert.equal(chain, ''); continue; }
    const factors = chain.split(',').map((part) => Number(part.split('=')[1]));
    assert.ok(factors.every((factor) => factor >= 0.5 && factor <= 2));
    assert.ok(Math.abs(factors.reduce((product, factor) => product * factor, 1) - speed) < 1e-6);
  }
});

test('compileFilterGraph emits clip, speed and escaped overlay filters', () => {
  const graph = compileFilterGraph({ clips: [
    { input: '0:v', inPoint: 0, outPoint: 4, speed: 2, hasAudio: true },
    { input: '1:v', inPoint: 1, outPoint: 3, speed: 0.25, hasAudio: false },
  ], overlays: [{ input: '2:v', start: 3, end: 8 }] });
  assert.match(graph, /concat=n=2:v=1:a=1/);
  assert.match(graph, /setpts=0\.500000\*PTS/);
  assert.match(graph, /setpts=4\.000000\*PTS/);
  assert.match(graph, /atempo=0\.50,atempo=0\.50/);
  assert.match(graph, /between\(t\\,3\\,8\)/);
});
