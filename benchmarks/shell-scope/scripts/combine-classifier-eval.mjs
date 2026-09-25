// Combine the recorded deterministic scope verdicts with one model's
// `eval:classifier` output, on both splits. Every threshold or weight is fitted
// on development data only and then applied unchanged to the holdout.
//
//   node benchmarks/shell-scope/scripts/combine-classifier-eval.mjs <dev.jsonl> <holdout.jsonl>
//
// The deterministic verdict projects `ambiguous` to external, which reproduces the
// recorded baseline (holdout 87 correct, 3 wrong sandbox, 10 wrong external).
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { corpus } from './run.mjs'
import { QUESTION_ID } from './classifier-fixtures.mjs'

const GRID = Array.from({ length: 99 }, (_, index) => (index + 1) / 100)
const WEIGHTS = Array.from({ length: 21 }, (_, index) => index / 20)

/** Deterministic verdict as a probability of external: ambiguous sits between. */
export function deterministicProbability(verdict) {
  return verdict === 'sandbox' ? 0 : verdict === 'external' ? 1 : 0.5
}

/**
 * Every strategy maps (deterministic verdict, model P(external)) to a verdict.
 * `params` carries the fitted values; strategies without any ignore it.
 */
export const STRATEGIES = {
  'deterministic alone': () => (d) => (d === 'sandbox' ? 'sandbox' : 'external'),
  'model alone (P ≥ 0.5)': () => (_d, p) => (p >= 0.5 ? 'external' : 'sandbox'),
  // Filter first: the deterministic external stands; the model may only add a warning.
  'filter: deterministic external final, model can add external (P ≥ 0.5)': () => (d, p) =>
    d !== 'sandbox' || p >= 0.5 ? 'external' : 'sandbox',
  'filter: deterministic external final, model can add external (dev-fitted P)':
    ({ upgrade }) =>
    (d, p) =>
      d !== 'sandbox' || p >= upgrade ? 'external' : 'sandbox',
  // Filter first the other way: the deterministic sandbox stands; the model may only relax.
  'filter: deterministic sandbox final, model can relax external (P < 0.5)': () => (d, p) =>
    d === 'sandbox' || p < 0.5 ? 'sandbox' : 'external',
  'sum: equal weights, external at ≥ 0.5': () => (d, p) =>
    (deterministicProbability(d) + p) / 2 >= 0.5 ? 'external' : 'sandbox',
  'sum: dev-fitted weight and threshold':
    ({ weight, threshold }) =>
    (d, p) =>
      weight * deterministicProbability(d) + (1 - weight) * p >= threshold ? 'external' : 'sandbox',
}

export function metrics(rows, decide) {
  let correct = 0
  let wrongSandbox = 0
  let wrongExternal = 0
  let external = 0
  for (const row of rows) {
    const verdict = row.p === null ? null : decide(row.deterministic, row.p)
    if (row.label === 'external') external++
    if (verdict === row.label) correct++
    else if (row.label === 'external') wrongSandbox++
    else wrongExternal++
  }
  const sandbox = rows.length - external
  return {
    correct,
    wrongSandbox,
    wrongExternal,
    balancedAccuracy:
      ((external - wrongSandbox) / external + (sandbox - wrongExternal) / sandbox) / 2,
  }
}

/** Best on development data by balanced accuracy, then by fewer wrong-sandbox errors. */
function better(a, b) {
  return (
    !b ||
    a.balancedAccuracy > b.balancedAccuracy + 1e-12 ||
    (Math.abs(a.balancedAccuracy - b.balancedAccuracy) <= 1e-12 && a.wrongSandbox < b.wrongSandbox)
  )
}

export function fit(dev) {
  let upgradeBest
  let upgrade = 0.5
  for (const value of GRID) {
    const scored = metrics(
      dev,
      STRATEGIES['filter: deterministic external final, model can add external (dev-fitted P)']({
        upgrade: value,
      }),
    )
    if (better(scored, upgradeBest)) [upgradeBest, upgrade] = [scored, value]
  }
  let sumBest
  let weight = 0.5
  let threshold = 0.5
  for (const w of WEIGHTS) {
    for (const t of GRID) {
      const scored = metrics(
        dev,
        STRATEGIES['sum: dev-fitted weight and threshold']({ weight: w, threshold: t }),
      )
      if (better(scored, sumBest)) [sumBest, weight, threshold] = [scored, w, t]
    }
  }
  return { upgrade, weight, threshold }
}

async function rowsFor(file, verdicts, labels) {
  const text = await readFile(file, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const record = JSON.parse(line)
      const caseId = String(record.id).split('__')[0]
      const answer = record.error ? null : record.result?.answers?.[QUESTION_ID]
      const p = answer?.type === 'choice' ? (answer.probabilities?.external ?? null) : null
      return { deterministic: verdicts.get(caseId), label: labels.get(caseId), p }
    })
}

export async function main([devFile, holdoutFile] = process.argv.slice(2)) {
  if (!devFile || !holdoutFile) {
    console.error('Usage: combine-classifier-eval.mjs <dev-eval.jsonl> <holdout-eval.jsonl>')
    return 2
  }
  const deterministic = JSON.parse(
    await readFile(resolve(corpus, '../results/2026-09-22/deterministic.json'), 'utf8'),
  )
  const verdicts = new Map(deterministic.rows.map((row) => [row.id, row.scope.verdict]))
  const dataset = JSON.parse(await readFile(resolve(corpus, 'corpus.jsonl'), 'utf8'))
  const labels = new Map(dataset.cases.map((entry) => [entry.id, entry.label]))
  const dev = await rowsFor(devFile, verdicts, labels)
  const holdout = await rowsFor(holdoutFile, verdicts, labels)
  const params = fit(dev)
  console.log(
    `Dev-fitted: add-external P ≥ ${params.upgrade}; sum weight ${params.weight} on deterministic, external at ≥ ${params.threshold}`,
  )
  console.log('')
  console.log(
    '| Strategy | Dev correct | Dev wrong sandbox / wrong external | Dev balanced | Holdout correct | Holdout wrong sandbox / wrong external | Holdout balanced |',
  )
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const [name, make] of Object.entries(STRATEGIES)) {
    const decide = make(params)
    const d = metrics(dev, decide)
    const h = metrics(holdout, decide)
    console.log(
      `| ${name} | ${d.correct} | ${d.wrongSandbox} / ${d.wrongExternal} | ${d.balancedAccuracy.toFixed(3)} | ${h.correct} | ${h.wrongSandbox} / ${h.wrongExternal} | ${h.balancedAccuracy.toFixed(3)} |`,
    )
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
