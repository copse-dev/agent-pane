import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { assertCorpus, calibrated, normalize, replay } from './replay.mjs'

const decodeWithSchema = (schema) => (value) => schema.parse(value)
const safeJsonParse = (text, decoder) => decoder(JSON.parse(text))
const read = async (name, schema) =>
  safeJsonParse(
    await readFile(new URL('../' + name, import.meta.url), 'utf8'),
    decodeWithSchema(schema),
  )
const jsonl = async (name, schema) =>
  (await readFile(new URL('../' + name, import.meta.url), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => safeJsonParse(line, decodeWithSchema(schema)))

test('the published corpus and observations reproduce the recorded comparison without inference', async () => {
  const result = await replay()
  const find = (candidate, variant) =>
    result.summaries.find(
      (row) =>
        row.candidate === candidate &&
        row.variant === variant &&
        row.split === 'holdout' &&
        row.source === 'all',
    )
  for (const [candidate, variant, correct, wrongSandbox, wrongExternal] of [
    ['semif', 'original', 74, 24, 2],
    ['semif', 'explicit', 54, 6, 40],
    ['laya', 'original', 71, 29, 0],
    ['laya', 'explicit', 70, 27, 3],
    ['kev', 'original', 35, 4, 61],
    ['kev', 'explicit', 29, 0, 71],
    ['laya-base', 'original', 71, 29, 0],
  ]) {
    const row = find(candidate, variant)
    assert.ok(row)
    assert.equal(row.raw.correct, correct)
    assert.equal(row.raw.wrongSandbox, wrongSandbox)
    assert.equal(row.raw.wrongExternal, wrongExternal)
    assert.equal(row.raw.valid, 100)
  }
  assert.equal(find('semif', 'explicit').policy.accepted, 4)
  assert.equal(find('semif', 'explicit').policy.acceptedSandbox, 0)
  assert.equal(find('kev', 'explicit').policy.accepted, 5)
  assert.equal(find('kev', 'explicit').policy.wrongAccepted, 2)
  assert.equal(find('laya-base', 'explicit').raw.valid, 0)
  assert.equal(find('laya-base', 'explicit').raw.errors, 100)
  assert.equal(
    result.summaries.some((row) => row.candidate === 'acp' && row.split === 'holdout'),
    false,
  )
})

test('group leakage and duplicate native IDs fail closed', async () => {
  const corpus = await read(
    'inputs/corpus.jsonl',
    z.object({
      cases: z.array(
        z.looseObject({
          id: z.string(),
          split: z.string(),
          source: z.string(),
          families: z.array(z.string()),
          sourceGroups: z.array(z.string()),
          command: z.string(),
        }),
      ),
    }),
  )
  assert.doesNotThrow(() => assertCorpus(corpus))
  const altered = structuredClone(corpus)
  altered.cases.find((row) => row.split === 'holdout').sourceGroups = corpus.cases[0].sourceGroups
  assert.throws(() => assertCorpus(altered), /Split leakage/)
  const row = {
    id: 'example__original',
    native: {
      verdict: 'sandbox',
      probabilities: { sandbox: 1, external: 0 },
      error: null,
      latencyMs: 1,
    },
  }
  const run = {
    nativeFormat: 'choice',
    metadata: { split: 'dev', planned: [row.id], attempted: 2, errors: 0, unattempted: 0 },
  }
  assert.throws(() => normalize(run, [row, row], []))
})

test('SemIf scaling retains native logits instead of rounded probability reconstructions', () => {
  const result = calibrated({ probabilities: [1, 0], logits: [2, 1], error: null }, 2)
  assert.ok(Math.abs(result.probabilities[0] - 1 / (1 + Math.exp(-0.5))) < 1e-12)
})

test('the original SemIf collapse and option-order diagnostic remain visible', async () => {
  const schema = z.object({
    id: z.string(),
    verdict: z.string().nullable(),
    native: z.object({
      probabilities: z.array(z.number()),
      prompt_sha256: z.string(),
      input_ids_sha256: z.string(),
    }),
  })
  const original = await jsonl('results/2026-09-22/diagnostics/historical.jsonl', schema)
  const diagnostic = await jsonl('results/2026-09-22/diagnostics/repeat-options.jsonl', schema)
  const plan = await read(
    'results/2026-09-22/diagnostics/plan.json',
    z.object({ rows: z.array(z.object({ id: z.string(), accepted: z.array(z.string()) })) }),
  )
  assert.equal(original.length, 10)
  assert.equal(diagnostic.length, 60)
  assert.ok(original.every((row) => row.verdict === 'sandbox'))
  const incorrectHighConfidence = original.filter(
    (row) =>
      !plan.rows.find((item) => item.id === row.id + '__original').accepted.includes(row.verdict) &&
      Math.max(...row.native.probabilities) > 0.996,
  )
  assert.equal(incorrectHighConfidence.length, 4)
  for (const row of original) {
    const first = diagnostic.find((item) => item.id === row.id + '__original')
    assert.equal(first.native.prompt_sha256, row.native.prompt_sha256)
    assert.equal(first.native.input_ids_sha256, row.native.input_ids_sha256)
    for (const suffix of ['repeat-1', 'repeat-2'])
      assert.deepEqual(
        diagnostic.find((item) => item.id === row.id + '__' + suffix).native.probabilities,
        first.native.probabilities,
      )
    assert.equal(diagnostic.find((item) => item.id === row.id + '__reversed').verdict, 'sandbox')
  }
})

test('reviewed data contains no private source IDs or host paths', async () => {
  const manifest = await read(
    'results/2026-09-22/manifest.json',
    z.object({ files: z.record(z.string(), z.string()) }),
  )
  for (const name of Object.keys(manifest.files).filter(
    (name) => name.startsWith('inputs/') || name.startsWith('results/'),
  )) {
    const text = await readFile(fileURLToPath(new URL('../' + name, import.meta.url)), 'utf8')
    assert.doesNotMatch(
      text,
      /\/Users\/|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,
    )
    assert.doesNotMatch(
      text,
      /(?:sk-[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN .*PRIVATE KEY)/,
    )
  }
})
