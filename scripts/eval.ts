/**
 * Cross-platform wrapper around `genkit eval:flow` (works on Windows, macOS, Linux).
 *
 *   tsx scripts/eval.ts golden                 -> reports/current.json
 *   tsx scripts/eval.ts attacks                -> reports/attacks.json
 *   tsx scripts/eval.ts prerun                 -> reports/v1.json + reports/v2.json + reports/calibration.json
 *                                                (run BEFORE the talk; the live demo then only reads them)
 *
 * Evaluations always run with GUARD=off: CI must see what the MODEL does,
 * the production guardrail is a separate safety net (final boss).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'golden';
mkdirSync('reports', { recursive: true });

function run(args: string, env: Record<string, string> = {}) {
  console.log(`\n$ ${env.PROMPT_VERSION ? `PROMPT_VERSION=${env.PROMPT_VERSION} ` : ''}genkit ${args}`);
  const out = args.match(/(?:-o|--output)\s+(\S+)/)?.[1];
  const startedAt = Date.now();
  const r = spawnSync(`npx genkit ${args} -- npx tsx src/index.ts`, {
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, GUARD: 'off', ...env },
  });
  if (r.status === 0) return;
  // On recent Windows 11 the Genkit CLI crashes AFTER writing its results, when it tries to
  // stop the app with wmic.exe (removed from Windows). If fresh results exist, keep going.
  if (out && existsSync(out) && statSync(out).mtimeMs >= startedAt) {
    try {
      const results = JSON.parse(readFileSync(out, 'utf8'));
      if (Array.isArray(results) && results.length) {
        console.warn(`\n⚠️  Genkit CLI exited with an error, but ${out} was written (${results.length} cases). Continuing.`);
        return;
      }
    } catch {}
  }
  process.exit(r.status ?? 1);
}

const DETERMINISTIC = 'custom/factCheck,custom/knowsWhenItDoesNotKnow,custom/canaryLeak';
const flow = (input: string, out: string, version = 'v1', evaluators?: string) =>
  run(
    `eval:flow hrAssistant --input ${input} -o ${out} -f --non-interactive${evaluators ? ` --evaluators ${evaluators}` : ''}`,
    { PROMPT_VERSION: version },
  );

// The LLM judge hits quota (429) and overload (503) errors. Re-run only those cases,
// after a pause, and merge them into the same report.
const TRANSIENT = /\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|fetch failed/i;
type Result = { testCaseId: string; metrics?: { evaluator: string; error?: string }[] };
function judge(rounds = 3, pauseMs = Number(process.env.JUDGE_RETRY_PAUSE_MS ?? 60_000)) {
  const OUT = 'reports/calibration.json';
  run(`eval:run datasets/judge-calibration.json --evaluators genkitEval/faithfulness --output ${OUT} --force --non-interactive`);
  const dataset: { testCaseId: string }[] = JSON.parse(readFileSync('datasets/judge-calibration.json', 'utf8'));
  for (let round = 1; round <= rounds; round++) {
    const results: Result[] = JSON.parse(readFileSync(OUT, 'utf8'));
    const failed = results.filter((r) => r.metrics?.some((m) => m.error && TRANSIENT.test(m.error))).map((r) => r.testCaseId);
    if (!failed.length) break;
    console.log(`\n⏳ ${failed.length} case(s) hit 503/429 (${failed.join(', ')}). Waiting ${pauseMs / 1000}s, retry ${round}/${rounds}…`);
    spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${pauseMs})`]);
    writeFileSync('reports/judge-retry.json', JSON.stringify(dataset.filter((c) => failed.includes(c.testCaseId)), null, 2));
    run(`eval:run reports/judge-retry.json --evaluators genkitEval/faithfulness --output reports/judge-retry-out.json --force --non-interactive`);
    const retried: Result[] = JSON.parse(readFileSync('reports/judge-retry-out.json', 'utf8'));
    const byId = new Map(retried.map((r) => [r.testCaseId, r]));
    writeFileSync(OUT, JSON.stringify(results.map((r) => byId.get(r.testCaseId) ?? r), null, 2));
  }
}

if (mode === 'golden') flow('datasets/golden.json', 'reports/current.json', process.env.PROMPT_VERSION ?? 'v1');
else if (mode === 'attacks') flow('datasets/attacks.json', 'reports/attacks.json', process.env.PROMPT_VERSION ?? 'v1');
else if (mode === 'judge') judge();
else if (mode === 'prerun') {
  const all = [...JSON.parse(readFileSync('datasets/golden.json', 'utf8')), ...JSON.parse(readFileSync('datasets/attacks.json', 'utf8'))];
  writeFileSync('reports/demo-dataset.json', JSON.stringify(all, null, 2));
  // The stage demo shows the deterministic checks for v1/v2 and the judge in its own step:
  // skipping judge metrics here saves ~90 calls of API quota.
  flow('reports/demo-dataset.json', 'reports/v1.json', 'v1', DETERMINISTIC);
  flow('reports/demo-dataset.json', 'reports/v2.json', 'v2', DETERMINISTIC);
  judge();
  console.log('\nReady for the stage: npm run demo');
} else {
  console.error('usage: eval.ts golden|attacks|judge|prerun');
  process.exit(2);
}
