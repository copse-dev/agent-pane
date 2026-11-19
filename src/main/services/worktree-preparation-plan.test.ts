import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containedPreparationPath } from './worktree-preparation-plan.ts'

describe('containedPreparationPath', () => {
  it('accepts a path inside the worktree, including a two-dot name', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-prep-plan-')))
    try {
      assert.equal(containedPreparationPath(root, 'package.json'), join(root, 'package.json'))
      assert.equal(containedPreparationPath(root, '..cache/x'), join(root, '..cache', 'x'))
      assert.throws(() => containedPreparationPath(root, '../x'), /must stay in the worktree/)
      assert.throws(() => containedPreparationPath(root, '..'), /must stay in the worktree/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // `D:foo` is drive-relative, not absolute, so an `isAbsolute(input)` test let
  // it through; it resolves onto another drive, which `relative` reports as an
  // absolute path that no `..` test rejects.
  it(
    'rejects a drive-relative path onto another Windows drive',
    {
      skip: process.platform !== 'win32',
    },
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'copse-prep-plan-')))
      try {
        const other = root.toUpperCase().startsWith('Z:') ? 'Y:foo' : 'Z:foo'
        assert.throws(() => containedPreparationPath(root, other), /must stay in the worktree/)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
