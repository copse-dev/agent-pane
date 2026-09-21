import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { open } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { localWorkspaceFs } from './local-workspace-fs.ts'
import { WorkspaceFileTooLargeError } from './workspace-fs.ts'
import {
  proposedRasterBytes,
  readWorkspaceFileContent,
  writeWorkspaceFileContent,
} from './file-content.ts'

describe('localWorkspaceFs', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads and writes utf-8 text', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    const file = join(dir, 'a.txt')
    await localWorkspaceFs.writeFile(file, 'hello', 'utf-8')
    assert.equal(await localWorkspaceFs.readFile(file, 'utf-8'), 'hello')
  })

  it('round-trips raster content through the string-based proposed-diff boundary', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    const file = join(dir, 'image.png')
    const bytes = Buffer.from('89504e470d0a1a0a0080ff', 'hex')
    writeFileSync(file, bytes)

    const content = await readWorkspaceFileContent(localWorkspaceFs, file, 'image.png')
    assert.equal(content, bytes.toString('latin1'))

    const updated = Buffer.from('89504e470d0a1a0a0090fe', 'hex')
    await writeWorkspaceFileContent(localWorkspaceFs, file, 'image.png', updated.toString('latin1'))
    assert.deepEqual(await localWorkspaceFs.readFileBytes(file), updated)
    assert.deepEqual(
      proposedRasterBytes('image.png', `data:image/png;base64,${bytes.toString('base64')}`),
      bytes,
    )
  })

  it('lists directory entries with types', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    writeFileSync(join(dir, 'f.ts'), 'x')
    const entries = await localWorkspaceFs.readdirWithTypes(dir)
    assert.deepEqual(entries.map((e) => e.name).sort(), ['f.ts'])
    assert.equal(entries[0]?.isDir, false)
  })

  it('checks a binary size before reading it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    const file = join(dir, 'capture.mp4')
    writeFileSync(file, 'video bytes')

    assert.equal(await localWorkspaceFs.sizeOf(file), 11)
    assert.deepEqual(await localWorkspaceFs.materializeToLocal(file), {
      path: file,
      sizeBytes: 11,
    })
    await assert.rejects(
      () => localWorkspaceFs.readFileBytes(file, { maxBytes: 10 }),
      WorkspaceFileTooLargeError,
    )
  })

  it('reads exactly the binary limit and honors cancellation before opening', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    const path = join(dir, 'image.png')
    const bytes = Buffer.from([0, 128, 255])
    writeFileSync(path, bytes)
    assert.deepEqual(await localWorkspaceFs.readFileBytes(path, { maxBytes: bytes.length }), bytes)
    const abort = new AbortController()
    abort.abort(new Error('cancelled image read'))
    await assert.rejects(
      localWorkspaceFs.readFileBytes(path, { maxBytes: 3, signal: abort.signal }),
      /cancelled image read/,
    )
  })

  it(
    'stops a size-changing stream at the byte limit without waiting for EOF',
    { skip: process.platform === 'win32' },
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
      const path = join(dir, 'stream.png')
      execFileSync('mkfifo', [path])
      // A FIFO reports size zero; bytes arrive after the stat and the writer stays
      // open. An unbounded readFile would wait forever rather than enforce the cap.
      const reading = localWorkspaceFs.readFileBytes(path, { maxBytes: 64 })
      const writer = await open(path, 'w')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await writer.write(Buffer.alloc(65, 255))
        await Promise.race([
          assert.rejects(reading, WorkspaceFileTooLargeError),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('read waited for EOF past the byte limit'))
            }, 3_000)
          }),
        ])
      } finally {
        clearTimeout(timer)
        await writer.close()
      }
    },
  )

  it('realpath and exists agree for a normal file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    const file = join(dir, 'b.txt')
    writeFileSync(file, 'ok')
    assert.equal(await localWorkspaceFs.exists(file), true)
    assert.equal(await localWorkspaceFs.realpath(file), realpathSync.native(file))
  })
})
