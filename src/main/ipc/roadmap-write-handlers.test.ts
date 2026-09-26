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

  it('broadcasts roadmap:changed after an update and a delete, so mirrors drop stale titles', () => {
    const h = roadmapWriteHarness()
    const note = h.handlers.create('Rename me')
    h.changes.length = 0
    h.handlers.update(note.id, note.body, 'notes only', 'ready')
    assert.deepEqual(h.changes, ['roadmap:changed'])

    h.changes.length = 0
    assert.equal(h.handlers.remove(note.id), true)
    assert.equal(h.notes.has(note.id), false)
    assert.deepEqual(h.deleted, [`all:${note.id}`])
    assert.deepEqual(h.changes, ['roadmap:changed'])

    h.changes.length = 0
    assert.equal(h.handlers.remove(note.id), false, 'a missing item is not deleted again')
    assert.deepEqual(h.changes, [], 'no broadcast when nothing changed')
  })

  it('refuses to delete a non-roadmap note', () => {
    const h = roadmapWriteHarness()
    const note = h.handlers.create('Keep me')
    h.notes.set(note.id, { ...note, type: 'Memory' })
    h.changes.length = 0
    assert.equal(h.handlers.remove(note.id), false)
    assert.equal(h.notes.has(note.id), true)
    assert.deepEqual(h.changes, [])
  })

  it('stamps the started thread, broadcasts, and resolves it back through findByThread', () => {
    const h = roadmapWriteHarness()
    const first = h.handlers.create('First item')
    const second = h.handlers.create('Second item')
    h.changes.length = 0

    assert.equal(h.handlers.setThread(first.id, ' thread-1 ')?.fields['thread'], 'thread-1')
    assert.deepEqual(h.changes, ['roadmap:changed'])
    assert.deepEqual(h.handlers.findByThread('thread-1'), { id: first.id, title: first.title })
    assert.equal(h.handlers.findByThread('thread-2'), null)
    assert.equal(h.notes.get(second.id)?.fields['thread'], undefined)

    // Restamping points the item at the newer thread; the older one stops resolving.
    h.handlers.setThread(first.id, 'thread-2')
    assert.equal(h.handlers.findByThread('thread-1'), null)
    assert.deepEqual(h.handlers.findByThread('thread-2'), { id: first.id, title: first.title })

    // An empty id clears the tracking.
    assert.equal(h.handlers.setThread(first.id, '')?.fields['thread'], undefined)
    assert.equal(h.handlers.findByThread('thread-2'), null)
  })

  it('ignores non-roadmap notes in findByThread and rejects invalid ids', () => {
    const h = roadmapWriteHarness()
    const note = h.handlers.create('Item')
    h.notes.set(note.id, { ...note, type: 'Memory', fields: { thread: 'thread-1' } })
    assert.equal(h.handlers.findByThread('thread-1'), null)
    assert.equal(h.handlers.setThread(note.id, 'thread-1'), null)
    assert.equal(h.handlers.setThread('missing', 'thread-1'), null)
    assert.throws(() => h.handlers.findByThread(''))
    assert.throws(() => h.handlers.findByThread('x'.repeat(129)))
    assert.throws(() => h.handlers.setThread('', 'thread-1'))
  })
})
