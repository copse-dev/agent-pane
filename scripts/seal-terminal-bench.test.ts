import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, describe, it } from 'node:test'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fixture(contents = 'safe trace data'): string {
  const root = mkdtempSync(join(tmpdir(), 'copse-terminal-seal-'))
  roots.push(root)
  const trial = join(root, 'bench-results', 'terminal-bench', 'job', 'trial')
  mkdirSync(join(trial, 'agent'), { recursive: true })
  writeFileSync(
    join(trial, 'result.json'),
    JSON.stringify({
      task_name: 'debug-task',
      started_at: '2026-07-21T10:00:00Z',
      finished_at: '2026-07-21T10:01:00Z',
      exception_info: null,
      verifier_result: { rewards: { reward: 0 } },
      agent_result: { metadata: {} },
    }),
  )
  writeFileSync(join(trial, 'agent', 'copse-trace.jsonl'), contents)
  return root
}

function runSeal(root: string, extraEnv: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [resolve('scripts/seal-terminal-bench.mts')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, COPSE_BENCH_RUN_ID: 'test-run', ...extraEnv },
  })
}

describe('terminal benchmark capsule sealing', () => {
  it('writes a per-trial archive and a digest-bearing suite index', () => {
    const root = fixture()
    const sealed = runSeal(root)
    assert.equal(sealed.status, 0, String(sealed.stderr))

    const capsules = join(root, 'bench-results', 'terminal-bench-capsules')
    const index: unknown = JSON.parse(readFileSync(join(capsules, 'index.json'), 'utf8'))
    assert.equal(typeof index, 'object')
    const entries =
      typeof index === 'object' && index !== null
        ? (index as Record<string, unknown>)['capsules']
        : undefined
    assert.ok(Array.isArray(entries))
    assert.equal(entries.length, 1)
    const entry = (entries as unknown[])[0]
    assert.equal(typeof entry, 'object')
    const archive =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['archive']
        : undefined
    const digest =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['sha256']
        : undefined
    assert.equal(typeof archive, 'string')
    assert.match(String(digest), /^[a-f0-9]{64}$/)
    assert.ok(readFileSync(join(capsules, String(archive))).length > 0)
  })

  it('refuses to seal a trial that leaked a configured secret', () => {
    const secret = 'test-secret-value-123456'
    const root = fixture(`tool output accidentally contained ${secret}`)
    const sealed = runSeal(root, { SCW_GENERATIVE_API_KEY: secret })
    assert.notEqual(sealed.status, 0)
    assert.match(String(sealed.stderr), /contains SCW_GENERATIVE_API_KEY/)
    assert.doesNotMatch(String(sealed.stderr), new RegExp(secret))
  })
})
