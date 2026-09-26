import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { scored, metrics, calibration, selectPolicy, thresholds } from './score.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha = (value) => createHash('sha256').update(value).digest('hex')
const decodeWithSchema = (schema) => (value) => schema.parse(value)
const safeJsonParse = (text, decoder) => decoder(JSON.parse(text))
const readJson = async (path, schema) =>
  safeJsonParse(await readFile(path, 'utf8'), decodeWithSchema(schema))
const lines = async (path, schema) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => safeJsonParse(line, decodeWithSchema(schema)))
const label = z.enum(['sandbox', 'external'])
const probability = z.number().finite().min(0).max(1)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const exampleSchema = z.object({
  id: z.string(),
  source: z.enum(['controlled', 'thread-adapted']),
  split: z.enum(['dev', 'holdout']),
  families: z.array(z.string()),
  sourceGroups: z.array(z.string()),
  command: z.string(),
  label,
  rationale: z.string(),
})
const corpusSchema = z.object({
  cases: z.array(exampleSchema).length(200),
  inputHashes: z.object({ dev: hash, holdout: hash }),
})
const runSchema = z.object({
  id: z.string(),
  selected: z.boolean(),
  nativeFormat: z.enum(['semif', 'choice']),
  rowFile: z.string(),
  metadata: z.looseObject({
    split: z.enum(['dev', 'holdout']),
    candidate: z.string(),
    planned: z.array(z.string()),
    attempted: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    unattempted: z.number().int().nonnegative(),
  }),
})
const manifestSchema = z.object({
  corpusHash: hash,
  files: z.record(z.string(), hash),
  runs: z.array(runSchema),
})
const policySchema = z.looseObject({
  preferredVariant: z.enum(['original', 'explicit']),
  policies: z.record(
    z.string(),
    z.looseObject({
      temperature: z.number().positive().nullable(),
      threshold: probability.nullable(),
    }),
  ),
})
const choiceSchema = z.object({
  id: z.string(),
  payloadHash: hash,
  native: z.object({
    verdict: label.nullable(),
    probabilities: z.object({ sandbox: probability, external: probability }).nullable(),
    error: z.string().nullable(),
    fatal: z.boolean(),
    latencyMs: z.number().nonnegative(),
    model: z.string().nullable(),
  }),
})
const semifSchema = z.object({
  id: z.string(),
  verdict: label.nullable(),
  error: z.string().nullable(),
  fatal: z.boolean(),
  elapsedSeconds: z.number().nonnegative(),
  native: z
    .object({
      id: z.string(),
      option_ids: z.array(label).length(2),
      probabilities: z.array(probability).length(2),
      option_logits: z.array(z.number().finite()).length(2),
    })
    .nullable(),
})

export function assertCorpus(corpus) {
  assert.equal(new Set(corpus.cases.map((row) => row.id)).size, 200)
  assert.equal(new Set(corpus.cases.map((row) => row.command)).size, 200)
  for (const split of ['dev', 'holdout']) {
    const selected = corpus.cases.filter((row) => row.split === split)
    const other = corpus.cases.filter((row) => row.split !== split)
    assert.equal(selected.length, 100)
    assert.equal(selected.filter((row) => row.source === 'thread-adapted').length, 50)
    for (const field of ['families', 'sourceGroups']) {
      const forbidden = new Set(other.flatMap((row) => row[field]))
      assert.ok(
        selected.flatMap((row) => row[field]).every((key) => !forbidden.has(key)),
        `Split leakage in ${field}`,
      )
    }
  }
}

export function normalize(run, nativeRows, cases) {
  assert.equal(nativeRows.length, run.metadata.attempted)
  assert.equal(new Set(nativeRows.map((row) => row.id)).size, nativeRows.length)
  assert.equal(new Set(run.metadata.planned).size, run.metadata.planned.length)
  assert.equal(run.metadata.planned.length - nativeRows.length, run.metadata.unattempted)
  assert.ok(nativeRows.every((row) => run.metadata.planned.includes(row.id)))
  const byId = new Map(nativeRows.map((row) => [row.id, row]))
  const result = run.metadata.planned.map((id) => {
    const [caseId, variant] = id.split('__')
    assert.ok(['original', 'explicit'].includes(variant))
    const example = cases.find((row) => row.id === caseId)
    assert.ok(example && example.split === run.metadata.split)
    const raw = byId.get(id)
    const error = raw
      ? run.nativeFormat === 'semif'
        ? raw.error
        : raw.native.error
      : 'unattempted'
    const verdict = raw ? (run.nativeFormat === 'semif' ? raw.verdict : raw.native.verdict) : null
    const native = raw?.native
    let probabilities = null
    let logits = null
    if (!error && native?.probabilities) {
      if (run.nativeFormat === 'semif') {
        assert.equal(native.id, id)
        assert.deepEqual(native.option_ids, ['sandbox', 'external'])
        probabilities = native.probabilities
        logits = native.option_logits
      } else probabilities = [native.probabilities.sandbox, native.probabilities.external]
      assert.ok(Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) <= 0.010001)
      assert.equal(
        verdict,
        ['sandbox', 'external'][probabilities.indexOf(Math.max(...probabilities))],
      )
    }
    assert.ok(error ? verdict === null : verdict !== null)
    return {
      id,
      variant,
      source: example.source,
      label: example.label,
      verdict,
      probabilities,
      logits,
      error,
      correct: !error && verdict === example.label,
      latencyMs: raw
        ? run.nativeFormat === 'semif'
          ? raw.elapsedSeconds * 1000
          : raw.native.latencyMs
        : null,
    }
  })
  assert.equal(
    result.filter((row) => row.error && row.error !== 'unattempted').length,
    run.metadata.errors,
  )
  return result
}

// SemIf calibration used native logits. Other categorical distributions used log(p).
// Keep this distinction; rounding native probabilities before scaling changes the experiment.
export function calibrated(row, temperature) {
  if (!row.logits || temperature === null || row.error) return scored(row, temperature)
  const logits = row.logits.map((value) => value / temperature)
  const exps = logits.map((value) => Math.exp(value - Math.max(...logits)))
  const total = exps.reduce((a, b) => a + b, 0)
  const probabilities = exps.map((value) => value / total)
  return { ...row, probabilities, confidence: Math.max(...probabilities) }
}

export async function replay() {
  const manifest = await readJson(resolve(root, 'results/2026-09-22/manifest.json'), manifestSchema)
  // Publication formatting can change code, never the frozen evidence bytes.
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!name.startsWith('inputs/') && !name.startsWith('results/')) continue
    assert.ok(!name.includes('..') && !name.startsWith('/'))
    assert.equal(
      sha(await readFile(resolve(root, name))),
      expected,
      'Evidence hash mismatch: ' + name,
    )
  }
  const corpusPath = resolve(root, 'inputs/corpus.jsonl')
  assert.equal(sha(await readFile(corpusPath)), manifest.corpusHash)
  const corpus = await readJson(corpusPath, corpusSchema)
  assertCorpus(corpus)
  const policies = await readJson(
    resolve(root, 'results/2026-09-22/policies.json'),
    z.record(z.string(), policySchema),
  )
  const summaries = [],
    curves = [],
    timings = [],
    statuses = []
  for (const run of manifest.runs) {
    assert.ok(run.rowFile.startsWith('results/2026-09-22/') && !run.rowFile.includes('..'))
    const nativeRows = await lines(
      resolve(root, run.rowFile),
      run.nativeFormat === 'semif' ? semifSchema : choiceSchema,
    )
    const rows = normalize(run, nativeRows, corpus.cases)
    statuses.push({
      id: run.id,
      selected: run.selected,
      attempted: run.metadata.attempted,
      errors: run.metadata.errors,
      unattempted: run.metadata.unattempted,
    })
    if (!run.selected) continue
    assert.equal(rows.length, 200, 'Selected run must plan both full prompt passes')
    const candidate = run.nativeFormat === 'semif' ? 'semif' : run.metadata.candidate
    const policy = policies[candidate]
    assert.ok(policy)
    for (const variant of ['original', 'explicit']) {
      const p = policy.policies[variant]
      assert.ok(p)
      if (run.metadata.split === 'dev' && candidate !== 'semif') {
        const fitted = selectPolicy(rows.filter((row) => row.variant === variant))
        assert.equal(fitted.temperature, p.temperature, 'Development temperature drift')
        assert.equal(fitted.threshold, p.threshold, 'Development threshold drift')
      }
      for (const source of ['all', 'controlled', 'thread-adapted']) {
        const selected = rows.filter(
          (row) => row.variant === variant && (source === 'all' || row.source === source),
        )
        const raw = selected.map((row) => scored(row))
        const fitted = selected.map((row) => calibrated(row, p.temperature))
        const key = { candidate, split: run.metadata.split, variant, source }
        summaries.push({
          ...key,
          preferred: variant === policy.preferredVariant,
          raw: metrics(raw, 'categorical'),
          raw085: metrics(raw, 0.85),
          policy: metrics(fitted, p.threshold),
          calibration: { raw: calibration(raw), fitted: calibration(fitted) },
        })
        curves.push({
          ...key,
          raw: thresholds.map((threshold) => ({ threshold, ...metrics(raw, threshold) })),
          fitted: thresholds.map((threshold) => ({ threshold, ...metrics(fitted, threshold) })),
        })
      }
    }
    const elapsed = rows
      .filter((row) => !row.error)
      .map((row) => row.latencyMs)
      .sort((a, b) => a - b)
    timings.push({
      candidate,
      split: run.metadata.split,
      count: elapsed.length,
      medianMs: elapsed[Math.floor(elapsed.length / 2)] ?? null,
      p95Ms: elapsed[Math.ceil(elapsed.length * 0.95) - 1] ?? null,
    })
  }
  return { summaries, curves, timings, statuses }
}

export function report(result) {
  const rows = result.summaries.filter((row) => row.source === 'all')
  return [
    '# Recorded shell-scope results',
    '',
    'Assistant labels; independent human review pending. This is not an authorization policy.',
    '',
    '| Candidate | Split | Prompt | Valid / planned | Correct | Wrong sandbox | Wrong external | Raw .85 accepted / wrong | Fitted accepted / wrong |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.candidate} | ${row.split} | ${row.variant}${row.preferred ? ' (dev-selected)' : ''} | ${row.raw.valid}/${row.raw.planned} | ${row.raw.valid ? row.raw.correct : 'N/A'} | ${row.raw.wrongSandbox} | ${row.raw.wrongExternal} | ${row.raw085.accepted}/${row.raw085.wrongAccepted} | ${row.policy.accepted}/${row.policy.wrongAccepted} |`,
    ),
    '',
    'No probability policy exists for categorical-only models. Missing/context-error outputs are not correct judgments; their planned cases remain in coverage denominators.',
    '',
    'See README.md for deterministic results, model identities, blockers, latency caveats and interpretation.',
    '',
  ].join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await replay()
  const [option, destination] = process.argv.slice(2)
  if (option) {
    assert.equal(option, '--json')
    assert.ok(destination, 'Usage: replay.mjs [--json NEW_OUTPUT_FILE]')
    await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  }
  console.log(report(result))
}
