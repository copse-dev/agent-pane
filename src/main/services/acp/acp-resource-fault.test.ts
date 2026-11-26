import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  detectAcpResourceFault,
  detectRefusedFileWatch,
  formatAcpResourceFault,
  formatOpenFileCeilingWarning,
  formatRefusedFileWatch,
  inheritedOpenFileLimit,
  localOpenFileLimitLabel,
  watchAgentStderr,
  REMOTE_OPEN_FILE_LIMIT_LABEL,
} from './acp-resource-fault.ts'

describe('detectAcpResourceFault', () => {
  it('does not read a refused settings watch as descriptor exhaustion', () => {
    // Verbatim from claude-agent-acp under the ASRT seatbelt profile: macOS
    // refused the FSEvents stream, and the process could still open files.
    const stderr = [
      'Settings watcher error for /Users/dev/.claude/settings.json: Error: EMFILE: too many open files, watch',
      '    at FSWatcher._handle.onchange (node:internal/fs/watchers:269:21) {',
      "  errno: -24,\n  syscall: 'watch',\n  code: 'EMFILE',\n  filename: null\n}",
    ].join('\n')
    assert.equal(detectAcpResourceFault(stderr), null)
    assert.equal(
      detectRefusedFileWatch(stderr),
      'Settings watcher error for /Users/dev/.claude/settings.json: Error: EMFILE: too many open files, watch',
    )
  })

  it('still reads a watch that could not open its target as exhaustion', () => {
    // Opening the watched path is what fails synchronously, and Node names it.
    const stderr = "Error: EMFILE: too many open files, watch '/Users/dev/repo'"
    assert.equal(detectAcpResourceFault(stderr)?.code, 'EMFILE')
    assert.equal(detectRefusedFileWatch(stderr), null)
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
      detail: 'EMFILE: too many open files, open',
      limitLabel: localOpenFileLimitLabel(),
      observedAt: Date.now(),
    })
    assert.match(line, /^\[acp:claude-agent-acp\]/)
    assert.match(line, /open-file limit \(EMFILE, inherited open-file limit .+ soft \/ .+ hard\)/)
    assert.ok(line.includes('EMFILE: too many open files, open'))
  })

  it('says so when the whole machine is out of descriptors', () => {
    const line = formatAcpResourceFault('codex', {
      code: 'ENFILE',
      detail: 'ENFILE: ...',
      limitLabel: localOpenFileLimitLabel(),
      observedAt: Date.now(),
    })
    assert.match(line, /machine is out of file descriptors \(ENFILE,/)
  })

  it("reports a remote agent under the remote limit, never this machine's numbers", () => {
    const line = formatAcpResourceFault('codex', {
      code: 'EMFILE',
      detail: 'EMFILE: too many open files, open',
      limitLabel: REMOTE_OPEN_FILE_LIMIT_LABEL,
      observedAt: Date.now(),
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
    stderr.emit('data', Buffer.from('Read failed: EMFILE: too many '))
    assert.equal(watcher.current(), null)
    stderr.emit('data', Buffer.from("open files, open '/repo/package.json'\n"))
    assert.equal(watcher.current()?.code, 'EMFILE')
    assert.ok(watcher.current()?.detail.includes('too many open files'))
  })

  it('waits for the end of a line before calling it a fault', () => {
    const stderr = source()
    const watcher = watchAgentStderr(stderr, {
      prefix: 'acp:test-agent',
      command: 'test-agent',
      limitLabel: localOpenFileLimitLabel(),
    })
    // Cut right after the phrase, this line could still be either kind.
    stderr.emit('data', Buffer.from('Settings watcher error: EMFILE: too many open files'))
    assert.equal(watcher.current(), null)
    stderr.emit('data', Buffer.from(', watch\n'))
    assert.equal(watcher.current(), null, 'a refused watch is not a fault')
    assert.ok(watcher.refusedWatch()?.endsWith('too many open files, watch'))
  })

  it('logs a refused watch once, as a refusal, and keeps watching for faults', (t) => {
    const warnings: string[] = []
    t.mock.method(console, 'warn', (line: string) => {
      warnings.push(line)
    })
    const stderr = source()
    const watcher = watchAgentStderr(stderr, {
      prefix: 'acp:claude-agent-acp',
      command: 'claude-agent-acp',
      limitLabel: localOpenFileLimitLabel(),
    })
    for (const file of ['settings.json', 'settings.local.json']) {
      const line = `Settings watcher error for /repo/.claude/${file}: EMFILE: too many open files, watch`
      stderr.emit('data', Buffer.from(`${line}\n`))
    }
    const refusals = warnings.filter((line) => line.includes('cannot watch files'))
    assert.equal(refusals.length, 1)
    assert.equal(
      refusals[0],
      formatRefusedFileWatch('claude-agent-acp', watcher.refusedWatch() ?? ''),
    )
    assert.ok(!warnings.some((line) => line.includes('hit its open-file limit')))
    assert.equal(watcher.current(), null)

    stderr.emit('data', Buffer.from("EMFILE: too many open files, open '/repo/a'\n"))
    assert.equal(watcher.current()?.code, 'EMFILE')
  })

  it('resolves an expensive local limit label only after a fault is detected', () => {
    const stderr = source()
    let reads = 0
    const watcher = watchAgentStderr(stderr, {
      prefix: 'acp:test-agent',
      command: 'test-agent',
      limitLabel: () => {
        reads += 1
        return 'inherited open-file limit 256 soft / 256 hard'
      },
    })

    assert.equal(reads, 0)
    stderr.emit('data', Buffer.from('ordinary diagnostic output\n'))
    assert.equal(reads, 0)
    stderr.emit('data', Buffer.from('EMFILE: too many open files, watch\n'))
    assert.equal(reads, 0, 'a refused watch needs no limit')
    stderr.emit('data', Buffer.from("EMFILE: too many open files, open '/a'\n"))
    assert.equal(reads, 1)
    assert.equal(watcher.current()?.limitLabel, 'inherited open-file limit 256 soft / 256 hard')
    stderr.emit('data', Buffer.from('EMFILE: too many open files, open\n'))
    assert.equal(reads, 1)
  })

  it("labels a remote fault with the remote login's limit", () => {
    const stderr = source()
    const watcher = watchAgentStderr(stderr, {
      prefix: 'acp-ssh:codex',
      command: 'codex',
      limitLabel: REMOTE_OPEN_FILE_LIMIT_LABEL,
    })
    stderr.emit('data', Buffer.from("EMFILE: too many open files, open '/a'\n"))
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
    stderr.emit('data', Buffer.from("first: EMFILE: too many open files, open '/a'\n"))
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
