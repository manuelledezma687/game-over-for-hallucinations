/**
 * Level 5 — the pipeline decides, not a human squinting at outputs.
 *
 *   tsx scripts/gate.ts <current.json> [baseline.json] [--update-baseline]
 *
 * Reads the JSON written by `genkit eval:flow ... -o <file>` and exits 1 when:
 *   - a deterministic check (custom/*) FAILS            -> facts, "I don't know", canary leaks
 *   - an LLM-judge metric drops below its pass rate      -> judges are noisy: gate on rates
 *   - anything that PASSED in the baseline now FAILS     -> regression after a model/prompt change
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

interface Metric { evaluator: string; score?: unknown; status?: string; rationale?: string; error?: string }
interface Result { testCaseId: string; output?: unknown; error?: string; metrics?: Metric[] }

const JUDGE_MIN_PASS_RATE = Number(process.env.JUDGE_MIN_PASS_RATE ?? 0.8);
const [currentPath, baselinePath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const updateBaseline = process.argv.includes('--update-baseline');
const quiet = process.argv.includes('--quiet'); // stage mode: counts only, details elsewhere
if (!currentPath) {
  console.error('usage: gate.ts <current.json> [baseline.json] [--update-baseline]');
  process.exit(2);
}

const load = (p: string): Result[] => JSON.parse(readFileSync(p, 'utf8'));
const statuses = (results: Result[]) => {
  const map = new Map<string, Metric>();
  for (const r of results) {
    for (const raw of r.metrics ?? []) {
      const m = { ...raw, evaluator: raw.evaluator.replace(/^\/evaluator\//, '') }; // CLI writes "/evaluator/custom/x"
      map.set(`${r.testCaseId} :: ${m.evaluator}`, m);
    }
  }
  return map;
};
const reasonOf = (m: Metric) => String(m.rationale ?? m.error ?? '').slice(0, 110);

const currentResults = load(currentPath);
const current = statuses(currentResults);
const baseline = baselinePath && existsSync(baselinePath) ? statuses(load(baselinePath)) : undefined;
const problems: string[] = [];

// A case that crashed has no metrics. Without this check the gate would pass silently.
const crashed = currentResults.filter((r) => r.error || !r.metrics?.length);
if (crashed.length) {
  console.log(`\n❌ ${crashed.length}/${currentResults.length} case(s) produced no evaluation (inference or evaluator error):`);
  for (const r of crashed.slice(0, 5)) console.log(`     ↳ ${r.testCaseId} — ${String(r.error ?? 'no metrics').slice(0, 110)}`);
  problems.push(`${crashed.length} case(s) not evaluated`);
}

console.log('\n=== Scoreboard ===');
const byEvaluator = new Map<string, Metric[]>();
for (const [key, m] of current) byEvaluator.set(m.evaluator, [...(byEvaluator.get(m.evaluator) ?? []), { ...m, rationale: key.split(' :: ')[0] + ' — ' + reasonOf(m) }]);
for (const [evaluator, ms] of [...byEvaluator].sort()) {
  const scored = ms.filter((m) => m.status === 'PASS' || m.status === 'FAIL');
  const passed = scored.filter((m) => m.status === 'PASS').length;
  const rate = scored.length ? passed / scored.length : 1;
  const failed = scored.filter((m) => m.status === 'FAIL');
  const errored = ms.filter((m) => m.error).length;
  const isJudge = !evaluator.startsWith('custom/');
  const noVerdicts = errored > 0 && scored.length === 0; // e.g. the judge never answered: that is not a pass
  const blocked = noVerdicts || (isJudge ? rate < JUDGE_MIN_PASS_RATE : failed.length > 0);
  const errNote = errored ? `, ${errored} without a verdict (errors)` : '';
  console.log(`${blocked ? '❌' : '✅'} ${evaluator.padEnd(34)} ${passed}/${scored.length} passed${errNote}${isJudge ? `  (gate: ≥ ${JUDGE_MIN_PASS_RATE * 100}%)` : ''}`);
  if (!quiet) for (const m of failed) console.log(`     ↳ ${m.rationale}`);
  if (blocked) problems.push(noVerdicts ? `${evaluator}: no verdicts (all calls failed)` : `${evaluator}: ${failed.length} failing case(s)`);
}

if (baseline) {
  console.log('\n=== Regressions vs baseline ===');
  const regressions = [...current].filter(([key, now]) => baseline.get(key)?.status === 'PASS' && now.status === 'FAIL');
  const perEvaluator = new Map<string, string[]>();
  for (const [key, m] of regressions) perEvaluator.set(m.evaluator, [...(perEvaluator.get(m.evaluator) ?? []), key.split(' :: ')[0]]);
  for (const [evaluator, ids] of perEvaluator) {
    console.log(`⬇️  ${evaluator.padEnd(34)} ${ids.length} case(s) PASS → FAIL: ${ids.join(', ')}`);
    problems.push(`regression in ${evaluator}`);
  }
  if (!regressions.length) console.log('none');
}

if (problems.length) {
  console.log(`\nRelease: BLOCKED 🛑  GAME OVER for this release (${problems.length} problem(s))`);
  process.exit(1);
}
console.log('\nRelease: OK ✅  level cleared');
if (updateBaseline && baselinePath) {
  copyFileSync(currentPath, baselinePath);
  console.log(`Baseline updated: ${baselinePath}`);
}
