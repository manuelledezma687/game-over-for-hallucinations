/**
 * HR assistant built with Genkit + Gemini, and everything needed to test it.
 *
 *   npm run dev            -> Genkit Dev UI (datasets, evaluations, traces) on localhost:4000
 *   npm run eval           -> L2 golden set + L1/L3 evaluators, results in reports/current.json
 *   npm run eval:attacks   -> L4 prompt injection suite
 *   npm run gate           -> L5 block the release on failures or regressions
 *
 * Env: GEMINI_API_KEY, PROMPT_VERSION=v1|v2, GUARD=on|off, ENABLE_FIREBASE_TELEMETRY=true
 */
import { enableFirebaseTelemetry } from '@genkit-ai/firebase';
import { GenkitMetric, genkitEval } from '@genkit-ai/evaluator';
import { googleAI } from '@genkit-ai/google-genai';
import { genkit, z } from 'genkit';
import {
  canaryLeak,
  factCheck,
  knowsWhenItDoesNotKnow,
  productionGuard,
  type CheckResult,
  type DataPoint,
} from './checks.js';
import { DOCS, type HrDoc } from './docs.js';
import { PROMPTS } from './prompts.js';
import { withRetry } from './retry.js';
import { fold } from './facts.js';

const APP_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-latest';
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'gemini-pro-latest'; // judge >= app model
const PROMPT_VERSION = (process.env.PROMPT_VERSION ?? 'v1') as keyof typeof PROMPTS;
const GUARD = process.env.GUARD !== 'off';

// Final boss: in production, traces + metrics go to Firebase Genkit Monitoring.
if (process.env.ENABLE_FIREBASE_TELEMETRY === 'true') await enableFirebaseTelemetry();

export const ai = genkit({
  plugins: [
    googleAI(),
    // Level 3: an LLM in the judge's seat. Default thresholds: score > 0.5 = PASS. Calibrate them!
    genkitEval({
      judge: googleAI.model(JUDGE_MODEL),
      metrics: [
        GenkitMetric.FAITHFULNESS,
        GenkitMetric.MALICIOUSNESS,
        {
          type: GenkitMetric.ANSWER_RELEVANCY,
          judge: googleAI.model(JUDGE_MODEL),
          embedder: googleAI.embedder('gemini-embedding-001'),
        },
      ],
    }),
  ],
});

/** Naive keyword retriever. Note: it does NOT filter confidential docs - access control bugs are real. */
export const hrRetriever = ai.defineSimpleRetriever(
  { name: 'hr/docs', content: 'text', metadata: (d: HrDoc) => ({ id: d.id }) },
  async (query) => {
    const words = new Set(fold(query.text).match(/[a-z0-9]{4,}/g) ?? []);
    return DOCS.map((d) => ({ d, hits: (fold(d.text).match(/[a-z0-9]{4,}/g) ?? []).filter((w) => words.has(w)).length }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 3)
      .map((x) => x.d);
  },
);

export const hrAssistant = ai.defineFlow(
  { name: 'hrAssistant', inputSchema: z.object({ question: z.string() }), outputSchema: z.string() },
  async ({ question }) => {
    const docs = await ai.retrieve({ retriever: hrRetriever, query: question });
    const { text } = await withRetry(() =>
      ai.generate({
        model: googleAI.model(APP_MODEL),
        system: PROMPTS[PROMPT_VERSION],
        prompt: question,
        docs,
      }),
    );
    // Final boss power-up: the cheapest check runs on EVERY production answer, not only in CI.
    if (!GUARD) return text;
    const guarded = productionGuard(text);
    if (guarded.blocked) console.warn(JSON.stringify({ event: 'guardrail_blocked', check: 'canaryLeak', question }));
    return guarded.answer;
  },
);

// Register the deterministic checks so `genkit eval:flow` and the Dev UI run them next to the judge.
function register(name: string, displayName: string, definition: string, check: (d: DataPoint) => CheckResult) {
  ai.defineEvaluator({ name: `custom/${name}`, displayName, definition, isBilled: false }, async (datapoint) => {
    const r = check(datapoint);
    return { testCaseId: datapoint.testCaseId, evaluation: { score: r.score, status: r.status, details: { reasoning: r.reasoning } } };
  });
}
register('factCheck', 'Fact check', 'Numbers and names match the approved answer.', factCheck);
register('knowsWhenItDoesNotKnow', "Says 'I don't know'", 'Abstains when the documents lack the answer.', knowsWhenItDoesNotKnow);
register('canaryLeak', 'Canary leak', 'No canary token or secret appears in the answer.', canaryLeak);
