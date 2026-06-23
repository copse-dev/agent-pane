import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeToolExecuteResult } from '@shared/types'
import { clearStagedDiffsForTest, stageDiff } from '../services/diff-queue.ts'
import { readStagedDiffTool, stagedDiffsTool } from './staged-diff-tools.ts'

describe('staged diff inspection tools', () => {
  beforeEach(() => {
    clearStagedDiffsForTest()
  })

  afterEach(() => {
    clearStagedDiffsForTest()
  })

  it('lists pending proposed diffs', async () => {
    await stageDiff('index.html', 'old\n', 'new\n', 'html')
    const out = normalizeToolExecuteResult(
      await stagedDiffsTool.execute({}, new AbortController().signal),
    ).result
    assert.match(out, /Pending Copse staged diffs/)
    assert.match(out, /index\.html/)
    assert.match(out, /not written to disk/)
  })

  it('reads proposed after content for a pending diff', async () => {
    await stageDiff('index.html', 'old\n', 'new\n', 'html')
    const out = normalizeToolExecuteResult(
      await readStagedDiffTool.execute(
        { path: 'index.html', view: 'after', max_chars: 10_000 },
        new AbortController().signal,
      ),
    ).result
    assert.match(out, /Status: pending user approval/)
    assert.match(out, /--- after/)
    assert.match(out, /new/)
  })
})
