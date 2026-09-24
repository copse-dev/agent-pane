import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { roadmapWriteHarness } from '../../../tests/helpers/roadmap-write-harness.ts'
import { parseKnowledgeAttachments } from '@shared/knowledge/attachments.ts'
import { createRoadmapWriteHandlers } from './roadmap-write-handlers.ts'

describe('roadmap write handlers without Electron', () => {
  it('validates and normalizes actual create arguments before persisting and stamping', () => {
    const h = roadmapWriteHarness()
    assert.throws(() => h.handlers.create(' '), /must not be empty/)
    assert.throws(() => h.handlers.create('prompt', '', 'bad issue'), /Unrecognized issue/)
    assert.equal(h.notes.size, 0)
    const note = h.handlers.create(
      '  Keep the complete prompt.  ',
      ' note ',
      'https://github.com/copse-dev/agent-pane/issues/123',
    )
    assert.equal(note.body, 'Keep the complete prompt.')
    assert.equal(note.fields['notes'], 'note')
    assert.equal(note.fields['issue'], 'copse-dev/agent-pane#123')
    assert.deepEqual(h.stamps, ['complexity', 'category', 'title'])
  })

  it('updates notes without reclassifying an unchanged prompt, and rejects non-roadmap notes', () => {
    const h = roadmapWriteHarness()
    const note = h.handlers.create('Build a preview')
    h.stamps.length = 0
    const updated = h.handlers.update(note.id, note.body, 'After the release', 'ready')
    assert.equal(updated?.fields['notes'], 'After the release')
    assert.deepEqual(h.stamps, [])
    h.notes.set(note.id, { ...note, type: 'Memory' })
    assert.equal(h.handlers.update(note.id, note.body, '', 'ready'), null)
    assert.throws(() => h.handlers.update(note.id, note.body, '', 'invalid'), /Invalid option/)
  })

  it('invalidates derived fields and starts fresh stamps only when the prompt changes', () => {
    const h = roadmapWriteHarness()
    const note = h.handlers.create('Old prompt')
    h.notes.set(note.id, {
      ...note,
      fields: {
        complexity: 'small',
        category: 'fix',
        fit: 'yes',
        fitDetail: 'old',
        reviewVerdict: 'ok',
        reviewDetail: 'old',
        reviewAt: 'old',
      },
    })
    h.stamps.length = 0
    const updated = h.handlers.update(note.id, 'New prompt', '', 'ready')
    assert.deepEqual(updated?.fields, {})
    assert.deepEqual(h.stamps, ['complexity', 'category', 'title'])
  })

  it('cleans new attachment payloads when persistence fails, preserving existing ones', () => {
    const h = roadmapWriteHarness()
    const note = h.handlers.create('Prompt', '', '', [
      { name: 'old.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,YQ==' },
    ])
    const old = parseKnowledgeAttachments(note.fields['attachments'])[0]
    assert.ok(old)
    h.deps.updateKnowledgeNote = (): never => {
      throw new Error('disk full')
    }
    // Construct after swapping the persistence boundary, just as a failed store would behave.
    const failing = createRoadmapWriteHandlers(h.deps)
    assert.throws(
      () =>
        failing.update(
          note.id,
          note.body,
          '',
          'ready',
          '',
          [{ name: 'new.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,Yg==' }],
          [old.id],
        ),
      /disk full/,
    )
    assert.equal(h.deleted.includes(old.id), false)
    assert.equal(h.deleted.length, 1)
    assert.equal(h.notes.get(note.id), note)
  })
})
