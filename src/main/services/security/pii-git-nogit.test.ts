import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localPromptCommitSpans } from './pii-git-references.ts'

it('keeps a candidate redacted instead of throwing when git cannot be spawned', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'copse-pii-nogit-'))
  const previous = process.env['PATH']
  process.env['PATH'] = dir
  try {
    assert.deepEqual(await localPromptCommitSpans(`Inspect ${'a'.repeat(40)}.`, dir), [])
  } finally {
    process.env['PATH'] = previous
    await rm(dir, { recursive: true, force: true })
  }
})
