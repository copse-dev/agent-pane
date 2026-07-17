import assert from 'node:assert/strict'
import { at } from '@shared/array-utils.ts'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  deleteAllKnowledgeAttachments,
  deleteKnowledgeAttachmentFiles,
  readKnowledgeAttachmentDataUrl,
  saveKnowledgeAttachments,
} from './knowledge-attachments.ts'
import { knowledgeDir, setKnowledgeRootForTest } from './knowledge-store.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'

const PNG_BASE64 = Buffer.from('not-really-a-png').toString('base64')

describe('knowledge-attachments', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'knowledge-att-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  it('writes payloads under attachments/<noteId> and reads them back as data URLs', () => {
    const saved = saveKnowledgeAttachments('note-1', [
      { name: 'shot.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG_BASE64}` },
      {
        name: 'evals.jsonl',
        mimeType: 'application/x-jsonlines',
        dataUrl: `data:application/x-jsonlines;base64,${Buffer.from('{"q":1}\n').toString('base64')}`,
      },
    ])

    assert.equal(saved.length, 2)
    assert.equal(at(saved, 0).name, 'shot.png')
    assert.equal(at(saved, 0).mimeType, 'image/png')
    assert.equal(at(saved, 0).size, 'not-really-a-png'.length)

    const files = readdirSync(join(knowledgeDir(), 'attachments', 'note-1'))
    assert.equal(files.length, 2)
    assert.ok(files.some((f) => f.endsWith('-shot.png')))

    const dataUrl = readKnowledgeAttachmentDataUrl('note-1', at(saved, 0))
    assert.equal(dataUrl, `data:image/png;base64,${PNG_BASE64}`)
  })

  it('honors a charset parameter in the data URL header', () => {
    const saved = saveKnowledgeAttachments('note-1', [
      {
        name: 'notes.txt',
        mimeType: '',
        dataUrl: `data:text/plain;charset=utf-8;base64,${Buffer.from('hi').toString('base64')}`,
      },
    ])
    assert.equal(at(saved, 0).mimeType, 'text/plain')
    assert.equal(at(saved, 0).size, 2)
  })

  it('rejects payloads that are not base64 data URLs', () => {
    assert.throws(() => {
      saveKnowledgeAttachments('note-1', [
        { name: 'x', mimeType: 'text/plain', dataUrl: 'data:text/plain,plain-not-base64' },
      ])
    }, /not a base64 data URL/)
    assert.throws(() => {
      saveKnowledgeAttachments('note-1', [
        { name: 'x', mimeType: 'text/plain', dataUrl: 'https://example.com/x' },
      ])
    }, /not a base64 data URL/)
  })

  it('never touches the filesystem for a path-like note id', () => {
    for (const bad of ['../escape', 'a/b', 'a\\b', '.hidden', '']) {
      assert.throws(() => {
        saveKnowledgeAttachments(bad, [
          { name: 'x', mimeType: 'text/plain', dataUrl: `data:text/plain;base64,${PNG_BASE64}` },
        ])
      }, /Invalid note id/)
    }
  })

  it('falls back to octet-stream for an unparseable stored mime type', () => {
    const saved = saveKnowledgeAttachments('note-1', [
      { name: 'weird', mimeType: 'no slash here', dataUrl: `data:;base64,${PNG_BASE64}` },
    ])
    assert.equal(at(saved, 0).mimeType, 'application/octet-stream')
  })

  it('returns null for a missing payload file', () => {
    assert.equal(
      readKnowledgeAttachmentDataUrl('note-1', {
        id: '0000',
        name: 'gone.png',
        mimeType: 'image/png',
      }),
      null,
    )
  })

  it('deletes individual files and whole note directories', () => {
    const saved = saveKnowledgeAttachments('note-1', [
      { name: 'a.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG_BASE64}` },
      { name: 'b.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${PNG_BASE64}` },
    ])

    deleteKnowledgeAttachmentFiles('note-1', [at(saved, 0)])
    const dir = join(knowledgeDir(), 'attachments', 'note-1')
    assert.equal(readdirSync(dir).length, 1)
    assert.equal(readKnowledgeAttachmentDataUrl('note-1', at(saved, 0)), null)

    deleteAllKnowledgeAttachments('note-1')
    assert.ok(!existsSync(dir))
    // A path-like id is a no-op rather than a throw on the delete path.
    deleteAllKnowledgeAttachments('../escape')
  })
})
