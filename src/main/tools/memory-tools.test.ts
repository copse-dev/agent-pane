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

  it('caps an unfiltered page by size and resumes from the first memory it left out', async () => {
    const big = 'x'.repeat(RECALL_ALL_MAX_CHARS / 2)
    for (const title of ['One', 'Two', 'Three']) {
      addKnowledgeNote({ type: MEMORY_TYPE, title, body: big })
    }

    const first = await run(recallTool, {})

    assert.ok(first.length <= RECALL_ALL_MAX_CHARS, String(first.length))
    assert.match(first, /Found 3 memories \(showing 1–1\):/)
    assert.match(first, /^## One(?: |$)/m)
    assert.doesNotMatch(first, /^## Two(?: |$)/m)
    assert.match(first, /Next cursor: m:1/)
    // The cursor picks up exactly where the size cap stopped, so none is skipped.
    const second = await run(recallTool, { cursor: 'm:1' })
    assert.match(second, /^## Two(?: |$)/m)
    assert.match(second, /Next cursor: m:2/)
  })

  it('keeps a whole page, framing included, within the cap when many memories nearly fill it', async () => {
    // Bodies sized so the page fills right up to its budget before stopping.
    for (let i = 0; i < 40; i++) {
      addKnowledgeNote({ type: MEMORY_TYPE, title: `Note ${String(i)}`, body: 'z'.repeat(990) })
    }

    const page = await run(recallTool, { limit: 50 })

    assert.ok(page.length <= RECALL_ALL_MAX_CHARS, String(page.length))
    assert.match(page, /Next cursor: m:\d+/)
  })

  it('does not size-cap a query, so a query reads a long memory in full', async () => {
    addKnowledgeNote({
      type: MEMORY_TYPE,
      title: 'Huge',
      body: 'y'.repeat(RECALL_ALL_MAX_CHARS * 3),
    })

    const found = await run(recallTool, { query: 'Huge' })

    assert.ok(found.length > RECALL_ALL_MAX_CHARS * 3, String(found.length))
    assert.doesNotMatch(found, /Memory truncated/)
  })

  it('clips a single memory larger than the size cap instead of returning it whole', async () => {
    addKnowledgeNote({
      type: MEMORY_TYPE,
      title: 'Huge',
      body: 'y'.repeat(RECALL_ALL_MAX_CHARS * 3),
    })

    const all = await run(recallTool, {})

    assert.ok(all.length <= RECALL_ALL_MAX_CHARS, String(all.length))
    assert.match(all, /## Huge/)
    assert.match(all, /Memory truncated at 20,000 characters/)
    assert.match(all, /recall with a query/)
  })

  it('keeps the external-content caution when clipping a memory with a huge title', async () => {
    addKnowledgeNote({
      type: MEMORY_TYPE,
      title: 'T'.repeat(RECALL_ALL_MAX_CHARS * 2),
      body: 'from the web',
      fields: { [EXTERNAL_CONTEXT_FIELD]: 'true' },
    })

    const all = await run(recallTool, {})

    assert.ok(all.length <= RECALL_ALL_MAX_CHARS, String(all.length))
    assert.match(all, /ingested external content/)
    assert.match(all, /Memory truncated/)
  })

  it('keeps a clipped memory within the cap when one of its tags is huge', async () => {
    addKnowledgeNote({
      type: MEMORY_TYPE,
      title: 'Tagged',
      body: 'short body',
      tags: ['x'.repeat(RECALL_ALL_MAX_CHARS * 2), 'small'],
      fields: { [EXTERNAL_CONTEXT_FIELD]: 'true' },
    })

    const all = await run(recallTool, {})

    assert.ok(all.length <= RECALL_ALL_MAX_CHARS, String(all.length))
    assert.match(all, /## Tagged/)
    assert.match(all, /ingested external content/)
  })

  it('does not taint the turn for a tainted memory the cap left out', async () => {
    // The page stops after the oversized first memory; the tainted one is next.
    addKnowledgeNote({ type: MEMORY_TYPE, title: 'Shown', body: 'x'.repeat(RECALL_ALL_MAX_CHARS) })
    await inTaintedTurn(() => run(rememberTool, { title: 'Hidden', content: 'From the web' }))

    await runWithThreadExecutionContext({ ...TEST_CONTEXT }, async () => {
      const all = await run(recallTool, {})
      assert.match(all, /## Shown/)
      assert.doesNotMatch(all, /## Hidden/)
      assert.equal(turnIngestedExternalContent(), false)
      // Fetching the page that holds it does taint the turn.
      assert.match(await run(recallTool, { cursor: 'm:1' }), /## Hidden/)
      assert.equal(turnIngestedExternalContent(), true)
    })
  })

  it('keeps a clipped memory within the cap when its sources list is huge', async () => {
    await inTaintedTurn(() =>
      run(rememberTool, {
        title: 'Sourced',
        content: 'y'.repeat(RECALL_ALL_MAX_CHARS * 2),
        sources: ['s'.repeat(RECALL_ALL_MAX_CHARS * 2), 'another'],
        appliesTo: ['a'.repeat(RECALL_ALL_MAX_CHARS)],
      }),
    )

    const all = await run(recallTool, {})

    assert.ok(all.length <= RECALL_ALL_MAX_CHARS, String(all.length))
    assert.match(all, /## Sourced/)
    assert.match(all, /ingested external content/)
    assert.match(all, /Memory truncated/)
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

    it('preserves commas in sources and applicability through persistence and recall', async () => {
      await run(rememberTool, {
        title: 'Comma references',
        content: 'c',
        sources: ['https://example.com/a,b', 'msg:1'],
        appliesTo: ['src/{a,b}/**'],
      })
      const out = await run(recallTool, {})
      assert.ok(out.includes('https://example.com/a,b'))
      assert.ok(out.includes('src/{a,b}/**'))
      const { addKnowledgeNote } = await import('../services/storage/knowledge-store.ts')
      addKnowledgeNote({
        type: MEMORY_TYPE,
        title: 'Legacy list',
        body: 'b',
        fields: { memorySchema: '1', sources: 'msg:old,tool:old', appliesTo: 'legacy/**' },
      })
      assert.ok((await run(recallTool, {})).includes('msg:old, tool:old'))
      addKnowledgeNote({
        type: MEMORY_TYPE,
        title: 'Legacy JSON-looking reference',
        body: 'b',
        fields: { memorySchema: '1', sources: '["msg:literal"]' },
      })
      assert.ok((await run(recallTool, {})).includes('["msg:literal"]'))
      await run(rememberTool, {
        title: 'Legacy JSON-looking reference',
        content: 'updated without replacing sources',
      })
      assert.ok((await run(recallTool, {})).includes('["msg:literal"]'))
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
