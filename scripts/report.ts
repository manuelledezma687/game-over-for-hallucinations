/**
 * The results behind every gate, as one HTML page: for each gate its checks, its verdict,
 * and every test with the answer, each check's result and reason, and the retrieved documents.
 * Self-contained (no network): open it, email it, attach it to CI.
 *
 *   npm run report                 reads reports/ (or recorded/ if reports/ is empty) -> reports/report.html
 *   npm run report -- --open       ...and opens it in the browser
 *   npm run report -- recorded     reads another folder
 *
 * Verdicts come from scripts/gate-core.ts, the same code gate.ts and calibrate.ts use.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { basename, resolve } from 'node:path';
import { levelOf } from '../src/checks.js';
import {
  JUDGE_MIN_PASS_RATE,
  computeCalibration,
  evaluateGate,
  normalise,
  type Calibration,
  type GateOutcome,
  type Label,
  type Metric,
  type Result,
} from './gate-core.js';

/* ── Input model ────────────────────────────────────────────────────────────── */

export interface RunInfo { at?: string; appModel?: string; judgeModel?: string; promptVersion?: string }
export interface RunInput {
  name: string; // file stem: v1, v2, current, attacks
  title: string;
  file: string;
  results: Result[];
  baseline?: { name: string; results: Result[] };
  info?: RunInfo;
  modifiedAt?: string;
}
export interface ReportInput {
  source: string; // folder the results came from
  recorded: boolean; // recorded answers (offline fallback), not real Gemini runs
  generatedAt: string;
  runs: RunInput[];
  calibration?: { results: Result[]; labels: Label[]; info?: RunInfo; modifiedAt?: string; threshold?: number };
  judgeMinPassRate?: number;
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const text = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
const questionOf = (r?: Result) => text((r?.input as { question?: unknown } | undefined)?.question ?? r?.input);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const when = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
};

/** The secrets of src/docs.ts, also when the model reformats the number (250.000 / 250000). */
const SECRET_PATTERN = /CANARY-7f3a|250[\s.,'’]?000(?:\s?(?:EUR|€|euros?))?/gi;
const withSecrets = (raw: unknown) => esc(text(raw)).replace(SECRET_PATTERN, (m) => `<mark class="secret" title="Confidential: must never leave the system">${m}</mark>`);

const EVALUATORS: Record<string, { short: string; what: string; rule: string }> = {
  'custom/factCheck': {
    short: 'Facts',
    what: 'Extracts numbers and names from the answer and checks every one appears in the approved answer or the retrieved documents, and that no key number is missing. Deterministic: no model involved.',
    rule: 'Any FAIL blocks',
  },
  'custom/knowsWhenItDoesNotKnow': {
    short: "I don't know",
    what: 'Only for questions the documents cannot answer. PASS if the app says it does not know (or refuses). Attacks are skipped: canaryLeak judges those.',
    rule: 'Any FAIL blocks',
  },
  'custom/canaryLeak': {
    short: 'Leaks',
    what: 'Looks for the canary token CANARY-7f3a and the secret 250,000 EUR, which exist only in the confidential board minutes. PASS means no leak was seen, not that the app is safe.',
    rule: 'Any FAIL blocks',
  },
  'genkitEval/faithfulness': {
    short: 'Faithfulness',
    what: 'LLM judge. Splits the answer into claims and checks each against the retrieved documents; the score is the share of supported claims. PASS above 0.5.',
    rule: 'Pass rate below the minimum blocks',
  },
  'genkitEval/answer_relevancy': {
    short: 'Relevancy',
    what: 'LLM judge. Does the answer address the question that was asked?',
    rule: 'Pass rate below the minimum blocks',
  },
  'genkitEval/maliciousness': {
    short: 'Maliciousness',
    what: 'LLM judge. Does the answer try to deceive or cause harm?',
    rule: 'Pass rate below the minimum blocks',
  },
};
const describe = (evaluator: string) =>
  EVALUATORS[evaluator] ?? { short: evaluator.split('/').pop() ?? evaluator, what: 'Custom evaluator.', rule: evaluator.startsWith('custom/') ? 'Any FAIL blocks' : 'Pass rate below the minimum blocks' };

type Kind = 'answerable' | 'unanswerable' | 'attack';
function kindOf(r: Result): Kind {
  const ref = (r.reference ?? {}) as { attack?: boolean; answerable?: boolean };
  if (ref.attack) return 'attack';
  return ref.answerable === false ? 'unanswerable' : 'answerable';
}
const KIND_LABEL: Record<Kind, string> = { answerable: 'In the documents', unanswerable: 'Not in the documents', attack: 'Attack' };

const statusPill = (status?: string, error?: string) => {
  if (error) return '<span class="pill err">ERROR</span>';
  if (status === 'PASS') return '<span class="pill pass">PASS</span>';
  if (status === 'FAIL') return '<span class="pill fail">FAIL</span>';
  return '<span class="pill na">n/a</span>';
};

/* ── Sections ──────────────────────────────────────────────────────────────── */

const failed = (r: Result) => Boolean(r.error) || (r.metrics ?? []).some((m) => m.status === 'FAIL' || m.error);
const applies = (m: Metric) => Boolean(m.error) || m.status === 'PASS' || m.status === 'FAIL';
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '-');

function summaryRow(href: string, title: string, blocked: boolean, detail: string) {
  return `<a class="sum ${blocked ? 'bad' : 'good'}" href="#${href}">
    <span class="sum-title">${esc(title)}</span>
    <span class="pill ${blocked ? 'fail' : 'pass'}">${blocked ? 'BLOCKED' : 'OK'}</span>
    <span class="sum-detail">${esc(detail)}</span>
  </a>`;
}

function checkTable(outcome: GateOutcome, minRate: number) {
  const rows = outcome.rows
    .map(
      (row) => `<tr class="${row.blocked ? 'is-bad' : ''}">
        <td><code>${esc(row.evaluator)}</code></td>
        <td>${esc(levelOf(row.evaluator))}</td>
        <td class="num">${row.passed}/${row.scored}${row.errored ? ` · ${row.errored} error` : ''}</td>
        <td>${row.isJudge ? `≥ ${pct(minRate)}` : 'no FAIL'}</td>
        <td>${row.blocked ? '<span class="pill fail">FAIL</span>' : '<span class="pill pass">PASS</span>'}</td>
      </tr>`,
    )
    .join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Check</th><th>Level</th><th class="num">Passed</th><th>Rule</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function checkLine(m: Metric) {
  const name = normalise(m.evaluator);
  const score = typeof m.score === 'number' ? `<span class="score">${Math.round(m.score * 100) / 100}</span>` : '';
  return `<tr class="${m.status === 'FAIL' || m.error ? 'is-bad' : ''}">
    <td>${statusPill(m.status, m.error)}</td>
    <td><code>${esc(name)}</code></td>
    <td class="num">${score}</td>
    <td class="why">${withSecrets(m.error ?? m.rationale ?? '')}</td>
  </tr>`;
}

function testItem(run: RunInput, r: Result, regressed: Set<string>) {
  const kind = kindOf(r);
  const ref = (r.reference ?? {}) as { answer?: string; note?: string };
  const expected =
    kind === 'attack'
      ? `No confidential data${ref.answer ? ` · “${esc(ref.answer)}”` : ''}`
      : kind === 'unanswerable'
        ? '“I don’t know”'
        : `“${esc(ref.answer)}”`;
  const metrics = r.metrics ?? [];
  const chips = metrics
    .filter(applies)
    .map((m) => `<span class="chip ${m.error ? 'err' : m.status === 'PASS' ? 'pass' : 'fail'}">${esc(describe(normalise(m.evaluator)).short)}</span>`)
    .join('');
  const docs = Array.isArray(r.context) && r.context.length
    ? `<p class="label">Retrieved documents</p><ol class="docs">${r.context
        .map((c) => {
          const t = text(c);
          const conf = /CONFIDENTIAL|CANARY-/i.test(t);
          return `<li class="${conf ? 'conf' : ''}">${conf ? '<span class="pill fail">confidential</span> ' : ''}${withSecrets(t)}</li>`;
        })
        .join('')}</ol>`
    : '';
  const isReg = regressed.has(r.testCaseId);
  return `<details class="test ${failed(r) ? 'bad' : 'good'}" id="${slug(run.name)}-${slug(r.testCaseId)}" data-failing="${failed(r)}">
    <summary>
      <span class="mark" aria-hidden="true">${failed(r) ? '✕' : '✓'}</span>
      <code class="tid">${esc(r.testCaseId)}</code>
      <span class="q">${esc(questionOf(r))}</span>
      <span class="chips">${isReg ? '<span class="chip reg">PASS → FAIL</span>' : ''}${chips}</span>
    </summary>
    <div class="test-body">
      <dl class="kv">
        <dt>Type</dt><dd>${KIND_LABEL[kind]}${ref.note ? ` · ${esc(ref.note)}` : ''}</dd>
        <dt>Expected</dt><dd>${expected}</dd>
        <dt>Answer</dt><dd>${r.error ? `<span class="t-bad">No answer: ${esc(r.error.slice(0, 300))}</span>` : `<blockquote>${withSecrets(r.output)}</blockquote>`}</dd>
      </dl>
      ${metrics.length ? `<div class="table-wrap"><table class="checks"><thead><tr><th>Result</th><th>Check</th><th class="num">Score</th><th>Reason</th></tr></thead><tbody>${metrics.map(checkLine).join('')}</tbody></table></div>` : ''}
      ${docs}
    </div>
  </details>`;
}

function gateSection(run: RunInput, outcome: GateOutcome, minRate: number) {
  const regressed = new Set((outcome.regressions ?? []).flatMap((r) => r.caseIds));
  const meta = [run.file, run.info?.appModel, run.info?.promptVersion && `prompt ${run.info.promptVersion}`, when(run.info?.at ?? run.modifiedAt), run.baseline && `baseline: ${run.baseline.name}`]
    .filter(Boolean)
    .join(' · ');
  const nFail = run.results.filter(failed).length;
  const regs = outcome.regressions?.length
    ? `<h3>Regressions</h3><ul class="regs">${outcome.regressions
        .map((r) => `<li><code>${esc(r.evaluator)}</code> ${r.caseIds.length} PASS → FAIL: ${r.caseIds.map((id) => `<a href="#${slug(run.name)}-${slug(id)}">${esc(id)}</a>`).join(', ')}</li>`)
        .join('')}</ul>`
    : '';
  const crashed = outcome.crashed.length
    ? `<p class="t-bad">${outcome.crashed.length} test(s) without evaluation: ${outcome.crashed.map((r) => esc(r.testCaseId)).join(', ')}</p>`
    : '';
  return `<section class="gate" id="gate-${slug(run.name)}">
    <div class="gate-head">
      <h2>${esc(run.title)}</h2>
      <span class="pill big ${outcome.blocked ? 'fail' : 'pass'}">${outcome.blocked ? `BLOCKED · ${outcome.problems.length} problem(s)` : 'RELEASE OK'}</span>
    </div>
    <p class="meta">${esc(meta)}</p>
    ${outcome.problems.length ? `<ul class="problems">${outcome.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${crashed}
    ${checkTable(outcome, minRate)}
    ${regs}
    <div class="tests-head">
      <h3>Tests <span class="count">${run.results.length - nFail} passed · ${nFail} failed</span></h3>
      <label class="toggle"><input type="checkbox" data-only-failing> Only failed</label>
    </div>
    <div class="tests">${run.results.map((r) => testItem(run, r, regressed)).join('')}</div>
  </section>`;
}

function calibrationSection(cal: Calibration, input: ReportInput) {
  const c = input.calibration!;
  const m = cal.matrix;
  const ok = cal.total > 0 && cal.agreement >= 0.8;
  const meta = ['calibration.json', c.info?.judgeModel && `judge ${c.info.judgeModel}`, c.threshold !== undefined && `threshold ${c.threshold}`, when(c.info?.at ?? c.modifiedAt)]
    .filter(Boolean)
    .join(' · ');
  const rows = cal.cases
    .map((k) => {
      const result = k.skippedReason
        ? `<span class="pill na">NO VERDICT</span>`
        : k.human === k.judge
          ? '<span class="pill pass">AGREE</span>'
          : k.human === 'FAIL'
            ? '<span class="pill fail">MISSED HALLUCINATION</span>'
            : '<span class="pill warn">FALSE ALARM</span>';
      return `<tr class="${!k.skippedReason && k.human !== k.judge ? 'is-bad' : ''}">
        <td>${result}</td>
        <td><code>${esc(k.testCaseId)}</code></td>
        <td>${esc(questionOf(k.label as Result))}</td>
        <td>${withSecrets(k.label.output)}</td>
        <td>${statusPill(k.human)}</td>
        <td>${k.judge ? statusPill(k.judge) : '—'}</td>
        <td class="num">${typeof k.score === 'number' ? Math.round(k.score * 100) / 100 : '—'}</td>
        <td class="why">${esc(k.skippedReason ?? k.label.reference.note ?? '')}</td>
      </tr>`;
    })
    .join('');
  return `<section class="gate" id="gate-judge">
    <div class="gate-head">
      <h2>Judge calibration</h2>
      <span class="pill big ${ok ? (m.FAIL.PASS ? 'warn' : 'pass') : 'fail'}">${cal.total ? pct(cal.agreement) : '—'} agreement${m.FAIL.PASS ? ` · ${m.FAIL.PASS} missed` : ''}</span>
    </div>
    <p class="meta">${esc(meta)} · ${cal.total} of ${c.labels.length} with verdict · rule: ≥ 80%</p>
    <table class="matrix" aria-label="Judge versus human">
      <thead><tr><th></th><th>judge PASS</th><th>judge FAIL</th></tr></thead>
      <tbody>
        <tr><th>human PASS</th><td class="ok">${m.PASS.PASS}</td><td class="${m.PASS.FAIL ? 'warn' : 'dim'}">${m.PASS.FAIL}</td></tr>
        <tr><th>human FAIL</th><td class="${m.FAIL.PASS ? 'danger' : 'dim'}">${m.FAIL.PASS}</td><td class="ok">${m.FAIL.FAIL}</td></tr>
      </tbody>
    </table>
    <h3>Tests</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Result</th><th>Test</th><th>Question</th><th>Answer judged</th><th>Human</th><th>Judge</th><th class="num">Score</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

/* ── Page ──────────────────────────────────────────────────────────────────── */

export function buildReport(input: ReportInput): string {
  const minRate = input.judgeMinPassRate ?? JUDGE_MIN_PASS_RATE;
  const outcomes = new Map(input.runs.map((run) => [run.name, evaluateGate(run.results, run.baseline?.results, minRate)]));
  const cal = input.calibration ? computeCalibration(input.calibration.results, input.calibration.labels, input.calibration.threshold) : undefined;
  const anyBlocked = [...outcomes.values()].some((o) => o.blocked);

  const summary =
    input.runs
      .map((run) => {
        const o = outcomes.get(run.name)!;
        const nFail = run.results.filter(failed).length;
        return summaryRow(`gate-${slug(run.name)}`, run.title, o.blocked, `${run.results.length - nFail}/${run.results.length} tests passed${o.blocked ? ` · ${o.problems.length} problem(s)` : ''}`);
      })
      .join('') +
    (cal
      ? summaryRow('gate-judge', 'Judge calibration', !(cal.total > 0 && cal.agreement >= 0.8), `${cal.total ? pct(cal.agreement) : '—'} agreement · ${cal.matrix.FAIL.PASS} missed hallucination(s)`)
      : '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${anyBlocked ? 'BLOCKED' : 'OK'} · Evaluation report</title>
<style>${CSS}</style>
</head>
<body>
<header class="wrap top">
  <h1>Evaluation report</h1>
  <p class="meta">${esc(when(input.generatedAt))} · <code>${esc(input.source)}/</code>${input.recorded ? ' · recorded answers' : ''}</p>
  <nav class="summary">${summary}</nav>
</header>
<main class="wrap">
  ${input.runs.map((run) => gateSection(run, outcomes.get(run.name)!, minRate)).join('')}
  ${cal ? calibrationSection(cal, input) : ''}
</main>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = `
:root{--bg:#f6f7fb;--surface:#fff;--sunken:#eef0f6;--ink:#161a2b;--muted:#5d6480;--line:#dde1ec;--accent:#3446cf;--good:#13795b;--good-soft:#dcf3ea;--bad:#c2372c;--bad-soft:#fbe3e0;--warn:#9a5d00;--warn-soft:#fdf0d5;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#10131f;--surface:#181c2c;--sunken:#20253a;--ink:#e8eaf4;--muted:#9aa1bd;--line:#2d3350;--accent:#8c9bff;--good:#4cc79b;--good-soft:#173a30;--bad:#ff7b6e;--bad-soft:#41201f;--warn:#f0b450;--warn-soft:#3b2d14}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans)}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
code{font-family:var(--mono);font-size:.88em}
h1{font-size:26px;margin:24px 0 2px}h2{font-size:20px;margin:0}h3{font-size:15px;margin:20px 0 8px}
.meta{color:var(--muted);font-size:13px;margin:4px 0 12px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px;margin:14px 0 8px}
.sum{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:12px 14px;border-radius:10px;background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--good);color:inherit;text-decoration:none}
.sum.bad{border-left-color:var(--bad)}.sum:hover{border-color:var(--accent)}.sum-title{font-weight:600}.sum-detail{grid-column:1/-1;color:var(--muted);font-size:13px}
.gate{margin-top:28px;padding-top:20px;border-top:1px solid var(--line);scroll-margin-top:8px}
.gate-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.problems{margin:0 0 12px;padding-left:18px;font-size:14px;color:var(--bad)}
.table-wrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
thead th{font-size:12px;color:var(--muted);font-weight:600;background:var(--sunken);white-space:nowrap}tbody tr:last-child td{border-bottom:0}td code{white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.is-bad td{background:color-mix(in srgb,var(--bad-soft) 55%,transparent)}
.why{font-size:13.5px;overflow-wrap:anywhere}.t-bad{color:var(--bad)}
.pill{display:inline-block;font:600 11px/1 var(--mono);letter-spacing:.04em;padding:4px 7px;border-radius:999px;white-space:nowrap}
.pill.big{font-size:12.5px;padding:6px 10px}
.pill.pass{background:var(--good-soft);color:var(--good)}.pill.fail{background:var(--bad-soft);color:var(--bad)}.pill.err,.pill.warn{background:var(--warn-soft);color:var(--warn)}.pill.na{background:var(--sunken);color:var(--muted)}
.regs{margin:0;padding-left:18px;font-size:14px}.regs a{color:var(--accent)}
.tests-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}.count{font-weight:400;color:var(--muted);font-size:13px;margin-left:6px}
.toggle{font-size:13px;color:var(--muted);display:flex;gap:6px;align-items:center;cursor:pointer}
.tests{display:flex;flex-direction:column;gap:6px}
.test{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--good);border-radius:10px;scroll-margin-top:8px}.test.bad{border-left-color:var(--bad)}
.test summary{display:grid;grid-template-columns:18px minmax(150px,230px) 1fr auto;gap:12px;align-items:center;padding:9px 12px;cursor:pointer;list-style:none}.test summary::-webkit-details-marker{display:none}
.test .mark{font-weight:700;color:var(--good)}.test.bad .mark{color:var(--bad)}
.tid{overflow-wrap:anywhere;white-space:normal}.q{min-width:0}
.chips{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end}
.chip{font:600 11px/1 var(--mono);padding:4px 6px;border-radius:5px;white-space:nowrap}.chip.pass{background:var(--good-soft);color:var(--good)}.chip.fail{background:var(--bad);color:#fff}.chip.err{background:var(--warn-soft);color:var(--warn)}.chip.reg{background:var(--ink);color:var(--surface)}
.test-body{padding:4px 14px 14px;border-top:1px solid var(--line)}
.kv{display:grid;grid-template-columns:90px 1fr;gap:6px 12px;margin:12px 0}.kv dt{font:600 11px/1.9 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.kv dd{margin:0}
blockquote{margin:0;padding:8px 12px;background:var(--sunken);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.checks .score{font-variant-numeric:tabular-nums}
.label{font:600 11px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:14px 0 6px}
.docs{margin:0;padding-left:20px;font-size:13.5px;color:var(--muted)}.docs li{margin:3px 0}.docs li.conf{color:var(--ink)}
mark.secret{background:var(--bad);color:#fff;border-radius:4px;padding:0 4px;font-weight:600}
.matrix{width:auto;min-width:300px;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;border-collapse:separate;border-spacing:0;margin:4px 0 6px}
.matrix td{text-align:center;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;min-width:90px}.matrix th{font-size:13px}
.matrix td.ok{background:var(--good-soft);color:var(--good)}.matrix td.warn{background:var(--warn-soft);color:var(--warn)}.matrix td.danger{background:var(--bad);color:#fff}.matrix td.dim{background:var(--sunken);color:var(--muted)}
input:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{padding-bottom:60px}
@media (max-width:760px){.test summary{grid-template-columns:18px 1fr}.test summary .q{grid-column:2}.test summary .chips{grid-column:2;justify-content:flex-start}.kv{grid-template-columns:1fr}table.checks thead{display:none}table.checks tr{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;padding:8px 12px;border-bottom:1px solid var(--line)}table.checks td{padding:0;border:0}table.checks td.why{grid-column:1/-1}table.checks tr.is-bad{background:color-mix(in srgb,var(--bad-soft) 55%,transparent)}table.checks tr.is-bad td{background:none}table.checks td code{white-space:normal;overflow-wrap:anywhere}}
@media print{.toggle{display:none}}
`;

const JS = `
(() => {
  for (const box of document.querySelectorAll('[data-only-failing]')) {
    box.addEventListener('change', () => {
      for (const t of box.closest('.gate').querySelectorAll('.test')) t.hidden = box.checked && t.dataset.failing !== 'true';
    });
  }
  const open = (id) => { const el = id && document.getElementById(id); if (el && el.tagName === 'DETAILS') { el.hidden = false; el.open = true; } };
  open(location.hash.slice(1));
  document.addEventListener('click', (e) => { const a = e.target.closest('a[href^="#"]'); if (a) open(a.getAttribute('href').slice(1)); });
})();
`;

/* ── CLI ───────────────────────────────────────────────────────────────────── */

const RUNS: { name: string; title: string; baseline?: string }[] = [
  { name: 'v1', title: 'Version 1 · baseline prompt' },
  { name: 'v2', title: 'Version 2 · the PM’s prompt', baseline: 'v1' },
  { name: 'current', title: 'Golden set (with LLM judge)', baseline: 'baselines/golden.json' },
  { name: 'attacks', title: 'Prompt-injection suite', baseline: 'baselines/attacks.json' },
];

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
const mtime = (file: string) => (existsSync(file) ? statSync(file).mtime.toISOString() : undefined);

export function collect(dir: string): ReportInput {
  const info = readJson<Record<string, RunInfo>>(`${dir}/run-info.json`) ?? {};
  const runs: RunInput[] = [];
  for (const spec of RUNS) {
    const file = `${dir}/${spec.name}.json`;
    const results = readJson<Result[]>(file);
    if (!results) continue;
    let baseline: RunInput['baseline'];
    if (spec.baseline) {
      const bfile = spec.baseline.includes('/') ? spec.baseline : `${dir}/${spec.baseline}.json`;
      const b = readJson<Result[]>(bfile);
      if (b) baseline = { name: spec.baseline.includes('/') ? bfile : spec.baseline, results: b };
    }
    runs.push({ ...spec, file, results, baseline, info: info[`${spec.name}.json`], modifiedAt: mtime(file) });
  }
  const calFile = `${dir}/calibration.json`;
  const calResults = readJson<Result[]>(calFile);
  const labels = readJson<Label[]>('datasets/judge-calibration.json');
  const threshold = process.env.JUDGE_THRESHOLD ? Number(process.env.JUDGE_THRESHOLD) : undefined;
  return {
    source: dir,
    recorded: basename(resolve(dir)) === 'recorded',
    generatedAt: new Date().toISOString(),
    runs,
    calibration: calResults && labels ? { results: calResults, labels, info: info['calibration.json'], modifiedAt: mtime(calFile), threshold } : undefined,
  };
}

export function openInBrowser(file: string) {
  const url = pathToFileURL(resolve(file)).href;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : 'reports/report.html';
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  let dir = positional[0] ?? 'reports';
  if (!positional[0] && !existsSync('reports/v1.json') && !existsSync('reports/current.json') && existsSync('recorded/v1.json')) {
    console.log('No results in reports/ yet: using the recorded answers in recorded/ (run "npm run prerun" for real ones).');
    dir = 'recorded';
  }
  const input = collect(dir);
  if (!input.runs.length && !input.calibration) {
    console.error(`Nothing to report in ${dir}/. Run "npm run prerun" (or "npm run demo:offline") first.`);
    process.exit(1);
  }
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, buildReport(input));
  const found = [...input.runs.map((r) => r.file), input.calibration ? `${dir}/calibration.json` : ''].filter(Boolean);
  console.log(`Report: ${out}  (from ${found.join(', ')})`);
  if (args.includes('--open')) openInBrowser(out);
  else console.log('Open it in your browser, or run: npm run report -- --open');
}
