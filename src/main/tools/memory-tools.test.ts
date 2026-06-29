import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setMemoriesRootForTest } from '../services/okf-memory-store.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { recallTool, rememberTool } from './memory-tools.ts'

const noSignal = new AbortController().signal

async function run(tool: typeof rememberTool | typeof recallTool, args: unknown): Promise<string> {
  const result = await tool.execute(tool.parameters.parse(args) as never, noSignal)
  return typeof result === 'string' ? result : result.result
}

describe('memory-tools', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'okf-memory-tools-'))
    setMemoriesRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/proj')
  })

  afterEach(() => {
    setMemoriesRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('remember persists and recall returns the note', async () => {
    const saved = await run(rememberTool, {
      title: 'Lint',
      content: 'Run eslint with --fix',
      tags: ['lint'],
    })
    assert.match(saved, /Saved memory "Lint"/)

    const all = await run(recallTool, {})
    assert.match(all, /Found 1 memory/)
    assert.match(all, /## Lint \[lint\]/)
    assert.match(all, /Run eslint with --fix/)
  })

  it('recall filters by query and reports no matches', async () => {
    await run(rememberTool, { title: 'Auth', content: 'oauth tokens' })
    await run(rememberTool, { title: 'Cache', content: 'redis layer' })

    const hit = await run(recallTool, { query: 'redis' })
    assert.match(hit, /## Cache/)
    assert.doesNotMatch(hit, /## Auth/)

    const miss = await run(recallTool, { query: 'graphql' })
    assert.match(miss, /No memories match "graphql"/)
  })

  it('recall on an empty project explains how to add one', async () => {
    const empty = await run(recallTool, {})
    assert.match(empty, /No memories stored yet/)
  })
})
