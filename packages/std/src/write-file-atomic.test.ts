import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic, writeFileAtomicSync } from './write-file-atomic.ts'
import type { WriteFileAtomicOptions } from './write-file-atomic.ts'

type Write = (path: string, data: string | Uint8Array, options?: WriteFileAtomicOptions) => unknown

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'std-write-file-atomic-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const posix = process.platform !== 'win32'

const forms: [string, Write][] = [
  ['writeFileAtomic', writeFileAtomic],
  ['writeFileAtomicSync', writeFileAtomicSync],
]

for (const [name, write] of forms) {
  describe(name, () => {
    it('creates missing parents, replaces an existing file and leaves no temp file', async () => {
      await withDir(async (dir) => {
        const path = join(dir, 'a', 'b', 'state.json')
        await write(path, 'first')
        assert.equal(await readFile(path, 'utf8'), 'first')
        await write(path, new TextEncoder().encode('second'))
        assert.equal(await readFile(path, 'utf8'), 'second')
        assert.deepEqual(await readdir(join(dir, 'a', 'b')), ['state.json'])
      })
    })

    it('honours encoding, and mode / directoryMode on POSIX', async () => {
      await withDir(async (dir) => {
        const path = join(dir, 'private', 'secret.txt')
        await write(path, '6869', {
          encoding: 'hex',
          mode: 0o600,
          directoryMode: 0o700,
          flush: true,
        })
        assert.equal(await readFile(path, 'utf8'), 'hi')
        if (posix) {
          assert.equal((await stat(path)).mode & 0o777, 0o600)
          assert.equal((await stat(join(dir, 'private'))).mode & 0o777, 0o700)
        }
      })
    })

    it('removes the temp file and rethrows when the rename fails', async () => {
      await withDir(async (dir) => {
        // A non-empty directory at the target makes the rename fail after the write.
        const path = join(dir, 'occupied')
        await mkdir(path)
        await writeFile(join(path, 'keep'), 'x')
        await assert.rejects(async () => {
          await write(path, 'data')
        })
        assert.deepEqual(await readdir(dir), ['occupied'])
      })
    })
  })
}

describe('writeFileAtomic concurrency', () => {
  it('lets overlapping writes to one path each land whole, with no temp collisions', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'shared.json')
      const bodies = Array.from({ length: 25 }, (_, i) =>
        JSON.stringify({ i, pad: 'x'.repeat(4096) }),
      )
      await Promise.all(bodies.map((body) => writeFileAtomic(path, body)))
      assert.ok(bodies.includes(await readFile(path, 'utf8')))
      assert.deepEqual(await readdir(dir), ['shared.json'])
    })
  })
})
