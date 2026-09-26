import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { stampRoadmapTitle } from './roadmap-title.ts'
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  getKnowledgeNote,
  setKnowledgeRootForTest,
  updateKnowledgeNote,
  type KnowledgeNote,
} from './storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('stampRoadmapTitle', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-title-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  function seedItem(prompt: string): KnowledgeNote {
    return addKnowledgeNote({
      type: 'Roadmap',
      title: prompt.slice(0, 80),
      body: prompt,
      status: 'ready',
      fields: { notes: 'seeded' },
    })
  }

  it('replaces the truncation title with the AI-generated one and reports it', async () => {
    const prompt = 'Refactor the settings dialog into separate panels'
    const note = seedItem(prompt)
    let stamped = 0
    await stampRoadmapTitle(
      note.id,
      prompt,
      note.title,
      () => stamped++,
      () => Promise.resolve('Split Settings Into Panels'),
    )
    const after = getKnowledgeNote(note.id)
    assert.ok(after)
    assert.equal(after.title, 'Split Settings Into Panels')
    assert.equal(after.fields['notes'], 'seeded', 'unrelated fields survive the stamp')
    assert.equal(after.body, prompt, 'the prompt itself is untouched')
    assert.equal(stamped, 1)
  })

  it('keeps the truncation title when no small-tasks model answers (offline/disabled)', async () => {
    const prompt = 'Old prompt with no model available'
    const note = seedItem(prompt)
    let stamped = 0
    await stampRoadmapTitle(
      note.id,
      prompt,
      note.title,
      () => stamped++,
      () => Promise.resolve(null),
    )
    assert.equal(getKnowledgeNote(note.id)?.title, note.title)
    assert.equal(stamped, 0)
  })

  it('never throws when the generator rejects — a failed stamp just keeps the truncation', async () => {
    const prompt = 'A prompt whose naming call blows up'
    const note = seedItem(prompt)
    let stamped = 0
    await stampRoadmapTitle(
      note.id,
      prompt,
      note.title,
      () => stamped++,
      () => Promise.reject(new Error('model unreachable')),
    )
    assert.equal(getKnowledgeNote(note.id)?.title, note.title)
    assert.equal(stamped, 0)
  })

  it('skips the stamp when the prompt changed while the generator ran', async () => {
    const note = seedItem('Old prompt')
    let resolveGenerate: ((title: string) => void) | undefined
    let stamped = 0
    const inFlight = stampRoadmapTitle(
      note.id,
      'Old prompt',
      note.title,
      () => stamped++,
      () =>
        new Promise((resolve) => {
          resolveGenerate = resolve
        }),
    )
    // A newer save rewrites the prompt before the model answers; that save
    // owns its own title, so the stale name must not land.
    updateKnowledgeNote(note.id, { body: 'Newer prompt', title: 'Newer prompt' })
    resolveGenerate?.('Stale Title')
    await inFlight
    const after = getKnowledgeNote(note.id)
    assert.equal(after?.title, 'Newer prompt')
    assert.equal(stamped, 0)
  })

  it('skips the stamp when the note was deleted while the generator ran', async () => {
    const note = seedItem('Doomed prompt')
    let stamped = 0
    const inFlight = stampRoadmapTitle(
      note.id,
      'Doomed prompt',
      note.title,
      () => stamped++,
      () => Promise.resolve('Doomed Title'),
    )
    deleteKnowledgeNote(note.id)
    await inFlight
    assert.equal(getKnowledgeNote(note.id), null)
    assert.equal(stamped, 0)
  })

  it('never overwrites a title something else already set (e.g. a later stamp or a manual rename)', async () => {
    const prompt = 'Ambiguous prompt'
    const note = seedItem(prompt)
    // Simulate the title already having moved on from the truncation this
    // stamp was kicked off for, without the prompt itself changing.
    updateKnowledgeNote(note.id, { title: 'Already Renamed' })
    let stamped = 0
    await stampRoadmapTitle(
      note.id,
      prompt,
      note.title, // the stale truncation title, no longer current
      () => stamped++,
      () => Promise.resolve('Would-Be AI Title'),
    )
    assert.equal(getKnowledgeNote(note.id)?.title, 'Already Renamed')
    assert.equal(stamped, 0)
  })
})
