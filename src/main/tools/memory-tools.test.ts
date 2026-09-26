import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setKnowledgeRootForTest } from '../services/storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import {
  recallTool,
  rememberTool,
  EXTERNAL_CONTEXT_FIELD,
  MEMORY_TYPE,
  RECALL_ALL_MAX_CHARS,
  RECALL_ALL_MAX_MEMORIES,
} from './memory-tools.ts'
import { addKnowledgeNote, loadKnowledgeNotes } from '../services/storage/knowledge-store.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import {
  markTurnExternalIngestion,
  turnIngestedExternalContent,
} from '../services/security/turn-taint.ts'
import { storageSet } from '../services/storage/storage.ts'
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

  // A clean turn can still carry tainted text forward (it may have read the
  // memory's file, or recalled it in an earlier turn), so an agent rewrite
  // never clears the marker. Only a user edit in the Memories pane does.
  it('keeps the marker when a clean turn rewrites a tainted memory', async () => {
    await inTaintedTurn(() => run(rememberTool, { title: 'Evolving', content: 'v1 from web' }))
    await runWithThreadExecutionContext({ ...TEST_CONTEXT }, () =>
      run(rememberTool, { title: 'Evolving', content: 'v2 rewritten clean' }),
    )
    await run(rememberTool, { title: 'Evolving', content: 'v3 outside a turn' })
    const notes = loadKnowledgeNotes(MEMORY_TYPE)
    assert.equal(notes.length, 1)
    const note = at(notes, 0)
    assert.equal(note.body.trim(), 'v3 outside a turn')
    assert.equal(note.fields[EXTERNAL_CONTEXT_FIELD], 'true')
  })

  it('taints the turn that recalls a tainted memory', async () => {
    await inTaintedTurn(() => run(rememberTool, { title: 'Fetched', content: 'From the web' }))

    await runWithThreadExecutionContext({ ...TEST_CONTEXT }, async () => {
      assert.equal(turnIngestedExternalContent(), false)
      await run(recallTool, { query: 'web' })
      assert.equal(turnIngestedExternalContent(), true)
      // Copying the recalled text under a new title does not launder it.
      await run(rememberTool, { title: 'Copied', content: 'From the web, restated' })
    })

    const copied = loadKnowledgeNotes(MEMORY_TYPE).find((note) => note.title === 'Copied')
    assert.equal(copied?.fields[EXTERNAL_CONTEXT_FIELD], 'true')
  })

  it('leaves the turn clean when it recalls only clean memories', async () => {
    await run(rememberTool, { title: 'Plain', content: 'No externals involved' })

    await runWithThreadExecutionContext({ ...TEST_CONTEXT }, async () => {
      await run(recallTool, {})
      assert.equal(turnIngestedExternalContent(), false)
    })
  })

  it('caps an unfiltered recall and says how to reach the rest', async () => {
    const total = RECALL_ALL_MAX_MEMORIES + 5
    for (let i = 0; i < total; i++) {
      addKnowledgeNote({
        type: MEMORY_TYPE,
        title: `Memory ${String(i)}`,
        body: `body ${String(i)}`,
      })
    }

    const all = await run(recallTool, {})

    assert.match(all, new RegExp(`Found ${String(total)} memories`))
    assert.equal(all.match(/^## /gm)?.length, RECALL_ALL_MAX_MEMORIES)
    assert.match(
      all,
      new RegExp(
        `Output truncated: showing ${String(RECALL_ALL_MAX_MEMORIES)} of ${String(total)} memories; 5 not shown`,
      ),
    )
    assert.match(all, /Call recall with a query/)
    // A query still reaches a memory past the cap.
    const last = `Memory ${String(total - 1)}`
    assert.match(await run(recallTool, { query: last }), new RegExp(`## ${last}`))
  })

  it('caps an unfiltered recall by size as well as by count', async () => {
    const big = 'x'.repeat(RECALL_ALL_MAX_CHARS / 2)
    for (const title of ['One', 'Two', 'Three']) {
      addKnowledgeNote({ type: MEMORY_TYPE, title, body: big })
    }

    const all = await run(recallTool, {})

    assert.ok(all.length < RECALL_ALL_MAX_CHARS + 1_000, String(all.length))
    assert.match(all, /Output truncated: showing 1 of 3 memories; 2 not shown/)
  })

  it('does not taint the turn for a tainted memory the cap left out', async () => {
    const big = 'x'.repeat(RECALL_ALL_MAX_CHARS)
    addKnowledgeNote({ type: MEMORY_TYPE, title: 'Shown', body: big })
    await inTaintedTurn(() => run(rememberTool, { title: 'Hidden', content: 'From the web' }))

    await runWithThreadExecutionContext({ ...TEST_CONTEXT }, async () => {
      const all = await run(recallTool, {})
      assert.doesNotMatch(all, /## Hidden/)
      assert.equal(turnIngestedExternalContent(), false)
    })
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

  describe('after the user switches projects mid-run', () => {
    beforeEach(() => {
      storageSet('projects', [
        { id: 'p1', path: '/home/dev/proj', name: 'proj' },
        { id: 'p2', path: '/home/dev/other', name: 'other' },
      ])
      storageSet('activeProjectId', 'p2')
    })

    afterEach(() => {
      storageSet('projects', [])
      storageSet('activeProjectId', null)
    })

    // TEST_CONTEXT is a turn in p1, the project the user has switched away from.
    it("remembers and recalls in the thread's own project", async () => {
      await runWithThreadExecutionContext({ ...TEST_CONTEXT }, () =>
        run(rememberTool, { title: 'P1 fact', content: 'belongs to p1' }),
      )

      assert.match(await run(recallTool, {}), /No memories stored yet/, 'active project p2')
      const recalled = await runWithThreadExecutionContext({ ...TEST_CONTEXT }, () =>
        run(recallTool, {}),
      )
      assert.match(recalled, /## P1 fact/)
    })
  })
})
