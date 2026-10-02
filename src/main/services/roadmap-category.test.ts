import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ROADMAP_CATEGORY_QUESTION, stampRoadmapCategory } from './roadmap-category.ts'
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

describe('stampRoadmapCategory', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-category-'))
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
    await stampRoadmapCategory(
      note.id,
      'Refactor the settings dialog',
      () => stamped++,
      () => Promise.resolve('feature'),
    )
    const after = getKnowledgeNote(note.id)
    assert.ok(after)
    assert.equal(after.fields['category'], 'feature')
    assert.equal(after.fields['notes'], 'seeded', 'unrelated fields survive the stamp')
    assert.equal(stamped, 1)
  })

  it('skips the stamp when the prompt changed while the classifier ran', async () => {
    const note = seedItem('Old prompt')
    let resolveClassify: ((c: 'bug') => void) | undefined
    let stamped = 0
    const inFlight = stampRoadmapCategory(
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
    resolveClassify?.('bug')
    await inFlight
    const after = getKnowledgeNote(note.id)
    assert.equal(after?.fields['category'], undefined)
    assert.equal(stamped, 0)
  })

  it('skips the stamp when the note was deleted while the classifier ran', async () => {
    const note = seedItem('Doomed prompt')
    let stamped = 0
    const inFlight = stampRoadmapCategory(
      note.id,
      'Doomed prompt',
      () => stamped++,
      () => Promise.resolve('project'),
    )
    deleteKnowledgeNote(note.id)
    await inFlight
    assert.equal(getKnowledgeNote(note.id), null)
    assert.equal(stamped, 0)
  })

  it('skips the stamp when the model returns no verdict', async () => {
    const note = seedItem('Unclassified prompt')
    let stamped = 0
    await stampRoadmapCategory(
      note.id,
      'Unclassified prompt',
      () => stamped++,
      () => Promise.resolve(null),
    )
    assert.equal(getKnowledgeNote(note.id)?.fields['category'], undefined)
    assert.equal(stamped, 0)
  })
})

describe('ROADMAP_CATEGORY_QUESTION', () => {
  it('renders the same prompt the small-tasks model was tuned on', () => {
    // The wording the model path used before it moved onto background questions.
    const previous =
      'Classify the coding task below as exactly one word: bug, feature, or project.\n' +
      '- bug: fixing broken behavior — a crash, wrong output, an exception, a regression, ' +
      'or something that does not work as documented.\n' +
      '- feature: new functionality or an enhancement to existing behavior — a new control, ' +
      'command, option, or small improvement, contained to a familiar area.\n' +
      '- project: a multi-part initiative — a new subsystem, a migration, an architectural ' +
      'change, or a goal that needs design and several distinct pieces of work before it lands.\n' +
      'Use all three options: not every task is a feature. If torn between feature and project, ' +
      'pick feature unless the work clearly spans multiple coordinated pieces.\n' +
      'Reply with ONLY the word.\n\nTask:\n'
    assert.equal(
      backgroundChoicePrompt(ROADMAP_CATEGORY_QUESTION, 'Add a flag'),
      previous + 'Add a flag',
    )
  })
})
