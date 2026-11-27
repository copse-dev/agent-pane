import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const GATE = resolve('scripts/coverage-gate.mts')

function runGate(
  measured: number,
  baseline: number | Record<string, unknown>,
  args: string[] = [],
  eventName?: string,
  files: Record<string, { covered: number; total: number }> = {},
): { status: number | null; output: string; baseline: unknown } {
  // Real path: macOS's temp directory is a symlink, and the gate reads files
  // against its working directory as the OS resolves it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coverage-gate-')))
  try {
    mkdirSync(join(dir, 'coverage'))
    writeFileSync(
      join(dir, 'coverage/coverage-summary.json'),
      JSON.stringify({
        total: { lines: { pct: measured } },
        ...Object.fromEntries(
          Object.entries(files).map(([file, lines]) => [join(dir, file), { lines }]),
        ),
      }),
    )
    writeFileSync(
      join(dir, 'coverage-baseline.json'),
      JSON.stringify(typeof baseline === 'number' ? { lines: baseline } : baseline),
    )
    const env = { ...process.env }
    delete env['GITHUB_STEP_SUMMARY']
    delete env['GITHUB_EVENT_NAME']
    if (eventName !== undefined) env['GITHUB_EVENT_NAME'] = eventName
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

  it('fails a pull request but only warns on main and the nightly past the slack', () => {
    // Two in-slack PRs can together push main past it; failing main then
    // would turn every later PR's merge-result run red.
    assert.equal(runGate(93.32, 92.17, [], 'pull_request').status, 1)
    for (const event of ['push', 'schedule', 'merge_group']) {
      const result = runGate(93.32, 92.17, [], event)
      assert.equal(result.status, 0, event)
      assert.match(result.output, /Not failing a .* run/)
    }
    // A real regression still fails everywhere.
    assert.equal(runGate(91.9, 92.17, [], 'push').status, 1)
  })

  it('updates the baseline to just under the measured figure', () => {
    const result = runGate(92.42, 73.04, ['--update'])
    assert.equal(result.status, 0)
    assert.deepEqual(result.baseline, { lines: 92.17 })
    assert.equal(runGate(92.42, 92.17).status, 0)
  })

  it('prints areas, fails one under its floor, and writes floors on update', () => {
    const files = {
      'src/main/ipc/thread-handlers.ts': { covered: 30, total: 100 },
      'src/main/services/agent.ts': { covered: 95, total: 100 },
    }
    const below = runGate(
      92.2,
      { lines: 92.17, areas: { 'src/main/ipc': 40 } },
      [],
      undefined,
      files,
    )
    assert.equal(below.status, 1)
    assert.match(below.output, /\| `src\/main\/ipc` \| 70 \| 30\.00% \| 40% \| 1 \|/)
    assert.match(below.output, /src\/main\/ipc: 30\.00% is below its floor of 40%/)

    assert.equal(
      runGate(92.2, { lines: 92.17, areas: { 'src/main/ipc': 29.5 } }, [], undefined, files).status,
      0,
    )

    const updated = runGate(92.42, 73.04, ['--update'], undefined, files)
    assert.equal(updated.status, 0)
    assert.deepEqual(updated.baseline, {
      lines: 92.17,
      areas: { 'src/main/ipc': 29.5, 'src/main/services': 94.5 },
    })
  })

  it('keeps floors for areas an update did not measure', () => {
    const updated = runGate(
      92.42,
      { lines: 73.04, areas: { 'src/main/ipc': 31.63, 'src/main/windows': 82.35 } },
      ['--update'],
      undefined,
      { 'src/main/services/agent.ts': { covered: 95, total: 100 } },
    )
    assert.equal(updated.status, 0)
    assert.deepEqual(updated.baseline, {
      lines: 92.17,
      areas: { 'src/main/ipc': 31.63, 'src/main/services': 94.5, 'src/main/windows': 82.35 },
    })
  })
})
