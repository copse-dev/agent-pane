import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearAllowedWorkspaceRootsForTest,
  registerAllowedWorkspaceRoot,
  setWorkspaceRootForTest,
} from '../services/workspace.ts'
import { gatewayReadFile } from './sandbox-fs-client.ts'

describe('sandbox-fs-client', () => {
  it('reads via direct fs when project sandbox is inactive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'copse-sbfs-'))
    try {
      clearAllowedWorkspaceRootsForTest()
      const root = registerAllowedWorkspaceRoot(dir)
      const restore = setWorkspaceRootForTest(root)
      await writeFile(join(dir, 'a.txt'), 'hello', 'utf-8')
      const text = await gatewayReadFile(join(dir, 'a.txt'))
      assert.equal(text, 'hello')
      restore()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
