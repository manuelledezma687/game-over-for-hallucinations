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
import { JUDGE_MIN_PASS_RATE, evaluateGate, type Result } from './gate-core.js';

const [currentPath, baselinePath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const updateBaseline = process.argv.includes('--update-baseline');
const quiet = process.argv.includes('--quiet'); // stage mode: counts only, details elsewhere
if (!currentPath) {
  console.error('usage: gate.ts <current.json> [baseline.json] [--update-baseline]');
  process.exit(2);
}

const load = (p: string): Result[] => JSON.parse(readFileSync(p, 'utf8'));
const outcome = evaluateGate(load(currentPath), baselinePath && existsSync(baselinePath) ? load(baselinePath) : undefined);

if (outcome.crashed.length) {
  console.log(`\n❌ ${outcome.crashed.length}/${outcome.total} case(s) produced no evaluation (inference or evaluator error):`);
  for (const r of outcome.crashed.slice(0, 5)) console.log(`     ↳ ${r.testCaseId} — ${String(r.error ?? 'no metrics').slice(0, 110)}`);
}

console.log('\n=== Scoreboard ===');
for (const row of outcome.rows) {
  const errNote = row.errored ? `, ${row.errored} without a verdict (errors)` : '';
  console.log(`${row.blocked ? '❌' : '✅'} ${row.evaluator.padEnd(34)} ${row.passed}/${row.scored} passed${errNote}${row.isJudge ? `  (gate: ≥ ${JUDGE_MIN_PASS_RATE * 100}%)` : ''}`);
  if (!quiet) for (const f of row.failures) console.log(`     ↳ ${f}`);
}

if (outcome.regressions) {
  console.log('\n=== Regressions vs baseline ===');
  for (const r of outcome.regressions) console.log(`⬇️  ${r.evaluator.padEnd(34)} ${r.caseIds.length} case(s) PASS → FAIL: ${r.caseIds.join(', ')}`);
  if (!outcome.regressions.length) console.log('none');
}

if (outcome.blocked) {
  console.log(`\nRelease: BLOCKED 🛑  GAME OVER for this release (${outcome.problems.length} problem(s))`);
  console.log('Details for every case: npm run report');
  process.exit(1);
}
console.log('\nRelease: OK ✅  level cleared');
if (updateBaseline && baselinePath) {
  copyFileSync(currentPath, baselinePath);
  console.log(`Baseline updated: ${baselinePath}`);
}
