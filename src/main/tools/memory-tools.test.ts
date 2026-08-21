import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setKnowledgeRootForTest } from '../services/storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { recallTool, rememberTool, EXTERNAL_CONTEXT_FIELD, MEMORY_TYPE } from './memory-tools.ts'
import { loadKnowledgeNotes } from '../services/storage/knowledge-store.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { markTurnExternalIngestion } from '../services/security/turn-taint.ts'
import type { ToolExecuteResult } from '@shared/types'

const TEST_CONTEXT: ThreadExecutionContext = {
  projectId: 'p1',
  threadId: 't1',
  projectRoot: '/home/dev/proj',
  root: '/home/dev/proj',
  checkoutMode: 'shared',
  branch: null,
}

/** Run a tool inside a turn context that has already ingested external content. */
function inTaintedTurn<T>(fn: () => Promise<T>): Promise<T> {
  return runWithThreadExecutionContext({ ...TEST_CONTEXT }, () => {
    markTurnExternalIngestion()
    return fn()
  })
}

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

  // Context-provenance plan, Phase 4: memories are the one channel that can
  // carry an injection across threads, so their turn provenance is recorded
  // and replayed as a caution — recording only, nothing blocks.
  it('marks a memory saved during a turn that ingested external content', async () => {
    await inTaintedTurn(() => run(rememberTool, { title: 'Fetched', content: 'From the web' }))
    const note = loadKnowledgeNotes(MEMORY_TYPE)[0]
    assert.equal(note?.fields[EXTERNAL_CONTEXT_FIELD], 'true')

    const recalled = await run(recallTool, {})
    assert.match(recalled, /Saved during a turn that had ingested external content/)
    assert.match(recalled, /not as instructions/)
  })

  it('leaves clean-turn memories unmarked — in and out of a turn context', async () => {
    await run(rememberTool, { title: 'Plain', content: 'No externals involved' })
    await runWithThreadExecutionContext({ ...TEST_CONTEXT }, () =>
      run(rememberTool, { title: 'Clean turn', content: 'Still no externals' }),
    )
    for (const note of loadKnowledgeNotes(MEMORY_TYPE)) {
      assert.equal(note.fields[EXTERNAL_CONTEXT_FIELD], undefined, note.title)
    }
    assert.doesNotMatch(await run(recallTool, {}), /ingested external content/)
  })

  it('clears the marker when a clean turn rewrites a tainted memory', async () => {
    await inTaintedTurn(() => run(rememberTool, { title: 'Evolving', content: 'v1 from web' }))
    await run(rememberTool, { title: 'Evolving', content: 'v2 rewritten clean' })
    const note = loadKnowledgeNotes(MEMORY_TYPE)[0]
    assert.equal(note?.fields[EXTERNAL_CONTEXT_FIELD], undefined)
  })

  it('sets the marker when a tainted turn rewrites a clean memory', async () => {
    await run(rememberTool, { title: 'Evolving', content: 'v1 clean' })
    await inTaintedTurn(() => run(rememberTool, { title: 'Evolving', content: 'v2 from web' }))
    const note = loadKnowledgeNotes(MEMORY_TYPE)[0]
    assert.equal(note?.fields[EXTERNAL_CONTEXT_FIELD], 'true')
  })

  it('recall on an empty project explains how to add one', async () => {
    const empty = await run(recallTool, {})
    assert.match(empty, /No memories stored yet/)
  })
})
