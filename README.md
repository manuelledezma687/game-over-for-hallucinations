# Game Over for Hallucinations

**5 levels to test your Gemini app before your users do** — demo code for the DevFest Linz session.
An HR assistant built with [Genkit](https://genkit.dev) + Gemini, and the tests that keep it honest.

```bash
npm install
cp .env.example .env && export GEMINI_API_KEY=...
npm run dev            # Genkit Dev UI: datasets, evaluations, traces (localhost:4000)
```

### On the day of the talk

```bash
npm run prerun         # BEFORE the talk, with network: real Gemini runs of v1 and v2 + judge -> reports/
npm run demo           # ON STAGE: 7 steps, Enter = next. Reads reports/, never waits for the network
npm run demo:offline   # backup: same 7 steps with recorded answers
npm run demo -- --step 5   # jump to a step if time is short
```

| Step | Shows | Level |
|---|---|---|
| 1 | The app answers "25 days" in the Dev UI, trace with retrieved docs | — |
| 2 | assertEquals rejects the right answer, factCheck rejects the wrong one | 1 |
| 3 | Version 1: all green | 2 |
| 4 | The one-line prompt change the PM asked for | — |
| 5 | Gate: BLOCKED, regressions, what broke level by level | 1, 2, 4, 5 |
| 6 | Judge vs human: where the judge let hallucinations through | 3 |
| 7 | Production guardrail stops the leak; incident becomes a golden case | Boss |

## The levels

| Level | Technique | Where | Run |
|---|---|---|---|
| 1 | assertEquals fails on LLM text — but **facts** are still verifiable | `src/facts.ts`, `src/checks.ts` (`custom/factCheck`) | `npm test` |
| 2 | A **golden set**: approved answers, unanswerable questions, real incidents | `datasets/golden.json` | `npm run eval` |
| 3 | An **LLM judge** (Gemini via `genkitEval`) — and **calibrating** it against human labels | `src/index.ts`, `datasets/judge-calibration.json`, `scripts/calibrate.ts` | `npm run eval:judge && npm run calibrate` |
| 4 | **Attack your own app**: direct & indirect prompt injection, canary tokens | `datasets/attacks.json`, `custom/canaryLeak` | `npm run eval:attacks` |
| 5 | **Pipeline gate**: block on failures and on PASS → FAIL regressions | `scripts/gate.ts`, `.github/workflows/llm-evals.yml` | `npm run gate` |
| Boss | **Production**: guardrail on every answer, Firebase Genkit Monitoring, incidents → golden cases | `hrAssistant` flow, `ENABLE_FIREBASE_TELEMETRY` | — |

Break it on purpose: `PROMPT_VERSION=v2 GUARD=off npm run eval && npm run gate`.

## Power-ups checklist

- [ ] Assert on facts (numbers, names, "I don't know", secrets), never on wording
- [ ] 20–50 golden cases, including questions the app must **not** answer
- [ ] Every production incident becomes a golden case (see `bug-2026-031-…`)
- [ ] LLM judge stronger than the app model, calibrated on ≥ 10 human-labelled cases
- [ ] Re-calibrate when the judge model, prompt or threshold changes
- [ ] Canary token in the system prompt and confidential docs; injection suite incl. indirect attacks
- [ ] Gate the PR: deterministic checks block on any FAIL, judge metrics on pass rate, everything on regressions
- [ ] Treat prompt, model and document changes as releases
- [ ] Cheapest checks also run in production; monitor and sample real traffic

## Honest limits

The deterministic checks only see numbers, capitalised names, abstentions and known secrets.
German capitalises every noun, so prefer the judge for names in German. The LLM judge is a model
too: measure it before trusting it. None of this proves the app is correct; it catches regressions early.

MIT © 2026 Manuel Ledezma
