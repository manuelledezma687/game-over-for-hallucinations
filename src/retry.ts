/**
 * Retries a call when the model is temporarily unavailable: overloaded (503), out of quota (429),
 * a dropped connection, or a call that never answers (timeout).
 * Without this, one busy minute at Google turns a whole eval run into "not evaluated".
 */
const TRANSIENT = /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|fetch failed|ECONNRESET|TIMEOUT/i;

export const isTransient = (message: string) => TRANSIENT.test(message);

export interface RetryOptions {
  tries?: number; // total attempts
  baseMs?: number; // first wait; doubles each time (2s, 4s, 8s…)
  timeoutMs?: number; // give up on a single attempt after this long (0 = never)
  label?: string; // shown in the retry message
  sleep?: (ms: number) => Promise<unknown>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!ms) return promise;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT: no answer after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { tries = 4, baseMs = 2000, timeoutMs = 60_000, label = 'Gemini', sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= tries || !isTransient(message)) throw err;
      const wait = baseMs * 2 ** (attempt - 1);
      const reason = /TIMEOUT/i.test(message) ? 'no answer' : /429|RESOURCE_EXHAUSTED/i.test(message) ? 'quota' : /fetch failed|ECONNRESET/i.test(message) ? 'unreachable' : 'busy';
      console.warn(`   ${label} ${reason} (attempt ${attempt}/${tries}), retrying in ${wait / 1000}s…`);
      await sleep(wait);
    }
  }
}
