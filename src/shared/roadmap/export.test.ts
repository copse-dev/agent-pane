import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { at } from '../array-utils.ts'
import { expectRecord, expectNumber, expectString, parseJsonUnknown } from '../unknown-value.mts'
import {
  isRoadmapExportFormat,
  RoadmapExporter,
  type RoadmapExportItem,
  type RoadmapExportProject,
} from './export.ts'

/** Minimal STORE-only zip reader, just enough to assert what the exporter wrote. */
function readZip(bytes: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const entries: { path: string; data: Uint8Array }[] = []
  let offset = 0
  while (offset < bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 22, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const path = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    const data = bytes.slice(dataStart, dataStart + size)
    entries.push({ path, data })
    offset = dataStart + size
  }
  return entries
}

const project: RoadmapExportProject = {
  id: 'proj-1',
  name: 'Copse Panel',
  path: '/home/user/copse-panel',
}

function item(overrides: Partial<RoadmapExportItem> = {}): RoadmapExportItem {
  return {
    id: 'item-1',
    title: 'Add deterministic exporter',
    body: 'Build a reusable roadmap exporter.',
    status: 'ready',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    notes: null,
    issue: null,
    complexity: null,
    fit: null,
    fitDetail: null,
    reviewVerdict: null,
    reviewDetail: null,
    reviewAt: null,
    attachments: [],
    ...overrides,
  }
}

describe('isRoadmapExportFormat', () => {
  it('accepts only the four supported formats', () => {
    assert.equal(isRoadmapExportFormat('md'), true)
    assert.equal(isRoadmapExportFormat('html'), true)
    assert.equal(isRoadmapExportFormat('mhtml'), true)
    assert.equal(isRoadmapExportFormat('jsonl'), true)
    assert.equal(isRoadmapExportFormat('pdf'), false)
    assert.equal(isRoadmapExportFormat(undefined), false)
  })
})

describe('RoadmapExporter — no attachments', () => {
  for (const format of ['md', 'html', 'jsonl'] as const) {
    it(`exports a raw ${format} document (not bundled)`, () => {
      const exporter = new RoadmapExporter(project, [item()], {
        exportedAt: '2026-07-27T12:00:00.000Z',
      })
      const result = exporter.export(format)
      assert.equal(result.bundled, false)
      assert.equal(result.filename, `copse-panel-roadmap-2026-07-27.${format}`)
      assert.deepEqual(result.files, [`roadmap.${format}`])
      const text = new TextDecoder().decode(result.data)
      assert.match(text, /Add deterministic exporter/)
    })
  }

  it('embeds mhtml as a single self-contained file', () => {
    const exporter = new RoadmapExporter(project, [item()], {
      exportedAt: '2026-07-27T12:00:00.000Z',
    })
    const result = exporter.export('mhtml')
    assert.equal(result.bundled, false)
    assert.equal(result.filename, 'copse-panel-roadmap-2026-07-27.mhtml')
    assert.deepEqual(result.files, ['roadmap.html'])
    const text = new TextDecoder().decode(result.data)
    assert.match(text, /Content-Type: multipart\/related/)
    assert.match(text, /Content-Location: roadmap\.html/)
  })
})

describe('RoadmapExporter — with attachments', () => {
  const attachmentItem = item({
    attachments: [
      {
        id: 'att-1',
        name: 'notes.txt',
        mimeType: 'text/plain',
        data: new TextEncoder().encode('hello world'),
      },
    ],
  })

  for (const format of ['md', 'html', 'jsonl'] as const) {
    it(`bundles ${format} + attachments into a deterministic zip`, () => {
      const exporter = new RoadmapExporter(project, [attachmentItem], {
        exportedAt: '2026-07-27T12:00:00.000Z',
      })
      const result = exporter.export(format)
      assert.equal(result.bundled, true)
      assert.equal(result.mimeType, 'application/zip')
      assert.equal(result.filename, 'copse-panel-roadmap-2026-07-27.zip')
      assert.deepEqual(result.files, [`roadmap.${format}`, 'attachments/item-1/att-1-notes.txt'])

      const entries = readZip(result.data)
      const paths = entries.map((e) => e.path)
      assert.deepEqual(paths, [`roadmap.${format}`, 'attachments/item-1/att-1-notes.txt'])
      const attachmentEntry = entries.find((e) => e.path === 'attachments/item-1/att-1-notes.txt')
      assert.equal(new TextDecoder().decode(attachmentEntry?.data), 'hello world')

      const docEntry = entries.find((e) => e.path === `roadmap.${format}`)
      const docText = new TextDecoder().decode(docEntry?.data)
      assert.match(docText, /attachments\/item-1\/att-1-notes\.txt/)
    })
  }

  it('embeds attachment bytes inline for mhtml instead of zipping', () => {
    const exporter = new RoadmapExporter(project, [attachmentItem], {
      exportedAt: '2026-07-27T12:00:00.000Z',
    })
    const result = exporter.export('mhtml')
    assert.equal(result.bundled, false)
    assert.equal(result.mimeType, 'application/x-mimearchive')
    assert.deepEqual(result.files, ['roadmap.html', 'attachments/item-1/att-1-notes.txt'])
    const text = new TextDecoder().decode(result.data)
    assert.match(text, /Content-Location: attachments\/item-1\/att-1-notes\.txt/)
    assert.match(text, /Content-Type: text\/plain/)
    // "hello world" base64-encoded
    assert.match(text, /aGVsbG8gd29ybGQ=/)
  })
})

describe('RoadmapExporter — determinism', () => {
  it('produces byte-identical output across repeated calls with the same inputs', () => {
    const items = [
      item(),
      item({
        id: 'item-2',
        title: 'Second item',
        attachments: [
          {
            id: 'att-2',
            name: 'plan.md',
            mimeType: 'text/markdown',
            data: new TextEncoder().encode('plan body'),
          },
        ],
      }),
    ]
    for (const format of ['md', 'html', 'mhtml', 'jsonl'] as const) {
      const a = new RoadmapExporter(project, items, {
        exportedAt: '2026-07-27T00:00:00.000Z',
      }).export(format)
      const b = new RoadmapExporter(project, items, {
        exportedAt: '2026-07-27T00:00:00.000Z',
      }).export(format)
      assert.deepEqual(
        Array.from(a.data),
        Array.from(b.data),
        `${format} export was not deterministic`,
      )
    }
  })
})

describe('RoadmapExporter — content', () => {
  it('includes item metadata fields when present, omits them when null', () => {
    const withFields = item({
      status: 'blocked',
      notes: 'waiting on #42',
      issue: '#42',
      complexity: 'medium',
      fit: 'likely',
      fitDetail: 'closely matches the issue',
      reviewVerdict: 'partial',
      reviewDetail: 'some progress landed',
      reviewAt: '2026-07-10T00:00:00.000Z',
    })
    const exporter = new RoadmapExporter(project, [withFields], {
      exportedAt: '2026-07-27T00:00:00.000Z',
    })
    const md = new TextDecoder().decode(exporter.export('md').data)
    assert.match(md, /status: blocked/)
    assert.match(md, /complexity: medium/)
    assert.match(md, /fit: likely/)
    assert.match(md, /review: partial/)
    assert.match(md, /issue: #42/)
    assert.match(md, /notes: waiting on #42/)

    const bare = new RoadmapExporter(project, [item()], { exportedAt: '2026-07-27T00:00:00.000Z' })
    const bareMd = new TextDecoder().decode(bare.export('md').data)
    assert.doesNotMatch(bareMd, /complexity:/)
    assert.doesNotMatch(bareMd, /fit:/)
  })

  it('escapes item content in the html export', () => {
    const dangerous = item({ title: '<script>alert(1)</script>', body: 'body & <b>bold</b>' })
    const exporter = new RoadmapExporter(project, [dangerous], {
      exportedAt: '2026-07-27T00:00:00.000Z',
    })
    const html = new TextDecoder().decode(exporter.export('html').data)
    assert.doesNotMatch(html, /<script>alert/)
    assert.match(html, /&lt;script&gt;/)
  })

  it('jsonl emits one header line and one line per item', () => {
    const exporter = new RoadmapExporter(project, [item(), item({ id: 'item-2' })], {
      exportedAt: '2026-07-27T00:00:00.000Z',
    })
    const jsonl = new TextDecoder().decode(exporter.export('jsonl').data)
    const lines = jsonl.trimEnd().split('\n')
    assert.equal(lines.length, 3)
    const header = expectRecord(parseJsonUnknown(at(lines, 0)))
    assert.equal(expectString(header['type']), 'roadmap')
    assert.equal(expectNumber(header['itemCount']), 2)
    const first = expectRecord(parseJsonUnknown(at(lines, 1)))
    assert.equal(expectString(first['type']), 'item')
    assert.equal(expectString(first['id']), 'item-1')
  })
})
