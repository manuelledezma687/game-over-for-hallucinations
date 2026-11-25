/**
 * Runs every evaluation INSIDE this process: no Genkit CLI, no extra processes, no ports.
 * (The CLI route broke on Windows: wmic.exe crashes, leftover apps, hangs.)
 *
 *   tsx scripts/run.ts golden    golden set + all evaluators (incl. the LLM judge) -> reports/current.json
 *   tsx scripts/run.ts attacks   prompt-injection suite                            -> reports/attacks.json
 *   tsx scripts/run.ts judge     judge calibration on human-labelled answers       -> reports/calibration.json
 *   tsx scripts/run.ts flows     v1 and v2 on golden + attacks (free checks only)  -> reports/v1.json, v2.json
 *   tsx scripts/run.ts prerun    flows + judge: everything the stage demo needs
 *
 * Output files use the same format as `genkit eval:flow -o`, so gate/calibrate/demo read both.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { canaryLeak, factCheck, knowsWhenItDoesNotKnow, type CheckResult, type DataPoint } from '../src/checks.js';
import { searchDocs } from '../src/docs.js';
import { isTransient, withRetry } from '../src/retry.js';

process.env.GUARD = 'off'; // evaluations must see what the MODEL does; the guardrail is the final boss
process.env.APP_RETRIES = '1'; // one layer of retries only: the one below, with longer waits
const VERBOSE = process.env.VERBOSE === '1';
if (!VERBOSE) console.debug = () => {}; // the evaluator plugin dumps whole datasets with console.debug

/** Genkit prints long stack traces when a judge call fails. The reason is saved in the report anyway. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  if (VERBOSE) return fn();
  const original = { error: console.error, warn: console.warn };
  console.error = () => {};
  console.warn = () => {}; // e.g. "strict mode: use allowUnionTypes…" from Genkit's schema validator
  try {
    return await fn();
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
}
const { ai, hrAssistant, models } = await import('../src/index.js');

interface Case { testCaseId: string; input: { question: string } | unknown; output?: unknown; context?: string[]; reference?: unknown }
interface Metric { evaluator: string; score?: unknown; status?: string; rationale?: string; error?: string }
interface Result extends Case { metrics: Metric[]; error?: string }

const CHECKS: [string, (d: DataPoint) => CheckResult][] = [
  ['custom/factCheck', factCheck],
  ['custom/knowsWhenItDoesNotKnow', knowsWhenItDoesNotKnow],
  ['custom/canaryLeak', canaryLeak],
];
const JUDGE = ['genkitEval/faithfulness', 'genkitEval/answer_relevancy', 'genkitEval/maliciousness'];

const load = (file: string): Case[] => JSON.parse(readFileSync(file, 'utf8'));
const save = (file: string, results: Result[]) => {
  mkdirSync('reports', { recursive: true });
  writeFileSync(file, JSON.stringify(results, null, 2));
  // Who produced this file, and when: the HTML report shows it next to each run.
  const INFO = 'reports/run-info.json';
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(readFileSync(INFO, 'utf8'));
  } catch {}
  info[file.replace(/^reports\//, '')] = {
    at: new Date().toISOString(),
    appModel: models.app,
    judgeModel: models.judge,
    promptVersion: process.env.PROMPT_VERSION ?? 'v1',
  };
  writeFileSync(INFO, JSON.stringify(info, null, 2));
};
const icon = (s?: string) => (s === 'PASS' ? '✅' : s === 'FAIL' ? '❌' : s === 'ERROR' ? '⚠️ ' : '·');

/** One judge metric on one case, retried on 503/429/timeouts. Errors are recorded, never thrown. */
async function judge(evaluator: string, d: Case): Promise<Metric> {
  try {
    const score = await withRetry(
      async () => {
        const [res] = await quietly(() => ai.evaluate({ evaluator, dataset: [d as never] }));
        const ev = Array.isArray(res?.evaluation) ? res.evaluation[0] : res?.evaluation;
        if (ev?.error && isTransient(ev.error)) throw new Error(ev.error); // retry this case only
        return ev;
      },
      { tries: 5, baseMs: Number(process.env.JUDGE_RETRY_BASE_MS ?? 10_000), timeoutMs: 120_000, label: 'Judge' }, // 10s, 20s, 40s, 80s: quota resets per minute
    );
    const reasoning = (score?.details as { reasoning?: string } | undefined)?.reasoning;
    return { evaluator, score: score?.score, status: score?.status, rationale: reasoning, error: score?.error };
  } catch (e) {
    return { evaluator, error: e instanceof Error ? e.message : String(e) };
  }
}

/** If Gemini fails on this many cases in a row, stop: it's down or the model name is wrong. */
const MAX_CONSECUTIVE_APP_ERRORS = 3;

/** Ask the app every question, then grade each answer. */
async function evaluateFlow(dataset: Case[], version: 'v1' | 'v2', withJudge: boolean, out: string) {
  process.env.PROMPT_VERSION = version;
  console.log(`\n▶ ${version} · ${dataset.length} cases${withJudge ? ' · with LLM judge' : ''} → ${out}`);
  const results: Result[] = [];
  let appErrorsInARow = 0;
  for (const [i, c] of dataset.entries()) {
    const question = (c.input as { question: string }).question;
    const context = searchDocs(question).map((d) => d.text);
    const result: Result = { ...c, context, metrics: [] };
    try {
      // Overload spikes last seconds to minutes: wait 5s, 10s, 20s before giving up on this question.
      result.output = await withRetry(() => quietly(() => hrAssistant({ question })), {
        tries: 4, baseMs: Number(process.env.APP_RETRY_BASE_MS ?? 5_000), timeoutMs: 90_000, label: `Gemini (${models.app})`,
      });
      appErrorsInARow = 0;
    } catch (e) {
      result.error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' '); // the gate counts it as "not evaluated"
      appErrorsInARow++;
    }
    if (result.output !== undefined) {
      for (const [name, check] of CHECKS) {
        const r = check(result as DataPoint);
        result.metrics.push({ evaluator: name, score: r.score, status: r.status, rationale: r.reasoning });
      }
      if (withJudge) for (const name of JUDGE) result.metrics.push(await judge(name, result));
    }
    const marks = result.error ? '⚠️  app error: ' + result.error.slice(0, 80) : result.metrics.map((m) => icon(m.error ? 'ERROR' : m.status)).join(' ');
    console.log(`  [${String(i + 1).padStart(2)}/${dataset.length}] ${c.testCaseId.padEnd(32)} ${marks}`);
    results.push(result);
    if (appErrorsInARow >= MAX_CONSECUTIVE_APP_ERRORS) {
      console.error(
        `\n🛑 Stopped: ${models.app} failed on ${appErrorsInARow} questions in a row.\n` +
          `   Last error: ${result.error?.slice(0, 160)}\n` +
          `   503 = the model is overloaded: wait a few minutes, or use another model:\n` +
          `     PowerShell:  $env:GEMINI_MODEL="gemini-flash-lite-latest"\n` +
          `   404 = the model name is wrong or retired: see https://ai.google.dev/gemini-api/docs/models`,
      );
      process.exit(1);
    }
  }
  save(out, results);
}

/** Level 3: the judge grades answers a human already graded. */
async function calibrate() {
  const OUT = 'reports/calibration.json';
  const dataset = load('datasets/judge-calibration.json');
  console.log(`\n▶ judge calibration · ${dataset.length} human-labelled answers → ${OUT}`);
  const results: Result[] = [];
  let quotaInARow = 0;
  for (const [i, c] of dataset.entries()) {
    const m = await judge('genkitEval/faithfulness', c);
    quotaInARow = m.error && /429|RESOURCE_EXHAUSTED/i.test(m.error) ? quotaInARow + 1 : 0;
    const why = m.error ? m.error.replace(/\s+/g, ' ').replace(/^Evaluation of test case \S+ failed: /, '').slice(0, 70) : `score ${m.score}`;
    console.log(`  [${String(i + 1).padStart(2)}/${dataset.length}] ${c.testCaseId.padEnd(8)} ${icon(m.error ? 'ERROR' : m.status)} ${why}`);
    results.push({ ...c, metrics: [m] });
    if (quotaInARow >= 2) {
      console.error(
        `\n🛑 Judge stopped: ${models.judge} is out of quota (429) even after waiting.\n` +
          `   This is usually the DAILY free-tier quota: it resets the next day.\n` +
          `   Options: run "npm run eval:judge" tomorrow, or try another judge model:\n` +
          `     PowerShell:  $env:JUDGE_MODEL="gemini-flash-lite-latest"`,
      );
      break;
    }
  }
  // Never replace a calibration that has verdicts with one that has none (e.g. quota ran out).
  const verdicts = (rs: Result[]) => rs.filter((r) => r.metrics.some((m) => m.status === 'PASS' || m.status === 'FAIL')).length;
  let previous: Result[] = [];
  try {
    previous = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {}
  if (verdicts(results) === 0 && verdicts(previous) > 0) {
    console.log(`   Kept your previous calibration (${verdicts(previous)} verdicts) instead of saving one with none.`);
    return;
  }
  save(OUT, results);
}

const golden = () => load('datasets/golden.json');
const attacks = () => load('datasets/attacks.json');
const version = process.env.PROMPT_VERSION === 'v2' ? 'v2' : 'v1';
const mode = process.argv[2] ?? 'golden';
const started = Date.now();
console.log(`App model: ${models.app} · Judge model: ${models.judge}`);

if (mode === 'golden') await evaluateFlow(golden(), version, true, 'reports/current.json');
else if (mode === 'attacks') await evaluateFlow(attacks(), version, false, 'reports/attacks.json');
else if (mode === 'judge') await calibrate();
else if (mode === 'flows' || mode === 'prerun') {
  await evaluateFlow([...golden(), ...attacks()], 'v1', false, 'reports/v1.json');
  await evaluateFlow([...golden(), ...attacks()], 'v2', false, 'reports/v2.json');
  if (mode === 'prerun') await calibrate();
  console.log(`\nReady for the stage: npm run demo   ·   every detail in HTML: npm run report`);
} else {
  console.error('usage: tsx scripts/run.ts golden|attacks|judge|flows|prerun');
  process.exit(2);
}
console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s.`);
process.exit(0); // Genkit keeps some handles open; we're done.
