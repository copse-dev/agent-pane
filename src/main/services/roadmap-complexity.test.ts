import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ROADMAP_COMPLEXITY_QUESTION, stampRoadmapComplexity } from './roadmap-complexity.ts'
import { backgroundChoicePrompt } from './classifiers/background-classification.ts'
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

describe('ROADMAP_COMPLEXITY_QUESTION', () => {
  it('renders the same prompt the small-tasks model was tuned on', () => {
    // The wording the model path used before it moved onto background questions.
    const previous =
      'Rate the implementation complexity of the coding task below as exactly one word: ' +
      'low, medium, or high.\n' +
      '- low: contained and well-specified — one or two files, mechanical or obvious steps ' +
      '(rename, copy/style tweak, config flag, small bug fix, adding a test).\n' +
      '- medium: a typical feature or fix — several files and some decisions, but a familiar ' +
      'shape (new UI control wired to existing state, new command, module-level change).\n' +
      '- high: cross-cutting or open-ended — new subsystem, architectural refactor or ' +
      'migration, concurrency/security-sensitive work, or a goal that needs design before code.\n' +
      'Use the whole scale: many roadmap items are genuinely low, and medium is not a safe ' +
      'default for uncertainty. If torn between two ratings, pick the lower one.\n' +
      'Reply with ONLY the word.\n\nTask:\n'
    assert.equal(
      backgroundChoicePrompt(ROADMAP_COMPLEXITY_QUESTION, 'Add a flag'),
      previous + 'Add a flag',
    )
  })
})
