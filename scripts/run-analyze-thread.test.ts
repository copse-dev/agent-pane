import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'node:test'

it('analyzes the same transcript with or without a package-manager separator and preserves failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copse-analyzer-cli-'))
  try {
    const transcript = join(dir, 'thread.jsonl')
    const scenario = join(dir, 'scenario.json')
    await writeFile(
      transcript,
      [
        { type: 'thread', title: 'CLI contract' },
        { type: 'message', role: 'user', content: 'Read the history.' },
        {
          type: 'message',
          role: 'assistant',
          content: 'Read the history.',
          toolCalls: [{ name: 'git_log', status: 'done', args: {}, result: 'A commit' }],
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    )
    await writeFile(
      scenario,
      JSON.stringify({ id: 'separator-contract', expect: { requireTools: ['git_log'] } }),
    )
    for (const separator of [[], ['--']]) {
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/run-analyze-thread.mts'), ...separator, transcript, scenario],
        { encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /"scenarioId": "separator-contract"/)
      assert.match(result.stdout, /"pass": true/)
    }
    await writeFile(
      scenario,
      JSON.stringify({ id: 'missing-tool', expect: { requireTools: ['git_diff'] } }),
    )
    const failed = spawnSync(
      process.execPath,
      [resolve('scripts/run-analyze-thread.mts'), '--', transcript, scenario],
      { encoding: 'utf8', timeout: 30_000 },
    )
    assert.equal(failed.status, 1, failed.stderr)
    assert.match(failed.stdout, /git_diff/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
