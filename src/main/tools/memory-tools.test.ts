import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setKnowledgeRootForTest } from '../services/storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { recallTool, rememberTool } from './memory-tools.ts'
import type { ToolExecuteResult } from '@shared/types'

const noSignal = new AbortController().signal

interface TestTool<T> {
  parameters: { parse(args: unknown): T }
  execute(args: T, signal: AbortSignal): ToolExecuteResult | Promise<ToolExecuteResult>
}

async function run<T>(tool: TestTool<T>, args: unknown): Promise<string> {
  const result = await tool.execute(tool.parameters.parse(args), noSignal)
  return typeof result === 'string' ? result : result.result
}

describe('memory-tools', () => {
  let knowledgeRoot: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    knowledgeRoot = mkdtempSync(join(tmpdir(), 'knowledge-'))
    setKnowledgeRootForTest(knowledgeRoot)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/proj')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(knowledgeRoot, { recursive: true, force: true })
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

  it('re-using a title updates the memory instead of duplicating it', async () => {
    await run(rememberTool, { title: 'Build', content: 'old body' })
    await run(rememberTool, { title: 'Build', content: 'new body' })

    const all = await run(recallTool, {})
    assert.match(all, /Found 1 memory/)
    assert.match(all, /new body/)
    assert.doesNotMatch(all, /old body/)
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
