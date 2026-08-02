import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ArchiveAttachmentRef } from '@shared/archive/archive-media.ts'
import { applyArchiveToolAvailability, describeThreadArchives } from './thread-archives.ts'

const archive = (name: string, path: string, sizeBytes = 4096): ArchiveAttachmentRef => ({
  name,
  path,
  sizeBytes,
})

const tools = (): { name: string; description: string }[] => [
  { name: 'read_file', description: 'Read a file.' },
  { name: 'read_archive', description: 'Unpack an archive.' },
]

describe('applyArchiveToolAvailability', () => {
  it('withholds read_archive from a thread that has never had an archive', () => {
    const offered = applyArchiveToolAvailability(tools(), [])
    assert.deepEqual(
      offered.map((tool) => tool.name),
      ['read_file'],
    )
  })

  it('offers it once an archive is attached, naming the paths in the description', () => {
    const offered = applyArchiveToolAvailability(tools(), [
      archive('bundle.zip', '/store/t1/blobs/media/uuid-bundle.zip'),
    ])
    assert.deepEqual(
      offered.map((tool) => tool.name),
      ['read_file', 'read_archive'],
    )
    const described = offered.find((tool) => tool.name === 'read_archive')?.description ?? ''
    assert.match(described, /^Unpack an archive\./)
    assert.match(described, /bundle\.zip/)
    assert.match(described, /\/store\/t1\/blobs\/media\/uuid-bundle\.zip/)
  })

  it('leaves other tools untouched', () => {
    const offered = applyArchiveToolAvailability(tools(), [archive('a.zip', '/store/a.zip')])
    assert.equal(offered.find((tool) => tool.name === 'read_file')?.description, 'Read a file.')
  })
})

describe('describeThreadArchives', () => {
  it('lists each archive with a human-readable size', () => {
    assert.equal(
      describeThreadArchives([archive('bundle.zip', '/store/bundle.zip', 1536)]),
      '\n\nArchives attached to this conversation:\n- "bundle.zip" (1.5 KB): /store/bundle.zip',
    )
  })
})
