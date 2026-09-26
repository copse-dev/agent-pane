// Exploratory only: fit a threshold on development disagreements, never holdout labels.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { replayCombinations } from './combine-recorded.mjs'
import { z } from './run.mjs'
import { thresholds } from './score.mjs'
const label = z.enum(['sandbox', 'external'])
const rowSchema = z.object({
  id: z.string(),
  label,
  deterministic: label,
  model: label.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
})
const schema = z.object({
  observations: z.array(
    z.object({
      candidate: z.string(),
      split: z.enum(['dev', 'holdout']),
      mode: z.string(),
      rows: z.array(z.unknown()),
    }),
  ),
})
export async function replayCascades(data) {
  const parsed = schema.parse(data ?? (await replayCombinations()))
  const groups = parsed.observations
    .filter((row) => row.mode === 'raw-veto')
    .map((group) => ({ ...group, rows: z.array(rowSchema).parse(group.rows) }))
  const candidates = groups.filter((row) => row.split === 'dev').map((row) => row.candidate)
  function relevant(row, direction) {
    return direction === 'veto'
      ? row.deterministic === 'sandbox' && row.model === 'external'
      : row.deterministic === 'external' && row.model === 'sandbox'
  }
  function accepted(row, threshold) {
    return threshold === 'categorical'
      ? row.model !== null
      : threshold !== null && row.confidence !== null && row.confidence >= threshold
  }
  function fit(dev, direction) {
    const pool = dev.filter((row) => relevant(row, direction))
    const probabilistic = dev.every((row) => row.confidence !== null)
    const choices = probabilistic ? thresholds : ['categorical']
    let policy = { threshold: null, developmentCorrections: 0, developmentIntroduced: 0 }
    // Maximize corrections subject to zero newly introduced errors; ties keep the higher numeric threshold.
    for (const threshold of choices) {
      const selected = pool.filter((row) => accepted(row, threshold))
      const errors = selected.filter((row) => row.model !== row.label).length
      if (errors || selected.length === 0) continue
      if (
        selected.length > policy.developmentCorrections ||
        (selected.length === policy.developmentCorrections &&
          typeof threshold === 'number' &&
          typeof policy.threshold === 'number' &&
          threshold > policy.threshold)
      ) {
        policy = {
          threshold,
          developmentCorrections: selected.length,
          developmentIntroduced: errors,
        }
      }
    }
    return policy
  }
  function evaluate(rows, policies, mode) {
    const changes = []
    const predictions = rows.map((row) => {
      const direction = relevant(row, 'veto')
        ? 'veto'
        : relevant(row, 'override')
          ? 'override'
          : null
      const change =
        direction !== null &&
        (mode === 'both' || mode === direction) &&
        accepted(row, policies[direction].threshold)
      const prediction = change ? row.model : row.deterministic
      if (change)
        changes.push({ id: row.id, label: row.label, from: row.deterministic, to: prediction })
      return { ...row, prediction }
    })
    return {
      correct: predictions.filter((row) => row.label === row.prediction).length,
      wrongSandbox: predictions.filter(
        (row) => row.label === 'external' && row.prediction === 'sandbox',
      ).length,
      wrongExternal: predictions.filter(
        (row) => row.label === 'sandbox' && row.prediction === 'external',
      ).length,
      corrected: changes.filter((row) => row.label === row.to).length,
      introduced: changes.filter((row) => row.label === row.from).length,
      changes,
    }
  }
  assert.equal(
    fit(
      [{ id: '1', deterministic: 'sandbox', model: 'external', label: 'sandbox', confidence: 1 }],
      'veto',
    ).threshold,
    null,
  )
  assert.equal(
    fit(
      [
        {
          id: '1',
          deterministic: 'sandbox',
          model: 'external',
          label: 'external',
          confidence: 0.98,
        },
      ],
      'veto',
    ).threshold,
    0.975,
  )
  assert.equal(
    fit(
      [
        {
          id: '1',
          deterministic: 'external',
          model: 'sandbox',
          label: 'sandbox',
          confidence: null,
        },
      ],
      'override',
    ).threshold,
    'categorical',
  )
  const output = []
  for (const candidate of candidates) {
    const dev = groups.find((group) => group.candidate === candidate && group.split === 'dev').rows
    const policy = { veto: fit(dev, 'veto'), override: fit(dev, 'override') }
    for (const split of ['dev', 'holdout']) {
      const group = groups.find((group) => group.candidate === candidate && group.split === split)
      if (!group) continue
      for (const mode of ['veto', 'override', 'both']) {
        const metrics = evaluate(group.rows, policy, mode)
        if (split === 'dev') assert.equal(metrics.introduced, 0)
        output.push({ candidate, split, mode, policy, ...metrics })
      }
    }
  }
  return {
    note: 'Post-hoc exploratory cascade; standalone development-selected prompts and temperatures retained, additional thresholds selected using development rows only. No new inference or authority.',
    rows: output,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await replayCascades()
  const jsonIndex = process.argv.indexOf('--json')
  if (jsonIndex !== -1) {
    assert.ok(process.argv[jsonIndex + 1], '--json requires a new output path')
    await writeFile(resolve(process.argv[jsonIndex + 1]), JSON.stringify(output, null, 2) + '\n', {
      flag: 'wx',
    })
  }
  console.log(JSON.stringify(output, null, 2))
}
