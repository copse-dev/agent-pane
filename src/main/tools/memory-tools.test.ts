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

  describe('revisions, provenance and paging', () => {
    it('assigns revision 1 and bumps it on update by title', async () => {
      const first = await run(rememberTool, { title: 'A', content: 'one' })
      assert.match(first, /revision 1/)
      const second = await run(rememberTool, { title: 'A', content: 'two' })
      assert.match(second, /revision 2/)
      assert.equal(loadKnowledgeNotes(MEMORY_TYPE).length, 1)
    })

    it('rejects a stale expectedRevision and leaves the note untouched', async () => {
      await run(rememberTool, { title: 'A', content: 'one' })
      const note = loadKnowledgeNotes(MEMORY_TYPE)[0]
      assert.ok(note)
      await run(rememberTool, { id: note.id, title: 'A', content: 'two', expectedRevision: 1 })
      const stale = await run(rememberTool, {
        id: note.id,
        title: 'A',
        content: 'three',
        expectedRevision: 1,
      })
      assert.match(stale, /Not saved.*revision 2/)
      assert.equal(loadKnowledgeNotes(MEMORY_TYPE)[0]?.body, 'two')
    })

    it('rejects an unknown id instead of creating a duplicate', async () => {
      const out = await run(rememberTool, { id: 'nope', title: 'X', content: 'x' })
      assert.match(out, /No memory with id/)
      assert.equal(loadKnowledgeNotes(MEMORY_TYPE).length, 0)
    })

    it('records sources and appliesTo, and marks missing sources unknown', async () => {
      await run(rememberTool, {
        title: 'With',
        content: 'c',
        sources: ['msg:1', 'tool:2'],
        appliesTo: ['src/**'],
      })
      await run(rememberTool, { title: 'Without', content: 'c' })
      const out = await run(recallTool, {})
      assert.match(out, /msg:1, tool:2/)
      assert.match(out, /applies to: src\/\*\*/)
      assert.match(out, /sources: unknown/)
    })

    it('treats legacy notes without revision as revision 1', async () => {
      const { addKnowledgeNote } = await import('../services/storage/knowledge-store.ts')
      addKnowledgeNote({ type: MEMORY_TYPE, title: 'Old', body: 'b' })
      assert.match(await run(recallTool, {}), /revision: 1/)
      assert.match(await run(rememberTool, { title: 'Old', content: 'n' }), /revision 2/)
    })

    it('pages recall with a cursor and rejects a bad one', async () => {
      for (const n of ['a', 'b', 'c']) await run(rememberTool, { title: n, content: n })
      const p1 = await run(recallTool, { limit: 2 })
      assert.match(p1, /showing 1–2/)
      const cursor = /Next cursor: (m:\d+)/.exec(p1)?.[1]
      assert.ok(cursor)
      const p2 = await run(recallTool, { limit: 2, cursor })
      assert.match(p2, /## c/)
      assert.doesNotMatch(p2, /Next cursor/)
      assert.match(await run(recallTool, { cursor: 'x' }), /Invalid cursor/)
    })

    it('updates by id without a title and keeps the existing one', async () => {
      const a = await run(rememberTool, { title: 'A', content: 'a' })
      const idA = /id (\S+),/.exec(a)?.[1]
      assert.ok(idA)
      assert.match(
        await run(rememberTool, { id: idA, content: 'a2' }),
        /Saved memory "A".*revision 2/,
      )
      const notes = loadKnowledgeNotes(MEMORY_TYPE)
      assert.equal(notes.length, 1)
      const note = notes.find((n) => n.id === idA)
      assert.ok(note)
      assert.equal(note.title, 'A')
      assert.equal(note.body.trim(), 'a2')
    })

    it('requires a title when no id is given', async () => {
      assert.match(await run(rememberTool, { content: 'x' }), /title is required/)
      assert.match(await run(rememberTool, { title: '  ', content: 'x' }), /title is required/)
      assert.equal(loadKnowledgeNotes(MEMORY_TYPE).length, 0)
    })

    it('reports a cursor past the end instead of an empty page', async () => {
      for (const n of ['a', 'b', 'c']) await run(rememberTool, { title: n, content: n })
      const out = await run(recallTool, { cursor: 'm:99' })
      assert.match(out, /past the end; there are only 3 memories/)
      assert.doesNotMatch(out, /showing/)
      assert.match(await run(recallTool, { cursor: 'm:3' }), /past the end/)
    })

    it('rejects an id update that would rename onto another memory title', async () => {
      await run(rememberTool, { title: 'A', content: 'a' })
      const b = await run(rememberTool, { title: 'B', content: 'b' })
      const idB = /id (\S+),/.exec(b)?.[1]
      assert.ok(idB)
      const out = await run(rememberTool, { id: idB, title: 'A', content: 'b2' })
      assert.match(out, /already titled "A"/)
      const notes = loadKnowledgeNotes(MEMORY_TYPE)
      assert.deepEqual(notes.map((n) => n.title).sort(), ['A', 'B'])
      assert.equal(notes.find((n) => n.title === 'B')?.body.trim(), 'b')
      // Renaming to its own title, or to a free one, still works.
      assert.match(await run(rememberTool, { id: idB, title: 'B', content: 'b3' }), /revision 2/)
      assert.match(await run(rememberTool, { id: idB, title: 'C', content: 'b4' }), /revision 3/)
    })
  })
})
