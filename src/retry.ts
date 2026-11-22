/**
 * Retries a call when the model is temporarily overloaded (503 / 429).
 * Without this, one busy minute at Google turns a whole eval run into "not evaluated".
 */
const TRANSIENT = /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded/i;

export async function withRetry<T>(
  fn: () => Promise<T>,
  { tries = 4, baseMs = 2000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= tries || !TRANSIENT.test(message)) throw err;
      const wait = baseMs * 2 ** (attempt - 1); // 2s, 4s, 8s
      console.warn(`Gemini busy (attempt ${attempt}/${tries}), retrying in ${wait / 1000}s…`);
      await sleep(wait);
    }
  }
}
