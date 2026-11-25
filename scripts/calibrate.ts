/**
 * Level 3 — "keeping an eye on the judge".
 *
 *   npm run eval:judge   # genkit eval:run on datasets/judge-calibration.json (human-labelled)
 *   npm run calibrate    # how often does the LLM judge agree with the human?
 *
 * Re-run whenever you change the judge model, its prompt or its threshold.
 */
import { readFileSync } from 'node:fs';
import { computeCalibration, type Label, type Result } from './gate-core.js';

const [resultsPath, labelsPath] = process.argv.slice(2);
const results: Result[] = JSON.parse(readFileSync(resultsPath, 'utf8'));
const labels: Label[] = JSON.parse(readFileSync(labelsPath, 'utf8'));
const threshold = process.env.JUDGE_THRESHOLD ? Number(process.env.JUDGE_THRESHOLD) : undefined;
const { matrix, total, agreement, disagreements, skipped } = computeCalibration(results, labels, threshold);

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
