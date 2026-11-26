import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const GATE = resolve('scripts/coverage-gate.mts')

function runGate(
  measured: number,
  baseline: number,
  args: string[] = [],
): { status: number | null; output: string; baseline: unknown } {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-gate-'))
  try {
    mkdirSync(join(dir, 'coverage'))
    writeFileSync(
      join(dir, 'coverage/coverage-summary.json'),
      JSON.stringify({ total: { lines: { pct: measured } } }),
    )
    writeFileSync(join(dir, 'coverage-baseline.json'), JSON.stringify({ lines: baseline }))
    const env = { ...process.env }
    delete env['GITHUB_STEP_SUMMARY']
    const result = spawnSync(process.execPath, [GATE, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env,
    })
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      baseline: JSON.parse(readFileSync(join(dir, 'coverage-baseline.json'), 'utf8')) as unknown,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('coverage gate', () => {
  it('passes within the allowed slack', () => {
    assert.equal(runGate(92.4, 92.17).status, 0)
  })

  it('fails a drop below the baseline', () => {
    const result = runGate(91.9, 92.17)
    assert.equal(result.status, 1)
    assert.match(result.output, /regressed/)
  })

  it('fails when the baseline trails measured coverage by more than the slack', () => {
    // #4391: a 73% bar under a 92% suite let large regressions through.
    const result = runGate(92.2, 73.04)
    assert.equal(result.status, 1)
    assert.match(result.output, /coverage:update/)
  })

  it('updates the baseline to just under the measured figure', () => {
    const result = runGate(92.42, 73.04, ['--update'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.baseline, { lines: 92.17 })
    assert.equal(runGate(92.42, 92.17).status, 0)
  })
})
