import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { ATTACHMENTS_FIELD, serializeKnowledgeAttachments } from '@shared/knowledge/attachments.ts'
import { ROADMAP_TYPE } from '../tools/roadmap-tools.ts'
import { buildRoadmapExport } from './roadmap-export.ts'
import { saveKnowledgeAttachments } from './storage/knowledge-attachments.ts'
import {
  addKnowledgeNote,
  setKnowledgeRootForTest,
  updateKnowledgeNote,
} from './storage/knowledge-store.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('buildRoadmapExport', () => {
  let root: string
  let restoreWorkspace: () => void

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'roadmap-export-'))
    setKnowledgeRootForTest(root)
    restoreWorkspace = setWorkspaceRootForTest('/home/dev/my-project')
  })

  afterEach(() => {
    setKnowledgeRootForTest(null)
    restoreWorkspace()
    rmSync(root, { recursive: true, force: true })
  })

  const project = { id: 'proj-1', name: 'My Project', path: '/home/dev/my-project' }

  it('exports the active project roadmap items with no attachments', () => {
    addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Ship the exporter',
      body: 'Build a deterministic roadmap exporter.',
      status: 'ready',
      fields: { notes: 'in progress', complexity: 'medium' },
    })

    const result = buildRoadmapExport(project, 'md', '2026-07-27T00:00:00.000Z')
    assert.equal(result.bundled, false)
    assert.equal(result.filename, 'my-project-roadmap-2026-07-27.md')
    const text = new TextDecoder().decode(result.data)
    assert.match(text, /Ship the exporter/)
    assert.match(text, /complexity: medium/)
    assert.match(text, /notes: in progress/)
  })

  it('resolves attachment bytes from disk and bundles them into a zip', () => {
    const note = addKnowledgeNote({
      type: ROADMAP_TYPE,
      title: 'Item with a file',
      body: 'Prompt body.',
      status: 'ready',
      fields: {},
    })
    const payload = Buffer.from('attached bytes').toString('base64')
    const saved = saveKnowledgeAttachments(note.id, [
      { name: 'plan.txt', mimeType: 'text/plain', dataUrl: `data:text/plain;base64,${payload}` },
    ])
    updateKnowledgeNote(note.id, {
      fields: { [ATTACHMENTS_FIELD]: serializeKnowledgeAttachments(saved) },
    })

    const result = buildRoadmapExport(project, 'html', '2026-07-27T00:00:00.000Z')
    assert.equal(result.bundled, true)
    assert.equal(result.mimeType, 'application/zip')
    assert.ok(result.files.some((f) => f.endsWith('-plan.txt')))
  })

  it('ignores non-roadmap knowledge notes', () => {
    addKnowledgeNote({
      type: 'Memory',
      title: 'Not a roadmap item',
      body: 'Should not appear in the export.',
      status: null,
      fields: {},
    })

    const result = buildRoadmapExport(project, 'jsonl', '2026-07-27T00:00:00.000Z')
    const lines = new TextDecoder().decode(result.data).trimEnd().split('\n')
    assert.equal(lines.length, 1)
  })
})
