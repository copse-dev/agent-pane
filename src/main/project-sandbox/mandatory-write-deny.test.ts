import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMandatoryWriteDenyMountPath } from './mandatory-write-deny.ts'

describe('isMandatoryWriteDenyMountPath', () => {
  it('names each deny target and the parent directory bwrap creates for it', () => {
    for (const path of [
      '.bashrc',
      '.gitmodules',
      '.mcp.json',
      '.vscode',
      '.claude/',
      '.claude/agents',
      '.copse/agents',
      'packages/app/.zshrc',
      'packages/app/.cursor/',
    ]) {
      assert.equal(isMandatoryWriteDenyMountPath(path), true, path)
    }
  })

  it('rejects ordinary paths and files inside a deny directory', () => {
    for (const path of ['', 'README.md', '.claude/settings.json', '.bashrc/extra', 'agents']) {
      assert.equal(isMandatoryWriteDenyMountPath(path), false, path)
    }
  })
})
