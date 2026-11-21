import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWorkspaceSymlink, resolveShellPath } from './shell-path-facts.ts'

describe('shell filesystem facts', () => {
  let fixture: string
  let root: string
  let outside: string
  beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'copse-shell-path-')))
    root = join(fixture, 'project')
    outside = join(fixture, 'outside')
    mkdirSync(join(root, 'nested', 'links'), { recursive: true })
    mkdirSync(join(root, 'src'))
    mkdirSync(join(outside, 'child'), { recursive: true })
    writeFileSync(join(root, 'src', 'fixture.txt'), 'fixture')
  })
  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  it('resolves symlinks before a subsequent parent component', () => {
    symlinkSync(join(outside, 'child'), join(root, 'alias'), 'dir')
    assert.equal(resolveShellPath(`${root}/alias/../result`)?.path, join(outside, 'result'))
  })

  it('leaves missing leaves inside their resolved parent and refuses missing traversal', () => {
    assert.equal(
      resolveShellPath(`${root}/new/evidence.log`)?.path,
      join(root, 'new', 'evidence.log'),
    )
    assert.equal(resolveShellPath(`${root}/new/../src/fixture.txt`), null)
    assert.equal(resolveShellPath(`${root}/src/fixture.txt/../result`), null)
    assert.equal(resolveShellPath('relative/path'), null)
  })

  it('refuses symlink loops and observes retargeting immediately', () => {
    symlinkSync('loop-b', join(root, 'loop-a'))
    symlinkSync('loop-a', join(root, 'loop-b'))
    assert.equal(resolveShellPath(`${root}/loop-a/result`), null)
    const alias = join(root, 'alias')
    symlinkSync(join(root, 'src'), alias, 'dir')
    assert.equal(resolveShellPath(`${alias}/fixture.txt`)?.path, join(root, 'src', 'fixture.txt'))
    unlinkSync(alias)
    symlinkSync(outside, alias, 'dir')
    assert.equal(resolveShellPath(`${alias}/fixture.txt`)?.path, join(outside, 'fixture.txt'))
  })

  it('distinguishes replacing a directory symlink with -n from following it', () => {
    symlinkSync(outside, join(root, 'destination'), 'dir')
    const request = {
      target: 'src/fixture.txt',
      linkPath: 'destination',
      workspaceRoot: root,
      noDereference: true,
    }
    assert.equal(isWorkspaceSymlink(request), true)
    assert.equal(isWorkspaceSymlink({ ...request, noDereference: false }), false)
  })

  it('does not waive directory traversal forced by a trailing slash or dot on a link destination', () => {
    symlinkSync(outside, join(root, 'nested', 'links', 'alias'), 'dir')
    for (const linkPath of ['nested/links/alias/', 'nested/links/alias/.']) {
      assert.equal(
        isWorkspaceSymlink({
          target: '../../src/fixture.txt',
          linkPath,
          workspaceRoot: root,
          noDereference: true,
        }),
        false,
        linkPath,
      )
    }
  })

  it('resolves an existing directory destination before anchoring the relative target', () => {
    const request = {
      target: '../src/fixture.txt',
      linkPath: 'nested',
      workspaceRoot: root,
      noDereference: false,
    }
    assert.equal(isWorkspaceSymlink(request), true)
    assert.equal(isWorkspaceSymlink({ ...request, target: '../../outside/result' }), false)
  })

  it('does not mistake a sibling workspace prefix or a chained target for containment', () => {
    const sibling = `${root}-sibling`
    mkdirSync(sibling)
    symlinkSync(outside, join(root, 'escape'), 'dir')
    symlinkSync('escape', join(root, 'chain'), 'dir')
    for (const target of [`${sibling}/fixture`, '../../chain/fixture']) {
      assert.equal(
        isWorkspaceSymlink({
          target,
          linkPath: 'nested/links/evidence',
          workspaceRoot: root,
          noDereference: true,
        }),
        false,
      )
    }
  })
})
