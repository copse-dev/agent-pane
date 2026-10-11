import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogScratchEntries,
  expandScratchPath,
  matchesScratchEntry,
} from './acp-scratch-paths.ts'

describe('expandScratchPath', () => {
  it('substitutes ${uid} and emits the /private twin for symlinked roots', () => {
    const uid = String(typeof process.getuid === 'function' ? process.getuid() : 0)
    assert.deepEqual(expandScratchPath('/tmp/claude-${uid}'), [
      `/tmp/claude-${uid}`,
      `/private/tmp/claude-${uid}`,
    ])
  })

  it('expands a too-shallow entry to nothing', () => {
    // These reach the seatbelt's allowWrite list, so a malformed settings entry
    // must expand to nothing rather than to most of the filesystem.
    for (const entry of ['/', '/tmp', '/Users']) {
      assert.deepEqual(expandScratchPath(entry), [], entry)
    }
  })

  it('leaves paths outside the symlinked roots alone', () => {
    assert.deepEqual(expandScratchPath('/opt/agent-scratch'), ['/opt/agent-scratch'])
  })
})

describe('matchesScratchEntry', () => {
  it('matches a literal entry and its subtree, not a sibling with the same prefix', () => {
    assert.equal(matchesScratchEntry('/tmp/claude', '/tmp/claude'), true)
    assert.equal(matchesScratchEntry('/tmp/claude', '/tmp/claude/probe.js'), true)
    assert.equal(matchesScratchEntry('/tmp/claude', '/tmp/claude-501/x'), false)
    assert.equal(matchesScratchEntry('/tmp/claude', '/tmp/other'), false)
  })

  it('matches a glob entry within one segment, as the seatbelt compiles it', () => {
    const cases: Array<[string, string, boolean]> = [
      ['/tmp/claude-*', '/tmp/claude-9f2a-cwd', true],
      ['/tmp/claude-*', '/tmp/claude-', true],
      ['/tmp/claude-*', '/tmp/other', false],
      // ASRT emits `^/tmp/claude-[^/]*$`: no deeper path, so no subtree waiver.
      ['/tmp/claude-*', '/tmp/claude-9f2a/nested/file', false],
      ['/tmp/claude-*', '/tmp/claude-x/y', false],
      ['/var/a.b-*/c', '/var/a.b-1/c', true],
      ['/var/a.b-*/c', '/var/aXb-1/c', false],
    ]
    for (const [entry, path, expected] of cases) {
      assert.equal(matchesScratchEntry(entry, path), expected, `${entry} vs ${path}`)
    }
  })

  it('refuses a glob shallower than two segments', () => {
    // A malformed entry must not waive the filesystem: settings validation keeps
    // these absolute and `..`-free, but says nothing about how shallow they are.
    assert.equal(matchesScratchEntry('/*', '/etc/passwd'), false)
    assert.equal(matchesScratchEntry('/tmp/*', '/tmp/anything'), false)
  })
})

describe('catalogScratchEntries', () => {
  it('carries the TMPDIR Claude Code exports to its own shell', () => {
    // `/tmp/claude` is the value, not bookkeeping: without it every scratch file
    // an obedient agent writes to $TMPDIR reads as a global temp path.
    assert.ok(catalogScratchEntries().includes('/tmp/claude'))
    assert.ok(catalogScratchEntries().includes('/private/tmp/claude'))
  })
})
