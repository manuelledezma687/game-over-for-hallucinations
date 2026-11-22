/**
 * Level 3 — "keeping an eye on the judge".
 *
 *   npm run eval:judge   # genkit eval:run on datasets/judge-calibration.json (human-labelled)
 *   npm run calibrate    # how often does the LLM judge agree with the human?
 *
 * Re-run whenever you change the judge model, its prompt or its threshold.
 */
import { readFileSync } from 'node:fs';

interface Metric { evaluator: string; score?: unknown; status?: string }
const [resultsPath, labelsPath] = process.argv.slice(2);
const results: { testCaseId: string; metrics?: Metric[] }[] = JSON.parse(readFileSync(resultsPath, 'utf8'));
const labels: { testCaseId: string; output: string; reference: { human: string; note?: string } }[] = JSON.parse(
  readFileSync(labelsPath, 'utf8'),
);
const threshold = process.env.JUDGE_THRESHOLD ? Number(process.env.JUDGE_THRESHOLD) : undefined;

const human = new Map(labels.map((l) => [l.testCaseId, l]));
const matrix = { PASS: { PASS: 0, FAIL: 0 }, FAIL: { PASS: 0, FAIL: 0 } };
const disagreements: string[] = [];
const skipped: string[] = [];
for (const r of results) {
  const m = r.metrics?.find((x) => x.evaluator.endsWith('faithfulness')) as (Metric & { error?: string }) | undefined;
  const label = human.get(r.testCaseId);
  if (!label) continue;
  if (!m) { skipped.push(`${r.testCaseId}: no faithfulness result`); continue; }
  const judge = threshold !== undefined && typeof m.score === 'number' ? (m.score >= threshold ? 'PASS' : 'FAIL') : m.status;
  if (judge !== 'PASS' && judge !== 'FAIL') {
    let why = m.error ? String(m.error).replace(/\s+/g, ' ').replace(/^Evaluation of test case \S+ failed: /, '') : `status ${m.status ?? 'none'}, score ${JSON.stringify(m.score)}`;
    if (/No statements returned/i.test(why)) why = "an \"I don't know\" has no factual claims to judge; Level 2's deterministic check covers it";
    else if (/\b(503|429)\b/.test(why)) why = `Gemini ${why.includes('429') ? 'quota (429)' : 'overloaded (503)'}: re-run npm run eval:judge`;
    skipped.push(`${r.testCaseId}: ${why.slice(0, 140)}`);
    continue;
  }
  const h = label.reference.human as 'PASS' | 'FAIL';
  matrix[h][judge]++;
  if (h !== judge) disagreements.push(`${r.testCaseId}: human ${h}, judge ${judge} (score ${m.score}) — "${label.output}"`);
}

const total = matrix.PASS.PASS + matrix.PASS.FAIL + matrix.FAIL.PASS + matrix.FAIL.FAIL;
const agreement = total ? (matrix.PASS.PASS + matrix.FAIL.FAIL) / total : 0;
console.log(`\nJudge vs human on ${total} of ${labels.length} cases${threshold !== undefined ? ` (threshold ${threshold})` : ''}`);
console.log(`                 judge PASS   judge FAIL`);
console.log(`human PASS       ${String(matrix.PASS.PASS).padEnd(13)}${matrix.PASS.FAIL}`);
console.log(`human FAIL       ${String(matrix.FAIL.PASS).padEnd(13)}${matrix.FAIL.FAIL}`);
console.log(`\nHallucinations the judge let through (human FAIL, judge PASS): ${matrix.FAIL.PASS}`);
console.log(`Agreement: ${(agreement * 100).toFixed(0)}%`);
for (const d of disagreements) console.log(`  ✗ ${d}`);
if (skipped.length) {
  console.log(`\n${skipped.length} case(s) without a judge verdict (not counted):`);
  for (const s of skipped) console.log(`  - ${s}`);
}
if (matrix.FAIL.PASS > 0) console.log('\nTip: try JUDGE_THRESHOLD=0.9, or statusOverrideFn in genkitEval, and re-run.');
process.exit(agreement >= 0.8 ? 0 : 1);
