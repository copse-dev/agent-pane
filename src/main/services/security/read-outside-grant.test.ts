import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  clearReadOutsideProjectGrants,
  grantReadOutsideProject,
  hasReadOutsideProjectGrant,
} from './read-outside-grant.ts'

describe('read-outside grant coverage', () => {
  const thread = 'thread-grant-coverage'
  let base = ''
  let granted = ''

  beforeEach(() => {
    clearReadOutsideProjectGrants()
    base = mkdtempSync(join(tmpdir(), 'copse-grant-coverage-'))
    granted = join(base, 'dir')
    mkdirSync(join(granted, 'sub'), { recursive: true })
    writeFileSync(join(granted, 'sub', 'x'), 'granted')
    writeFileSync(join(base, 'x'), 'sibling of the granted directory')
    grantReadOutsideProject(thread, [granted])
  })

  afterEach(() => {
    clearReadOutsideProjectGrants()
    rmSync(base, { recursive: true, force: true })
  })

  const covered = (target: string): boolean => hasReadOutsideProjectGrant(thread, [target])

  it('covers the directory itself and ordinary descendants', () => {
    assert.equal(covered(granted), true)
    assert.equal(covered(join(granted, 'sub', 'x')), true)
    assert.equal(covered(join(granted, 'not-yet-created', 'file.txt')), true)
    for (const name of ['a b.txt', 'v1.2_final-draft+1@host,x:y%z=w', 'notes-été', '日本語.md']) {
      assert.equal(covered(join(granted, name)), true, `${name} is a plain name`)
    }
  })

  it('does not cover a sibling that only shares the string prefix', () => {
    assert.equal(covered(`${granted}-evil/x`), false)
    assert.equal(covered(`${granted}2/x`), false)
    assert.equal(covered(`${granted}.bak`), false)
  })

  it('normalises `..` segments before comparing', () => {
    assert.equal(covered(`${granted}/../x`), false)
    assert.equal(covered(`${granted}/sub/../../x`), false)
    assert.equal(covered(`${granted}/..`), false)
  })

  // The target is the literal token the agent wrote. The shell expands it after
  // the gate has decided, so any syntax it would expand must not be trusted to
  // stay under the granted directory: `{..,sub}` becomes `dir/../x`.
  it('does not let shell expansion syntax ride on a directory grant', () => {
    const expanding = [
      `${granted}/{..,sub}/x`,
      `${granted}/{sub,..}/x`,
      `${granted}/.*/x`,
      `${granted}/*/x`,
      `${granted}/?/x`,
      `${granted}/[.][.]/x`,
      `${granted}/$'\\x2e\\x2e'/x`,
      `${granted}/$".."/x`,
      `${granted}/$HOME/x`,
      `${granted}/\`echo ..\`/x`,
      `${granted}/a=~/x`,
      `${granted}/\\.\\./x`,
      `${granted}/".."/x`,
      `${granted}/'..'/x`,
      `${granted}/@(..)/x`,
      `${granted}/!(sub)/x`,
      `${granted}/^sub/x`,
      `${granted}/sub#/x`,
    ]
    for (const target of expanding) {
      assert.equal(covered(target), false, `${target} must ask again`)
    }
  })

  it('still answers the exact path that was approved', () => {
    const glob = join(base, '*.txt')
    grantReadOutsideProject(thread, [glob])
    assert.equal(covered(glob), true, 'the same token re-reads what the user approved')
    assert.equal(covered(join(base, '*.md')), false)
  })
})
