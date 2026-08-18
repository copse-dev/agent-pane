import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectAcpResourceFault,
  formatAcpResourceFault,
  formatOpenFileCeilingWarning,
  inheritedOpenFileLimit,
} from './acp-resource-fault.ts'

describe('detectAcpResourceFault', () => {
  it('reads the descriptor limit off a Claude Code settings-watcher failure', () => {
    const stderr = [
      'Settings watcher error for /Users/dev/.claude/settings.json: Error: EMFILE: too many open files, watch',
      '    at FSWatcher._handle.onchange (node:internal/fs/watchers:267:21) {',
      "  errno: -24,\n  syscall: 'watch',",
    ].join('\n')
    assert.deepEqual(detectAcpResourceFault(stderr), {
      code: 'EMFILE',
      detail:
        'Settings watcher error for /Users/dev/.claude/settings.json: Error: EMFILE: too many open files, watch',
    })
  })

  it('separates the machine-wide table (ENFILE) from the per-process limit', () => {
    assert.equal(detectAcpResourceFault('ENFILE: too many open files, open')?.code, 'ENFILE')
    assert.equal(detectAcpResourceFault('EMFILE: too many open files, open')?.code, 'EMFILE')
    // Neither errno named: still exhaustion, and per-process is the likelier of
    // the two, so it takes the same recycle path.
    assert.equal(detectAcpResourceFault('warn: Too many open files')?.code, 'EMFILE')
  })

  it('ignores stderr that merely names the errno', () => {
    assert.equal(detectAcpResourceFault('retrying after EMFILE'), null)
    assert.equal(detectAcpResourceFault('ENOENT: no such file or directory'), null)
    assert.equal(detectAcpResourceFault(''), null)
  })

  it('clamps a long line so one stderr burst cannot flood the log', () => {
    const fault = detectAcpResourceFault(`${'x'.repeat(400)} too many open files`)
    assert.ok(fault)
    assert.equal(fault.detail.length, 201)
    assert.ok(fault.detail.endsWith('…'))
  })
})

describe('inheritedOpenFileLimit', () => {
  it('reads the limits a spawned agent inherits from this process', () => {
    const limit = inheritedOpenFileLimit()
    // Either a real bound or `null` for "unlimited"; a soft bound never exceeds
    // the hard one, which is what makes the pair worth logging.
    for (const value of [limit.soft, limit.hard]) {
      assert.ok(value === null || (Number.isInteger(value) && value > 0))
    }
    if (limit.soft !== null && limit.hard !== null) assert.ok(limit.soft <= limit.hard)
    assert.equal(inheritedOpenFileLimit(), limit, 'the limit is read once and cached')
  })
})

describe('formatAcpResourceFault', () => {
  it('names the agent, the scope of the exhaustion, and the ceiling it hit', () => {
    const line = formatAcpResourceFault('claude-agent-acp', {
      code: 'EMFILE',
      detail: 'EMFILE: too many open files, watch',
    })
    assert.match(line, /^\[acp:claude-agent-acp\]/)
    assert.match(line, /open-file limit \(EMFILE, inherited open-file limit .+ soft \/ .+ hard\)/)
    assert.ok(line.includes('EMFILE: too many open files, watch'))
  })

  it('says so when the whole machine is out of descriptors', () => {
    const line = formatAcpResourceFault('codex', { code: 'ENFILE', detail: 'ENFILE: ...' })
    assert.match(line, /machine is out of file descriptors \(ENFILE,/)
  })
})

describe('formatOpenFileCeilingWarning', () => {
  it('points at the machine limit rather than at the agent', () => {
    const line = formatOpenFileCeilingWarning('claude-agent-acp')
    assert.match(line, /^\[acp:claude-agent-acp\]/)
    assert.match(line, /its replacement would be too/)
    assert.match(line, /launchctl limit maxfiles/)
    assert.match(line, /restart Copse/)
  })
})
