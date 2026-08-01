import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createZipArchive, type ZipEntry } from '../storage/zip-archive.ts'
import {
  MAX_COMPRESSION_RATIO,
  MAX_EXTRACTED_BYTES,
  extractArchiveForThread,
} from './archive-extract.ts'

const MODIFIED = new Date(2026, 2, 4, 5, 6, 8)
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

function zip(files: Record<string, string>): Promise<Uint8Array> {
  return createZipArchive(
    Object.entries(files).map(([path, body]) => ({
      path,
      data: utf8(body),
      modifiedAt: MODIFIED,
    })),
  )
}

/**
 * The writer refuses nothing about entry names, which is what makes it usable
 * here: a hostile archive is just one with an entry named `../escape`.
 */
function hostileZip(paths: string[]): Promise<Uint8Array> {
  const entries: ZipEntry[] = paths.map((path) => ({
    path,
    data: utf8('pwned'),
    modifiedAt: MODIFIED,
  }))
  return createZipArchive(entries)
}

describe('extractArchiveForThread', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-archive-extract-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  const extract = (
    bytes: Uint8Array,
    name = 'bundle.zip',
  ): ReturnType<typeof extractArchiveForThread> =>
    extractArchiveForThread({ projectId: 'p1', threadId: 't1', name, bytes })

  it('unpacks into the thread directory so the read tools can reach it', async () => {
    const result = await extract(
      await zip({ 'README.md': '# hi', 'src/app.ts': 'export const a = 1\n' }),
    )

    assert.deepEqual(
      result.files.map((file) => file.path),
      ['README.md', 'src/app.ts'],
    )
    // Inside the chat store, which `resolveReadablePath` already accepts.
    assert.ok(result.root.startsWith(join(root, 'p1', 't1')), result.root)
    assert.equal(readFileSync(join(result.root, 'src', 'app.ts'), 'utf8'), 'export const a = 1\n')
    assert.equal(result.reused, false)
    assert.equal(result.truncated, false)
  })

  it('reuses an identical archive rather than unpacking it twice', async () => {
    const bytes = await zip({ 'a.txt': 'a' })
    const first = await extract(bytes)
    const second = await extract(bytes)

    assert.equal(second.root, first.root)
    assert.equal(second.reused, true)
    assert.deepEqual(
      second.files.map((file) => file.path),
      ['a.txt'],
    )
  })

  it('gives a changed archive of the same name its own directory', async () => {
    const first = await extract(await zip({ 'a.txt': 'one' }))
    const second = await extract(await zip({ 'a.txt': 'two' }))

    assert.notEqual(second.root, first.root)
    assert.equal(readFileSync(join(first.root, 'a.txt'), 'utf8'), 'one')
    assert.equal(readFileSync(join(second.root, 'a.txt'), 'utf8'), 'two')
  })

  it('refuses entries that try to escape the extraction root', async () => {
    const result = await extract(
      await hostileZip(['../escape.txt', 'nested/../../escape.txt', '/etc/passwd', 'safe.txt']),
    )

    assert.deepEqual(
      result.files.map((file) => file.path),
      ['safe.txt'],
    )
    assert.equal(result.skipped.length, 3)
    assert.ok(result.skipped.every((entry) => entry.reason.includes('escapes')))
    // The decisive check: nothing landed beside the thread directory.
    assert.equal(existsSync(join(root, 'p1', 'escape.txt')), false)
    assert.equal(existsSync(join(root, 'escape.txt')), false)
  })

  it('stops before a zip bomb lands and leaves nothing behind', async () => {
    // Highly repetitive content compresses far past the ratio ceiling.
    const bytes = await zip({ 'bomb.txt': 'a'.repeat(4 * 1024 * 1024) })
    assert.ok(
      4 * 1024 * 1024 > bytes.length * MAX_COMPRESSION_RATIO,
      'fixture must exceed the ratio ceiling to exercise it',
    )

    await assert.rejects(extract(bytes), /expands to more than/)
    // The staging directory is removed, so a later call does not "reuse" a
    // half-written extraction.
    assert.equal(existsSync(join(root, 'p1', 't1', 'blobs', 'archives')), true)
    const result = await extract(await zip({ 'a.txt': 'a' }))
    assert.deepEqual(
      result.files.map((file) => file.path),
      ['a.txt'],
    )
  })

  it('skips directory entries, which extraction recreates from the paths', async () => {
    const result = await extract(
      await createZipArchive([
        { path: 'nested/', data: new Uint8Array(), modifiedAt: MODIFIED },
        { path: 'nested/file.txt', data: utf8('x'), modifiedAt: MODIFIED },
      ]),
    )

    assert.deepEqual(
      result.files.map((file) => file.path),
      ['nested/file.txt'],
    )
    assert.equal(readFileSync(join(result.root, 'nested', 'file.txt'), 'utf8'), 'x')
  })

  it('reports a non-zip rather than creating an empty extraction', async () => {
    await assert.rejects(extract(utf8('this is not an archive')), /Not a zip file/)
  })

  it('bounds the total it will write', () => {
    // A guard against the cap being raised without thinking about main-process
    // memory: every entry is read into a buffer before it is written.
    assert.ok(MAX_EXTRACTED_BYTES <= 1024 * 1024 * 1024)
  })
})
