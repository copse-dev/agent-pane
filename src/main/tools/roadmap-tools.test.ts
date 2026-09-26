import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  addRoadmapItem,
  roadmapPlanTool,
  roadmapTitleFromPrompt,
  ROADMAP_TYPE,
} from './roadmap-tools.ts'
import {
  addKnowledgeNote,
  getKnowledgeNote,
  setKnowledgeRootForTest,
} from '../services/storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from '../services/workspace.ts'
import { storageSet } from '../services/storage/storage.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
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

/** Let a detached stamp promise settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// Stands in for the real small-tasks title generator wherever a test doesn't
// care about the AI-generated name — without it, an unconfigured/unreachable
// model's own retry/backoff would make the test pay for (and wait on) a real
// round-trip.
const stubTitle = (): Promise<null> => Promise.resolve(null)

describe('roadmap-tools', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-tools-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  // addRoadmapItem carries the tool's `add` behavior (recording + the AI title
  // stamp, issue #2472) and takes an injectable `generate`, so these exercise
  // it directly rather than through `roadmap_plan add` — the tool's own
  // `execute` uses the real small-tasks model by default, and calling it with
  // no provider configured would just retry/back off for real instead of
  // resolving quickly.
  describe('addRoadmapItem', () => {
    it('records the item immediately under the truncation title', () => {
      const prompt = 'Refactor the settings dialog into separate panels for clarity'
      const note = addRoadmapItem(prompt, undefined, null, undefined, stubTitle)
      assert.equal(note.type, ROADMAP_TYPE)
      assert.equal(note.body, prompt)
      assert.equal(note.title, roadmapTitleFromPrompt(prompt))
      assert.equal(note.status, 'ready')
    })

    it('keeps notes and a pinned issue in fields', () => {
      const note = addRoadmapItem('Do the thing', 'waiting on #12', '#12', undefined, stubTitle)
      assert.equal(note.fields['notes'], 'waiting on #12')
      assert.equal(note.fields['issue'], '#12')
    })

    it('stamps an AI-generated title over the truncation in the background and reports it', async () => {
      const prompt = 'Refactor the settings dialog into separate panels'
      let stamped = 0
      const note = addRoadmapItem(
        prompt,
        undefined,
        null,
        () => stamped++,
        () => Promise.resolve('Split Settings Into Panels'),
      )
      // The synchronous return is always the truncation — recording never
      // waits on the naming model.
      assert.equal(note.title, roadmapTitleFromPrompt(prompt))
      await settle()
      assert.equal(getKnowledgeNote(note.id)?.title, 'Split Settings Into Panels')
      assert.equal(stamped, 1)
    })

    it('keeps the truncation title when the generator answers nothing (offline/disabled)', async () => {
      const prompt = 'A prompt with no small-tasks model configured'
      let stamped = 0
      const note = addRoadmapItem(
        prompt,
        undefined,
        null,
        () => stamped++,
        () => Promise.resolve(null),
      )
      await settle()
      assert.equal(getKnowledgeNote(note.id)?.title, roadmapTitleFromPrompt(prompt))
      assert.equal(stamped, 0)
    })
  })

  describe('roadmap_plan tool', () => {
    it('add requires a non-empty prompt', async () => {
      assert.match(await run(roadmapPlanTool, { action: 'add', prompt: '   ' }), /non-empty prompt/)
    })

    it('add rejects an unrecognized issue reference', async () => {
      const out = await run(roadmapPlanTool, { action: 'add', prompt: 'Do it', issue: 'nope' })
      assert.match(out, /Unrecognized issue reference "nope"/)
    })

    it('set_status requires an id and a status', async () => {
      assert.match(
        await run(roadmapPlanTool, { action: 'set_status', status: 'done' }),
        /requires an item id/,
      )
      assert.match(
        await run(roadmapPlanTool, { action: 'set_status', id: 'missing' }),
        /requires a status/,
      )
    })

    it('set_status reports an unknown id and never touches other knowledge types', async () => {
      const memory = addKnowledgeNote({ type: 'Memory', title: 'Not roadmap', body: 'x' })
      const out = await run(roadmapPlanTool, {
        action: 'set_status',
        id: memory.id,
        status: 'done',
      })
      assert.match(out, /No roadmap item with id/)
    })

    it('list reports an empty roadmap', async () => {
      assert.match(await run(roadmapPlanTool, { action: 'list' }), /roadmap is empty/)
    })

    it('list shows previously added items', async () => {
      addRoadmapItem('Ship the thing', undefined, null, undefined, stubTitle)
      const out = await run(roadmapPlanTool, { action: 'list' })
      assert.match(out, /Roadmap \(1 item\):/)
      assert.match(out, /Ship the thing/)
    })
  })

  // A run keeps going after the user switches projects. Its roadmap reads and
  // writes (including the background title stamp) stay in its own project.
  describe('after the user switches projects mid-run', () => {
    const turnInProjectA = <T>(fn: () => T): T =>
      runWithThreadExecutionContext(
        {
          projectId: 'project-a',
          threadId: 'thread-a',
          projectRoot: '/home/dev/my-project',
          root: '/home/dev/my-project',
          checkoutMode: 'shared',
          branch: null,
        },
        fn,
      )

    beforeEach(() => {
      storageSet('projects', [
        { id: 'project-a', path: '/home/dev/my-project', name: 'my-project' },
        { id: 'project-b', path: '/home/dev/other', name: 'other' },
      ])
      storageSet('activeProjectId', 'project-b')
    })

    afterEach(() => {
      storageSet('projects', [])
      storageSet('activeProjectId', null)
    })

    it("keeps the thread's roadmap in its own project", async () => {
      const note = turnInProjectA(() =>
        addRoadmapItem('Background item', undefined, null, undefined, () =>
          Promise.resolve('Stamped name'),
        ),
      )
      await settle()

      assert.match(await run(roadmapPlanTool, { action: 'list' }), /The roadmap is empty/)
      assert.equal(getKnowledgeNote(note.id), null, 'not visible from the active project')

      const setStatus = await turnInProjectA(() =>
        run(roadmapPlanTool, { action: 'set_status', id: note.id, status: 'blocked' }),
      )
      assert.match(setStatus, /→ blocked/)
      const listed = await turnInProjectA(() => run(roadmapPlanTool, { action: 'list' }))
      assert.match(listed, /\(blocked\) Background item/)
      assert.equal(turnInProjectA(() => getKnowledgeNote(note.id))?.title, 'Stamped name')
    })
  })
})
