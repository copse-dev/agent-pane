import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  addKnowledgeNote,
  deleteKnowledgeNote,
  getKnowledgeNote,
  knowledgeDir,
  loadKnowledgeNotes,
  searchKnowledgeNotes,
  setKnowledgeNoteStatus,
  setKnowledgeRootForTest,
  updateKnowledgeNote,
} from './knowledge-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('knowledge-store', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('starts empty', () => {
    assert.deepEqual(loadKnowledgeNotes(), [])
  })

  it('adds a note as an OKF file under its type subdir and reads it back', () => {
    const note = addKnowledgeNote({
      type: 'Roadmap',
      title: 'Refactor the parser',
      body: 'Rework the tokenizer once #500 merges.',
      status: 'ready',
      fields: { notes: 'after #500 merges' },
    })

    assert.equal(note.type, 'Roadmap')
    assert.equal(note.status, 'ready')
    assert.match(note.file, /roadmap\/[0-9a-f-]{36}\.md$/)

    const raw = readFileSync(note.file, 'utf8')
    assert.match(raw, /^---\ntype: Roadmap\n/)
    assert.match(raw, /status: ready/)
    assert.match(raw, /notes: "after #500 merges"/)

    const loaded = loadKnowledgeNotes()
    assert.equal(loaded.length, 1)
    assert.equal(at(loaded, 0).id, note.id)
    assert.equal(at(loaded, 0).fields['notes'], 'after #500 merges')
    assert.equal(at(loaded, 0).body, 'Rework the tokenizer once #500 merges.')
  })

  it('preserves insertion order across notes and loads', () => {
    const first = addKnowledgeNote({ type: 'Roadmap', title: 'First', body: 'a' })
    const second = addKnowledgeNote({ type: 'Roadmap', title: 'Second', body: 'b' })
    const third = addKnowledgeNote({ type: 'Roadmap', title: 'Third', body: 'c' })

    const ids = loadKnowledgeNotes().map((n) => n.id)
    assert.deepEqual(ids, [first.id, second.id, third.id])
  })

  it('updates status by id without disturbing order, and reports unknown ids', () => {
    const a = addKnowledgeNote({ type: 'Roadmap', title: 'A', body: 'a', status: 'ready' })
    addKnowledgeNote({ type: 'Roadmap', title: 'B', body: 'b', status: 'ready' })

    const updated = setKnowledgeNoteStatus(a.id, 'blocked')
    assert.equal(updated?.status, 'blocked')
    assert.equal(getKnowledgeNote(a.id)?.status, 'blocked')
    // Order preserved: A is still first.
    assert.equal(at(loadKnowledgeNotes(), 0).id, a.id)
    assert.equal(setKnowledgeNoteStatus('does-not-exist', 'done'), null)
  })

  it('edits title and body losslessly, keeping the same file and id', () => {
    const note = addKnowledgeNote({ type: 'Memory', title: 'Old title', body: 'old body' })
    const updated = updateKnowledgeNote(note.id, { title: 'New title', body: 'new body' })
    assert.ok(updated)
    assert.equal(updated.id, note.id)
    assert.equal(updated.file, note.file)
    assert.equal(updated.title, 'New title')
    assert.equal(getKnowledgeNote(note.id)?.body, 'new body')
  })

  it('filters and searches by type and content', () => {
    addKnowledgeNote({
      type: 'Memory',
      title: 'Build command',
      body: 'run npm run check',
      tags: ['ci'],
    })
    addKnowledgeNote({ type: 'Roadmap', title: 'Ship export', body: 'add settings export' })

    assert.equal(loadKnowledgeNotes('Memory').length, 1)
    assert.equal(loadKnowledgeNotes('Roadmap').length, 1)
    assert.equal(at(searchKnowledgeNotes('export'), 0).type, 'Roadmap')
    assert.equal(searchKnowledgeNotes('check', 'Memory').length, 1)
    assert.equal(searchKnowledgeNotes('check', 'Roadmap').length, 0)
  })

  it('deletes a note so it stops loading', () => {
    const note = addKnowledgeNote({ type: 'Roadmap', title: 'Temp', body: 'x' })
    assert.equal(deleteKnowledgeNote(note.id), true)
    assert.deepEqual(loadKnowledgeNotes(), [])
    assert.equal(getKnowledgeNote(note.id), null)
    assert.equal(deleteKnowledgeNote(note.id), false)
  })

  it('round-trips a body that itself begins with a frontmatter fence', () => {
    const body = '---\nnot: frontmatter\n---\nreal content'
    const note = addKnowledgeNote({ type: 'Memory', title: 'Tricky', body })
    assert.equal(getKnowledgeNote(note.id)?.body, body)
  })

  it('heals a hand-added note file that is missing from the index', () => {
    const existing = addKnowledgeNote({ type: 'Roadmap', title: 'Indexed', body: 'a' })
    // Drop a note file directly on disk with no index line.
    const dir = join(knowledgeDir(), 'roadmap')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'orphan.md'),
      '---\ntype: Roadmap\nid: orphan\ntitle: "Orphan"\ntags: []\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n\nhand added\n',
      'utf8',
    )
    const ids = loadKnowledgeNotes().map((n) => n.id)
    assert.deepEqual(ids.sort(), [existing.id, 'orphan'].sort())
    // Healed into the index, so a second load is stable.
    assert.equal(loadKnowledgeNotes().length, 2)
  })

  it('survives a corrupt index by rebuilding from the note files', () => {
    const note = addKnowledgeNote({ type: 'Roadmap', title: 'Kept', body: 'a' })
    writeFileSync(join(knowledgeDir(), 'index.jsonl'), 'not json\n{bad\n', 'utf8')
    const loaded = loadKnowledgeNotes()
    assert.equal(loaded.length, 1)
    assert.equal(at(loaded, 0).id, note.id)
  })
})
