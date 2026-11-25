/**
 * The release rules, in one place. gate.ts prints them for CI; report.ts renders them as HTML.
 * Keeping one implementation means the HTML report can never disagree with the pipeline.
 */
export interface Metric { evaluator: string; score?: unknown; status?: string; rationale?: string; error?: string }
export interface Result {
  testCaseId: string;
  input?: unknown;
  output?: unknown;
  reference?: unknown;
  context?: unknown[];
  error?: string;
  metrics?: Metric[];
}

export interface ScoreRow {
  evaluator: string;
  isJudge: boolean;
  passed: number;
  scored: number;
  errored: number;
  blocked: boolean;
  noVerdicts: boolean;
  /** "<caseId> — <reason>" for every FAIL, in file order. */
  failures: string[];
}
export interface Regression { evaluator: string; caseIds: string[] }
export interface GateOutcome {
  crashed: Result[];
  total: number;
  rows: ScoreRow[];
  regressions?: Regression[];
  problems: string[];
  blocked: boolean;
}

export const JUDGE_MIN_PASS_RATE = Number(process.env.JUDGE_MIN_PASS_RATE ?? 0.8);

/** The Genkit CLI writes "/evaluator/custom/x"; the in-process runner writes "custom/x". */
export const normalise = (evaluator: string) => evaluator.replace(/^\/evaluator\//, '');
export const reasonOf = (m: Metric) => String(m.rationale ?? m.error ?? '').slice(0, 110);

/** "<caseId> :: <evaluator>" → metric */
export function statuses(results: Result[]): Map<string, Metric> {
  const map = new Map<string, Metric>();
  for (const r of results) {
    for (const raw of r.metrics ?? []) {
      const m = { ...raw, evaluator: normalise(raw.evaluator) };
      map.set(`${r.testCaseId} :: ${m.evaluator}`, m);
    }
  }
  return map;
}

export function evaluateGate(currentResults: Result[], baselineResults?: Result[], judgeMinPassRate = JUDGE_MIN_PASS_RATE): GateOutcome {
  const current = statuses(currentResults);
  const problems: string[] = [];

  // A case that crashed has no metrics. Without this check the gate would pass silently.
  const crashed = currentResults.filter((r) => r.error || !r.metrics?.length);
  if (crashed.length) problems.push(`${crashed.length} case(s) not evaluated`);

  const byEvaluator = new Map<string, Metric[]>();
  for (const [key, m] of current) {
    byEvaluator.set(m.evaluator, [...(byEvaluator.get(m.evaluator) ?? []), { ...m, rationale: key.split(' :: ')[0] + ' — ' + reasonOf(m) }]);
  }
  const rows: ScoreRow[] = [];
  for (const [evaluator, ms] of [...byEvaluator].sort()) {
    const scored = ms.filter((m) => m.status === 'PASS' || m.status === 'FAIL');
    const passed = scored.filter((m) => m.status === 'PASS').length;
    const rate = scored.length ? passed / scored.length : 1;
    const failed = scored.filter((m) => m.status === 'FAIL');
    const errored = ms.filter((m) => m.error).length;
    const isJudge = !evaluator.startsWith('custom/');
    const noVerdicts = errored > 0 && scored.length === 0; // e.g. the judge never answered: that is not a pass
    const blocked = noVerdicts || (isJudge ? rate < judgeMinPassRate : failed.length > 0);
    rows.push({ evaluator, isJudge, passed, scored: scored.length, errored, blocked, noVerdicts, failures: failed.map((m) => String(m.rationale)) });
    if (blocked) problems.push(noVerdicts ? `${evaluator}: no verdicts (all calls failed)` : `${evaluator}: ${failed.length} failing case(s)`);
  }

  let regressions: Regression[] | undefined;
  if (baselineResults) {
    const baseline = statuses(baselineResults);
    const perEvaluator = new Map<string, string[]>();
    for (const [key, now] of current) {
      if (baseline.get(key)?.status === 'PASS' && now.status === 'FAIL') {
        perEvaluator.set(now.evaluator, [...(perEvaluator.get(now.evaluator) ?? []), key.split(' :: ')[0]]);
      }
    }
    regressions = [...perEvaluator].map(([evaluator, caseIds]) => ({ evaluator, caseIds }));
    for (const r of regressions) problems.push(`regression in ${r.evaluator}`);
  }

  return { crashed, total: currentResults.length, rows, regressions, problems, blocked: problems.length > 0 };
}

/* ── Level 3: the judge against a human ─────────────────────────────────────── */

export interface Label { testCaseId: string; input?: unknown; output: string; context?: unknown[]; reference: { human: string; note?: string } }
export interface CalibrationCase {
  testCaseId: string;
  human: 'PASS' | 'FAIL';
  judge?: 'PASS' | 'FAIL';
  score?: unknown;
  skippedReason?: string;
  label: Label;
}
export interface Calibration {
  matrix: { PASS: { PASS: number; FAIL: number }; FAIL: { PASS: number; FAIL: number } };
  total: number;
  agreement: number;
  disagreements: string[];
  skipped: string[];
  cases: CalibrationCase[];
}

export function computeCalibration(results: Result[], labels: Label[], threshold?: number): Calibration {
  const human = new Map(labels.map((l) => [l.testCaseId, l]));
  const matrix = { PASS: { PASS: 0, FAIL: 0 }, FAIL: { PASS: 0, FAIL: 0 } };
  const disagreements: string[] = [];
  const skipped: string[] = [];
  const cases: CalibrationCase[] = [];
  for (const r of results) {
    const label = human.get(r.testCaseId);
    if (!label) continue;
    const h = label.reference.human as 'PASS' | 'FAIL';
    const m = r.metrics?.find((x) => x.evaluator.endsWith('faithfulness'));
    if (!m) {
      const why = 'no faithfulness result';
      skipped.push(`${r.testCaseId}: ${why}`);
      cases.push({ testCaseId: r.testCaseId, human: h, skippedReason: why, label });
      continue;
    }
    const judge = threshold !== undefined && typeof m.score === 'number' ? (m.score >= threshold ? 'PASS' : 'FAIL') : m.status;
    if (judge !== 'PASS' && judge !== 'FAIL') {
      let why = m.error
        ? String(m.error).replace(/\s+/g, ' ').replace(/^Evaluation of test case \S+ failed: /, '')
        : `status ${m.status ?? 'none'}, score ${JSON.stringify(m.score)}`;
      if (/No statements returned/i.test(why)) why = "an \"I don't know\" has no factual claims to judge; Level 2's deterministic check covers it";
      else if (/\b(503|429)\b/.test(why)) why = `Gemini ${why.includes('429') ? 'quota (429)' : 'overloaded (503)'}: re-run npm run eval:judge`;
      why = why.slice(0, 140);
      skipped.push(`${r.testCaseId}: ${why}`);
      cases.push({ testCaseId: r.testCaseId, human: h, score: m.score, skippedReason: why, label });
      continue;
    }
    matrix[h][judge]++;
    if (h !== judge) disagreements.push(`${r.testCaseId}: human ${h}, judge ${judge} (score ${m.score}) — "${label.output}"`);
    cases.push({ testCaseId: r.testCaseId, human: h, judge, score: m.score, label });
  }
  const total = matrix.PASS.PASS + matrix.PASS.FAIL + matrix.FAIL.PASS + matrix.FAIL.FAIL;
  const agreement = total ? (matrix.PASS.PASS + matrix.FAIL.FAIL) / total : 0;
  return { matrix, total, agreement, disagreements, skipped, cases };
}
