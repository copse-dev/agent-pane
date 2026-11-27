import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { resolveProgramOutsideRoots } from './program-resolution.ts'

describe('resolveProgramOutsideRoots', () => {
  it('finds a program outside the writable roots and refuses stand-ins', () => {
    const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-program-')))
    try {
      const system = join(fixture, 'system')
      const workspace = join(fixture, 'workspace')
      const shim = join(workspace, 'node_modules', '.bin')
      mkdirSync(system)
      mkdirSync(shim, { recursive: true })
      for (const dir of [system, shim]) {
        writeFileSync(join(dir, 'git'), '#!/bin/sh\n')
        chmodSync(join(dir, 'git'), 0o755)
      }
      assert.equal(resolveProgramOutsideRoots('git', system, [workspace]), join(system, 'git'))
      // A writable directory searched first could hold a stand-in.
      assert.equal(
        resolveProgramOutsideRoots('git', [shim, system].join(delimiter), [workspace]),
        null,
      )
      // One searched after the match is never reached.
      assert.equal(
        resolveProgramOutsideRoots('git', [system, shim].join(delimiter), [workspace]),
        join(system, 'git'),
      )
      assert.equal(
        resolveProgramOutsideRoots('git', ['bin', system].join(delimiter), [workspace]),
        null,
      )
      assert.equal(resolveProgramOutsideRoots('./git', system, [workspace]), null)
      assert.equal(resolveProgramOutsideRoots('gh', system, [workspace]), null)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
