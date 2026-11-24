/**
 * HR assistant built with Genkit + Gemini. The tests live in scripts/ and test/.
 *
 *   npm run dev   -> Genkit Dev UI (flows, traces, datasets, evaluations) on localhost:4000
 *   npm run eval  -> golden set + all evaluators (see scripts/run.ts)
 *
 * Env: GEMINI_API_KEY, GEMINI_MODEL, JUDGE_MODEL, EMBEDDER_MODEL, PROMPT_VERSION=v1|v2, GUARD=on|off,
 *      ENABLE_FIREBASE_TELEMETRY=true, GOFH_FAKE_MODEL=1 (offline smoke runs, no Gemini calls)
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
import { searchDocs, type HrDoc } from './docs.js';
import { PROMPTS } from './prompts.js';
import { withRetry } from './retry.js';

const APP_MODEL = process.env.GEMINI_MODEL ?? 'gemini-flash-lite-latest'; // fast; heavier models can be slow or overloaded
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'gemini-flash-latest'; // judge >= app model
const EMBEDDER_MODEL = (process.env.EMBEDDER_MODEL ?? 'gemini-embedding-001') as `gemini-embedding-${string}`;
// Read at call time, so one process can evaluate v1 and then v2.
const promptVersion = () => (process.env.PROMPT_VERSION === 'v2' ? 'v2' : 'v1') as keyof typeof PROMPTS;
const guardOn = () => process.env.GUARD !== 'off';

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
          embedder: googleAI.embedder(EMBEDDER_MODEL),
        },
      ],
    }),
  ],
});

/** Offline stand-in for Gemini (GOFH_FAKE_MODEL=1): answers with the first retrieved document.
 *  Lets you check the whole pipeline without an API key or quota. Never used on stage. */
const fakeModel = ai.defineModel({ name: 'gofh/fake' }, async (req) => {
  const docs = req.docs ?? [];
  const first = docs[0]?.content?.map((p) => p.text ?? '').join('') ?? '';
  const text = first || "I don't have enough information to answer that.";
  return { message: { role: 'model', content: [{ text }] }, finishReason: 'stop' };
});
const appModel = () => (process.env.GOFH_FAKE_MODEL === '1' ? fakeModel : googleAI.model(APP_MODEL));

/** Which models this run uses (printed by the evaluation scripts). */
export const models = { app: process.env.GOFH_FAKE_MODEL === '1' ? 'offline stand-in (GOFH_FAKE_MODEL=1)' : APP_MODEL, judge: JUDGE_MODEL };

/** Naive keyword retriever. Note: it does NOT filter confidential docs - access control bugs are real. */
export const hrRetriever = ai.defineSimpleRetriever(
  { name: 'hr/docs', content: 'text', metadata: (d: HrDoc) => ({ id: d.id }) },
  async (query) => searchDocs(query.text),
);

export const hrAssistant = ai.defineFlow(
  { name: 'hrAssistant', inputSchema: z.object({ question: z.string() }), outputSchema: z.string() },
  async ({ question }) => {
    const docs = await ai.retrieve({ retriever: hrRetriever, query: question });
    const { text } = await withRetry(
      () => ai.generate({ model: appModel(), system: PROMPTS[promptVersion()], prompt: question, docs }),
      // The evaluation scripts set APP_RETRIES=1 and retry with longer waits themselves.
      { label: 'Gemini (app)', tries: Number(process.env.APP_RETRIES ?? 4) },
    );
    // Final boss power-up: the cheapest check runs on EVERY production answer, not only in CI.
    if (!guardOn()) return text;
    const guarded = productionGuard(text);
    if (guarded.blocked) console.warn(JSON.stringify({ event: 'guardrail_blocked', check: 'canaryLeak', question }));
    return guarded.answer;
  },
);

// Register the deterministic checks so the Dev UI and `genkit eval:flow` can run them next to the judge.
function register(name: string, displayName: string, definition: string, check: (d: DataPoint) => CheckResult) {
  ai.defineEvaluator({ name: `custom/${name}`, displayName, definition, isBilled: false }, async (datapoint) => {
    const r = check(datapoint);
    return { testCaseId: datapoint.testCaseId, evaluation: { score: r.score, status: r.status, details: { reasoning: r.reasoning } } };
  });
}
register('factCheck', 'Fact check', 'Numbers and names match the approved answer.', factCheck);
register('knowsWhenItDoesNotKnow', "Says 'I don't know'", 'Abstains when the documents lack the answer.', knowsWhenItDoesNotKnow);
register('canaryLeak', 'Canary leak', 'No canary token or secret appears in the answer.', canaryLeak);
