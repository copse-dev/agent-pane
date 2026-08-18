import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  detectAcpResourceFault,
  formatAcpResourceFault,
  formatOpenFileCeilingWarning,
  inheritedOpenFileLimit,
  localOpenFileLimitLabel,
  watchAgentStderr,
  REMOTE_OPEN_FILE_LIMIT_LABEL,
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
      limitLabel: localOpenFileLimitLabel(),
    })
    assert.match(line, /^\[acp:claude-agent-acp\]/)
    assert.match(line, /open-file limit \(EMFILE, inherited open-file limit .+ soft \/ .+ hard\)/)
    assert.ok(line.includes('EMFILE: too many open files, watch'))
  })

  it('says so when the whole machine is out of descriptors', () => {
    const line = formatAcpResourceFault('codex', {
      code: 'ENFILE',
      detail: 'ENFILE: ...',
      limitLabel: localOpenFileLimitLabel(),
    })
    assert.match(line, /machine is out of file descriptors \(ENFILE,/)
  })

  it("reports a remote agent under the remote limit, never this machine's numbers", () => {
    const line = formatAcpResourceFault('codex', {
      code: 'EMFILE',
      detail: 'EMFILE: too many open files, watch',
      limitLabel: REMOTE_OPEN_FILE_LIMIT_LABEL,
    })
    assert.ok(line.includes(REMOTE_OPEN_FILE_LIMIT_LABEL))
    assert.doesNotMatch(line, /soft \/ /, 'a local rlimit names the wrong host')
  })
})

describe('formatOpenFileCeilingWarning', () => {
  it('points at the machine limit rather than at the agent', () => {
    const line = formatOpenFileCeilingWarning('claude-agent-acp')
    assert.match(line, /^\[acp:claude-agent-acp\]/)
    assert.match(line, /replacement agent ran out of file descriptors just as fast/)
    assert.match(line, /respawning cannot fix this/)
    assert.match(line, /launchctl limit maxfiles/)
    assert.match(line, /restart Copse/)
  })
})

describe('watchAgentStderr', () => {
  function source(): EventEmitter & { emit: (event: 'data', chunk: Buffer) => boolean } {
    return new EventEmitter()
  }

  it('catches a fault split across chunk boundaries', () => {
    const stderr = source()
    const watcher = watchAgentStderr(stderr, {
      prefix: 'acp:test-agent',
      command: 'test-agent',
      limitLabel: localOpenFileLimitLabel(),
    })
    // stderr arrives on arbitrary boundaries — mid-phrase here, which is what
    // scanning each chunk in isolation used to miss.
    stderr.emit('data', Buffer.from('Settings watcher error: EMFILE: too many '))
    assert.equal(watcher.current(), null)
    stderr.emit('data', Buffer.from('open files, watch\n'))
    assert.equal(watcher.current()?.code, 'EMFILE')
    assert.ok(watcher.current()?.detail.includes('too many open files'))
  })

  it("labels a remote fault with the remote login's limit", () => {
    const stderr = source()
    const watcher = watchAgentStderr(stderr, {
      prefix: 'acp-ssh:codex',
      command: 'codex',
      limitLabel: REMOTE_OPEN_FILE_LIMIT_LABEL,
    })
    stderr.emit('data', Buffer.from('EMFILE: too many open files, watch\n'))
    assert.equal(watcher.current()?.limitLabel, REMOTE_OPEN_FILE_LIMIT_LABEL)
  })

  it('reports only the first fault, and hands every chunk to its caller', () => {
    const stderr = source()
    const seen: string[] = []
    const watcher = watchAgentStderr(stderr, {
      prefix: 'acp:test-agent',
      command: 'test-agent',
      limitLabel: localOpenFileLimitLabel(),
      onText: (text) => seen.push(text),
    })
    stderr.emit('data', Buffer.from('first: EMFILE: too many open files, watch\n'))
    const first = watcher.current()
    stderr.emit('data', Buffer.from('second: EMFILE: too many open files, open\n'))
    assert.equal(watcher.current(), first)
    assert.equal(seen.length, 2, 'the stderr tail a caller keeps must see everything')
  })

  it('tolerates an agent spawned without a stderr pipe', () => {
    const watcher = watchAgentStderr(null, {
      prefix: 'acp:test-agent',
      command: 'test-agent',
      limitLabel: localOpenFileLimitLabel(),
    })
    assert.equal(watcher.current(), null)
  })
})
