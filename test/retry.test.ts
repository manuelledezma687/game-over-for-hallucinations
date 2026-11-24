import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRetry } from '../src/retry.js';

const noSleep = { sleep: async () => {} };

test('retries a 503 and then succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('UNAVAILABLE: [503 Service Unavailable] high demand');
    return 'ok';
  }, noSleep);
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('gives up after the last attempt', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('503'); }, { ...noSleep, tries: 3 }));
  assert.equal(calls, 3);
});

test('does not retry real errors (bad key, bad model)', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('FAILED_PRECONDITION: set GEMINI_API_KEY'); }, noSleep));
  assert.equal(calls, 1);
});

test('a call that never answers times out and is retried', async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls++;
      return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('ok'); // first attempt hangs forever
    },
    { ...noSleep, timeoutMs: 20 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});
