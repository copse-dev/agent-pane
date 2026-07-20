import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { stampRoadmapComplexity } from './roadmap-complexity.ts'
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  getKnowledgeNote,
  setKnowledgeRootForTest,
  updateKnowledgeNote,
  type KnowledgeNote,
} from './storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('stampRoadmapComplexity', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-complexity-'))
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

  it('stamps the verdict onto the note, keeps other fields, and reports it', async () => {
    const note = seedItem('Refactor the settings dialog')
    let stamped = 0
    await stampRoadmapComplexity(
      note.id,
      'Refactor the settings dialog',
      () => stamped++,
      () => Promise.resolve('high'),
    )
    const after = getKnowledgeNote(note.id)
    assert.ok(after)
    assert.equal(after.fields['complexity'], 'high')
    assert.equal(after.fields['notes'], 'seeded', 'unrelated fields survive the stamp')
    assert.equal(stamped, 1)
  })

  it('skips the stamp when the prompt changed while the classifier ran', async () => {
    const note = seedItem('Old prompt')
    let resolveClassify: ((c: 'low') => void) | undefined
    let stamped = 0
    const inFlight = stampRoadmapComplexity(
      note.id,
      'Old prompt',
      () => stamped++,
      () =>
        new Promise((resolve) => {
          resolveClassify = resolve
        }),
    )
    // A newer save rewrites the prompt before the classifier answers; that save
    // owns (re)classification, so the stale verdict must not land.
    updateKnowledgeNote(note.id, { body: 'Newer prompt' })
    resolveClassify?.('low')
    await inFlight
    const after = getKnowledgeNote(note.id)
    assert.equal(after?.fields['complexity'], undefined)
    assert.equal(stamped, 0)
  })

  it('skips the stamp when the note was deleted while the classifier ran', async () => {
    const note = seedItem('Doomed prompt')
    let stamped = 0
    const inFlight = stampRoadmapComplexity(
      note.id,
      'Doomed prompt',
      () => stamped++,
      () => Promise.resolve('medium'),
    )
    deleteKnowledgeNote(note.id)
    await inFlight
    assert.equal(getKnowledgeNote(note.id), null)
    assert.equal(stamped, 0)
  })

  it('skips the stamp when the model returns no verdict', async () => {
    const note = seedItem('Unclassified prompt')
    let stamped = 0
    await stampRoadmapComplexity(
      note.id,
      'Unclassified prompt',
      () => stamped++,
      () => Promise.resolve(null),
    )
    assert.equal(getKnowledgeNote(note.id)?.fields['complexity'], undefined)
    assert.equal(stamped, 0)
  })
})
