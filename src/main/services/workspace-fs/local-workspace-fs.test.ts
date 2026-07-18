import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { localWorkspaceFs } from './local-workspace-fs.ts'

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

  it('lists directory entries with types', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    writeFileSync(join(dir, 'f.ts'), 'x')
    const entries = await localWorkspaceFs.readdirWithTypes(dir)
    assert.deepEqual(entries.map((e) => e.name).sort(), ['f.ts'])
    assert.equal(entries[0]?.isDir, false)
  })

  it('realpath and exists agree for a normal file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'copse-wfs-'))
    const file = join(dir, 'b.txt')
    writeFileSync(file, 'ok')
    assert.equal(await localWorkspaceFs.exists(file), true)
    assert.equal(await localWorkspaceFs.realpath(file), file)
  })
})
