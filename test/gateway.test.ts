import test from 'node:test';
import assert from 'node:assert/strict';
import { Gateway, MemoryJobStore, DailyLimitError, imageEditProvider } from '../src/index.ts';

const ok = (name: string, cost = 0.04) => ({ name, model: 'm', run: async () => ({ output: { ok: name }, costUsd: cost }) });
const bad = { name: 'bad', model: 'm', run: async () => { throw new Error('boom'); } };

test('runs primary and logs the job', async () => {
  const store = new MemoryJobStore();
  const g = new Gateway({ store });
  g.register('draft', ok('a'));
  const r = await g.run('draft', { prompt: 'x' }, { userId: 'u1' });
  assert.equal(r.provider, 'a');
  assert.equal(store.jobs[0].status, 'done');
});

test('falls back when primary fails', async () => {
  const store = new MemoryJobStore();
  const g = new Gateway({ store });
  g.register('draft', bad, ok('b'));
  const r = await g.run('draft', {}, { userId: 'u1' });
  assert.equal(r.provider, 'b');
  assert.deepEqual(store.jobs.map((j) => j.status), ['failed', 'done']);
});

// Fails with the given HTTP status on the first `failures` calls, then succeeds.
const flaky = (name: string, status: number, failures = 1) => {
  let calls = 0;
  return {
    name, model: 'm', calls: () => calls,
    run: async () => {
      calls++;
      if (calls <= failures) throw Object.assign(new Error(`HTTP ${status}`), { status });
      return { output: { ok: name }, costUsd: 0.04 };
    },
  };
};

test('retries a transient error on the same provider before falling back', async () => {
  const store = new MemoryJobStore();
  const g = new Gateway({ store });
  const a = flaky('a', 503);
  const b = ok('b');
  g.register('draft', { ...a, retries: 1, backoffMs: 1 }, b);
  const r = await g.run('draft', {}, { userId: 'u1' });
  assert.equal(r.provider, 'a');
  assert.equal(a.calls(), 2);
  assert.deepEqual(store.jobs.map((j) => [j.provider, j.status]), [['a', 'failed'], ['a', 'done']]);
});

test('retries 429 and falls back once retries are used up', async () => {
  const store = new MemoryJobStore();
  const g = new Gateway({ store });
  const a = flaky('a', 429, 5);
  g.register('draft', { ...a, retries: 2, backoffMs: 1 }, ok('b'));
  const r = await g.run('draft', {}, { userId: 'u1' });
  assert.equal(r.provider, 'b');
  assert.equal(a.calls(), 3);
  assert.deepEqual(store.jobs.map((j) => j.status), ['failed', 'failed', 'failed', 'done']);
});

test('does not retry a non-transient error', async () => {
  const g = new Gateway();
  const a = flaky('a', 400);
  g.register('draft', { ...a, retries: 3, backoffMs: 1 }, ok('b'));
  const r = await g.run('draft', {}, { userId: 'u1' });
  assert.equal(r.provider, 'b');
  assert.equal(a.calls(), 1);
});

test('no retries by default', async () => {
  const g = new Gateway();
  const a = flaky('a', 503);
  g.register('draft', a, ok('b'));
  assert.equal((await g.run('draft', {}, { userId: 'u1' })).provider, 'b');
  assert.equal(a.calls(), 1);
});

test('waits backoffMs before retrying, doubling each time', async () => {
  const g = new Gateway();
  const a = flaky('a', 500, 2);
  g.register('draft', { ...a, retries: 2, backoffMs: 20 });
  const started = Date.now();
  await g.run('draft', {}, { userId: 'u1' });
  assert.ok(Date.now() - started >= 55, 'expected about 20ms + 40ms of backoff');
});

test('image edit provider error carries the HTTP status', async () => {
  const storage = { read: async () => new Blob([new Uint8Array([1])]), write: async () => {} };
  const fakeFetch = (async () => new Response('slow down', { status: 429 })) as typeof fetch;
  const p = imageEditProvider({ apiKey: 'test', storage, fetchImpl: fakeFetch });
  await assert.rejects(p.run({ sourcePath: 'src/a.png', prompt: 'x' }), { status: 429 });
});

test('stops at the daily limit', async () => {
  const g = new Gateway({ dailyLimitUsd: 0.05 });
  g.register('draft', ok('a', 0.05));
  await g.run('draft', {}, { userId: 'u1' });
  await assert.rejects(g.run('draft', {}, { userId: 'u1' }), DailyLimitError);
});

test('unknown task is an error', async () => {
  await assert.rejects(new Gateway().run('nope', {}, { userId: 'u' }), /No model configured/);
});

test('image edit provider with fake API and storage', async () => {
  const saved: Record<string, Uint8Array> = {};
  const storage = { read: async () => new Blob([new Uint8Array([1])]), write: async (p: string, b: Uint8Array) => { saved[p] = b; } };
  const fakeFetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: btoa('png') }] }))) as typeof fetch;
  const p = imageEditProvider({ apiKey: 'test', storage, fetchImpl: fakeFetch, outPath: () => 'out/1.png' });
  const r = await p.run({ sourcePath: 'src/a.png', prompt: 'make it warm' });
  assert.equal(r.output.path, 'out/1.png');
  assert.equal(r.output.pricePending, true);
  assert.equal(new TextDecoder().decode(saved['out/1.png']), 'png');
});
