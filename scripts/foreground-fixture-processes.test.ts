import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureHostPids } from '../tests/e2e/helpers/foreground-fixture-processes.ts'

describe('foreground fixture host process identity', () => {
  let directory = ''
  let root = ''
  let procRoot = ''
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'copse-fixture-process-test-'))
    root = join(directory, 'workspace')
    procRoot = join(directory, 'proc')
    mkdirSync(root)
    root = realpathSync(root)
    mkdirSync(procRoot)
    writeFileSync(join(root, 'pids.json'), JSON.stringify({ parent: 2, child: 3 }))
  })
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function processEntry(pid: number, argv: string[], parent = 1): void {
    const path = join(procRoot, String(pid))
    mkdirSync(path)
    writeFileSync(join(path, 'cmdline'), argv.join('\0') + '\0')
    writeFileSync(join(path, 'status'), `Name:\tnode\nPPid:\t${String(parent)}\n`)
  }

  it('uses host IDs for this exact child and parent, ignoring namespace IDs and other commands', () => {
    processEntry(1001, ['/usr/bin/node', 'hold.cjs'])
    processEntry(1009, ['/usr/bin/node', join(root, 'hold.cjs'), 'child'], 1001)
    processEntry(2, ['/usr/bin/node', '/unrelated/hold.cjs', 'child'])
    processEntry(3, ['bwrap', join(root, 'hold.cjs'), 'child'])
    assert.deepEqual(fixtureHostPids(root, 'linux', procRoot).sort(), [1001, 1009])
  })

  it('retains the verified child when its parent disappears before lookup', () => {
    processEntry(1009, ['/usr/bin/node', join(root, 'hold.cjs'), 'child'], 1001)
    assert.deepEqual(fixtureHostPids(root, 'linux', procRoot), [1009])
  })

  it('never includes a parent whose current command is unrelated', () => {
    processEntry(1001, ['/usr/bin/node', 'unrelated.cjs'])
    processEntry(1009, ['/usr/bin/node', join(root, 'hold.cjs'), 'child'], 1001)
    assert.deepEqual(fixtureHostPids(root, 'linux', procRoot), [1009])
  })

  it('returns no process when the fixture was never started', () => {
    rmSync(join(root, 'pids.json'))
    assert.deepEqual(fixtureHostPids(root, 'linux', procRoot), [])
  })

  it('keeps native-host PID handling limited to positive numeric identities', () => {
    writeFileSync(join(root, 'pids.json'), JSON.stringify({ parent: '2', child: 3 }))
    assert.deepEqual(fixtureHostPids(root, 'darwin', procRoot), [3])
  })
})
