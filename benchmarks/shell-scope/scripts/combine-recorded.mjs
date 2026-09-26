// Offline, post-hoc scope-prediction analysis. Never invokes a fixture or a model.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replay, normalize, calibrated } from './replay.mjs'
import { z, safeJsonParse, decodeWithSchema } from './run.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = async (path, schema) =>
  safeJsonParse(await readFile(path, 'utf8'), decodeWithSchema(schema))
const label = z.enum(['sandbox', 'external'])
const probability = z.number().min(0).max(1)
const casesSchema = z.object({
  cases: z.array(
    z.looseObject({
      id: z.string(),
      split: z.enum(['dev', 'holdout']),
      label,
      command: z.string(),
      source: z.string(),
    }),
  ),
})
const runSchema = z.looseObject({
  id: z.string(),
  selected: z.boolean(),
  nativeFormat: z.enum(['choice', 'semif']),
  rowFile: z.string(),
  metadata: z.looseObject({
    candidate: z.string(),
    split: z.enum(['dev', 'holdout']),
    planned: z.array(z.string()),
    attempted: z.number(),
    errors: z.number(),
    unattempted: z.number(),
  }),
})
const choiceSchema = z.looseObject({
  id: z.string(),
  native: z.looseObject({
    verdict: label.nullable(),
    probabilities: z.object({ sandbox: probability, external: probability }).nullable(),
    error: z.string().nullable(),
    latencyMs: z.number(),
  }),
})
const semifSchema = z.looseObject({
  id: z.string(),
  verdict: label.nullable(),
  error: z.string().nullable(),
  elapsedSeconds: z.number(),
  native: z
    .looseObject({
      id: z.string(),
      option_ids: z.array(label),
      probabilities: z.array(probability),
      option_logits: z.array(z.number()),
    })
    .nullable(),
})
const policiesSchema = z.record(
  z.string(),
  z.object({
    preferredVariant: z.enum(['original', 'explicit']),
    policies: z.record(
      z.string(),
      z.object({
        temperature: z.number().positive().nullable(),
        threshold: probability.nullable(),
      }),
    ),
  }),
)
const deterministicSchema = z.object({
  rows: z.array(
    z.looseObject({
      id: z.string(),
      scope: z.looseObject({ verdict: z.enum(['sandbox', 'external', 'ambiguous']) }),
    }),
  ),
})

export function combine(d, model, mode, accepted) {
  const fallback = d === 'sandbox' ? 'sandbox' : 'external'
  switch (mode) {
    case 'raw-veto':
      return model === 'external' ? 'external' : fallback
    case 'raw-override':
      return model === 'sandbox' ? 'sandbox' : fallback
    case 'confidence-veto':
      return accepted && model === 'external' ? 'external' : fallback
    case 'confidence-override':
      return accepted && model === 'sandbox' ? 'sandbox' : fallback
    case 'confidence-replace':
      return accepted && model !== null ? model : fallback
    case 'ambiguous-only':
      return d === 'ambiguous' && model !== null ? model : fallback
    case 'agreement-abstain':
      return model === fallback ? fallback : null
    default:
      throw new Error('Unknown combination mode')
  }
}

// Exhaustive truth-table checks for the two binary combinations, plus abstention/fallback.
let assertions = 0
for (const d of ['sandbox', 'external'])
  for (const m of ['sandbox', 'external']) {
    assert.equal(
      combine(d, m, 'raw-veto', false),
      d === 'external' || m === 'external' ? 'external' : 'sandbox',
    )
    assertions++
    assert.equal(
      combine(d, m, 'raw-override', false),
      d === 'sandbox' || m === 'sandbox' ? 'sandbox' : 'external',
    )
    assertions++
    for (const mode of ['confidence-veto', 'confidence-override', 'confidence-replace']) {
      assert.equal(combine(d, m, mode, false), d)
      assertions++
    }
  }
assert.equal(combine('ambiguous', 'sandbox', 'ambiguous-only', false), 'sandbox')
assertions++
assert.equal(combine('sandbox', 'external', 'ambiguous-only', false), 'sandbox')
assertions++
assert.equal(combine('sandbox', 'external', 'agreement-abstain', false), null)
assertions++
assert.equal(combine('sandbox', null, 'raw-veto', false), 'sandbox')
assertions++
assert.equal(combine('external', null, 'raw-override', false), 'external')
assertions++
assert.equal(combine('sandbox', 'external', 'confidence-replace', true), 'external')
assertions++

export async function replayCombinations() {
  // Verify frozen file hashes and reproduce the original scoring before joining rows.
  const verified = await replay()
  const { cases } = await read(resolve(root, 'inputs/corpus.jsonl'), casesSchema)
  const { runs } = await read(
    resolve(root, 'results/2026-09-22/manifest.json'),
    z.object({ runs: z.array(runSchema) }),
  )
  const policies = await read(resolve(root, 'results/2026-09-22/policies.json'), policiesSchema)
  const deterministic = await read(
    resolve(root, 'results/2026-09-22/deterministic.json'),
    deterministicSchema,
  )
  const dById = new Map(deterministic.rows.map((row) => [row.id, row.scope.verdict]))
  assert.equal(dById.size, 200)
  assert.ok(cases.every((row) => dById.has(row.id)))

  function summarize(rows) {
    const wrongSandbox = rows.filter(
      (row) => row.label === 'external' && row.prediction === 'sandbox',
    )
    const wrongExternal = rows.filter(
      (row) => row.label === 'sandbox' && row.prediction === 'external',
    )
    const changed = rows.filter((row) => row.prediction !== row.deterministic)
    return {
      planned: rows.length,
      correct: rows.filter((row) => row.label === row.prediction).length,
      wrongSandbox: wrongSandbox.length,
      wrongExternal: wrongExternal.length,
      abstained: rows.filter((row) => row.prediction === null).length,
      sandboxPredictions: rows.filter((row) => row.prediction === 'sandbox').length,
      changed: changed.length,
      corrected: changed.filter((row) => row.label === row.prediction).length,
      introduced: changed.filter(
        (row) => row.prediction !== null && row.label === row.deterministic,
      ).length,
      wrongSandboxIds: wrongSandbox.map((row) => row.id),
      wrongExternalIds: wrongExternal.map((row) => row.id),
    }
  }
  const baselines = ['dev', 'holdout'].map((split) => {
    const rows = cases
      .filter((row) => row.split === split)
      .map((row) => {
        const d = dById.get(row.id) === 'sandbox' ? 'sandbox' : 'external'
        return { ...row, deterministic: d, prediction: d }
      })
    const summary = summarize(rows)
    assert.deepEqual(
      [summary.correct, summary.wrongSandbox, summary.wrongExternal],
      split === 'dev' ? [76, 16, 8] : [87, 3, 10],
    )
    return { split, ...summary }
  })
  const combinations = [],
    observations = [],
    selectedModels = new Map()
  const modes = [
    'raw-veto',
    'raw-override',
    'confidence-veto',
    'confidence-override',
    'confidence-replace',
    'ambiguous-only',
    'agreement-abstain',
  ]
  for (const run of runs.filter((row) => row.selected)) {
    const candidate = run.nativeFormat === 'semif' ? 'semif' : run.metadata.candidate
    const frozen = policies[candidate]
    const policy = frozen.policies[frozen.preferredVariant]
    const nativeSchema = run.nativeFormat === 'semif' ? semifSchema : choiceSchema
    const nativeRows = (await readFile(resolve(root, run.rowFile), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => safeJsonParse(line, decodeWithSchema(nativeSchema)))
    const normalized = normalize(run, nativeRows, cases)
      .filter((row) => row.variant === frozen.preferredVariant)
      .map((row) => calibrated(row, policy.temperature))
    assert.equal(normalized.length, 100)
    const modelById = new Map(normalized.map((row) => [row.id.split('__')[0], row]))
    const splitCases = cases.filter((row) => row.split === run.metadata.split)
    assert.ok(splitCases.every((row) => modelById.has(row.id)))
    selectedModels.set(`${candidate}:${run.metadata.split}`, modelById)
    const original = verified.summaries.find(
      (row) =>
        row.candidate === candidate &&
        row.split === run.metadata.split &&
        row.preferred &&
        row.source === 'all',
    )
    assert.equal(normalized.filter((row) => row.correct).length, original.raw.correct)
    const accepted = normalized.filter(
      (row) =>
        policy.threshold !== null && row.confidence !== null && row.confidence >= policy.threshold,
    )
    assert.equal(accepted.length, original.policy.accepted)
    for (const mode of modes) {
      const rows = splitCases.map((example) => {
        const model = modelById.get(example.id)
        const rawD = dById.get(example.id)
        const confident =
          !model.error &&
          policy.threshold !== null &&
          model.confidence !== null &&
          model.confidence >= policy.threshold
        return {
          ...example,
          deterministic: rawD === 'sandbox' ? 'sandbox' : 'external',
          rawDeterministic: rawD,
          model: model.verdict,
          confidence: model.confidence,
          confident,
          prediction: combine(rawD, model.verdict, mode, confident),
        }
      })
      const summary = {
        candidate,
        split: run.metadata.split,
        variant: frozen.preferredVariant,
        mode,
        ...summarize(rows),
      }
      if (mode === 'raw-veto' || mode === 'confidence-veto') {
        assert.ok(
          summary.wrongSandbox <=
            baselines.find((row) => row.split === run.metadata.split).wrongSandbox,
        )
      }
      combinations.push(summary)
      observations.push({ candidate, split: run.metadata.split, mode, rows })
    }
  }

  // Five votes: deterministic + one checkpoint each of SemIf, Laya typed, Kev, OpenJev.
  // Exclude Laya base so the same family is not given a duplicate vote. Claude lacks holdout.
  const majorityCandidates = ['semif', 'laya', 'kev', 'openjev']
  for (const split of ['dev', 'holdout']) {
    const rows = cases
      .filter((row) => row.split === split)
      .map((example) => {
        const d = dById.get(example.id) === 'sandbox' ? 'sandbox' : 'external'
        const votes = [
          d,
          ...majorityCandidates.map(
            (candidate) => selectedModels.get(`${candidate}:${split}`).get(example.id).verdict,
          ),
        ]
        assert.ok(votes.every((vote) => vote !== null))
        return {
          ...example,
          deterministic: d,
          votes,
          prediction:
            votes.filter((vote) => vote === 'sandbox').length >= 3 ? 'sandbox' : 'external',
        }
      })
    combinations.push({
      candidate: 'four-local-models+determinism',
      split,
      variant: 'dev-selected per model',
      mode: 'majority',
      ...summarize(rows),
    })
    observations.push({ candidate: 'four-local-models+determinism', split, mode: 'majority', rows })
  }
  const output = {
    note: 'Exploratory post-hoc classification only. No fixture execution, new inference, authorization change, new thresholds, or independent validation.',
    assertions,
    baselines,
    combinations,
    observations,
  }
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await replayCombinations()
  const jsonIndex = process.argv.indexOf('--json')
  if (jsonIndex !== -1) {
    assert.ok(process.argv[jsonIndex + 1], '--json requires a new output path')
    await writeFile(resolve(process.argv[jsonIndex + 1]), JSON.stringify(output, null, 2) + '\n', {
      flag: 'wx',
    })
  }
  console.log(JSON.stringify({ ...output, observations: undefined }, null, 2))
}
