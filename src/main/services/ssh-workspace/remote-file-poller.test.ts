import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStatCommand,
  parseStatOutput,
  pollRemoteFilesOnce,
  setRemotePollExecForTest,
  stopRemoteFilePolling,
  unwatchRemotePath,
  watchRemotePath,
} from './remote-file-poller.ts'

const TARGET = { hostId: 'dev', remoteRoot: '/srv/app', absPath: '/srv/app/a.ts' }

/** Queue one `stat` stdout per expected tick, capturing the commands sent. */
function fakeExec(outputs: string[]): { commands: string[] } {
  const sent: string[] = []
  let call = 0
  setRemotePollExecForTest((_hostId, _root, command) => {
    sent.push(command)
    const stdout = outputs[call] ?? ''
    call += 1
    return Promise.resolve({ stdout })
  })
  return { commands: sent }
}

afterEach(() => {
  stopRemoteFilePolling()
  setRemotePollExecForTest(null)
})

describe('parseStatOutput', () => {
  it('reads path, mtime and size', () => {
    const parsed = parseStatOutput('/srv/app/a.ts|1700000000|42\n')
    assert.deepEqual(parsed.get('/srv/app/a.ts'), { signature: '1700000000|42', size: 42 })
  })

  it('keeps a filename containing the delimiter', () => {
    const parsed = parseStatOutput('/srv/app/we|ird.ts|1700000000|7\n')
    assert.deepEqual(parsed.get('/srv/app/we|ird.ts'), { signature: '1700000000|7', size: 7 })
  })

  it('discards GNU --file-system output from the fallback branch', () => {
    // What `stat -f '%N|%m|%z' -- path` prints on GNU, where -f is --file-system
    // and the format string is read as another operand.
    const parsed = parseStatOutput(
      '  File: "/srv/app"\n    ID: 9f2b1c4d Namelen: 255     Type: ext2/ext3\n',
    )
    assert.equal(parsed.size, 0)
  })

  it('discards partial and malformed lines', () => {
    const parsed = parseStatOutput('stat: cannot stat gone.ts\n/srv/app/a.ts|notanumber|5\n')
    assert.equal(parsed.size, 0)
  })
})

describe('buildStatCommand', () => {
  it('quotes paths and falls back to the BSD flavour', () => {
    const command = buildStatCommand(['/srv/app/a b.ts'])
    assert.match(command, /stat -c '%n\|%Y\|%s' -- '\/srv\/app\/a b\.ts'/)
    assert.match(command, /\|\| stat -f '%N\|%m\|%z' -- '\/srv\/app\/a b\.ts'/)
  })

  it('escapes a path that would otherwise close the quote and inject a command', () => {
    const command = buildStatCommand(["/srv/app/'; rm -rf /; '.ts"])
    // Each embedded quote becomes '\'' , so the payload stays one shell word.
    assert.ok(command.includes(String.raw`'/srv/app/'\''; rm -rf /; '\''.ts'`))
  })

  it('separates paths from options so a leading-dash filename is not read as a flag', () => {
    assert.match(buildStatCommand(['/srv/app/-rf.ts']), /-- '\/srv\/app\/-rf\.ts'/)
  })
})

describe('pollRemoteFilesOnce', () => {
  it('does not report the first sighting as a change', async () => {
    fakeExec(['/srv/app/a.ts|100|10\n'])
    const seen: number[] = []
    watchRemotePath('k', TARGET, (_key, size) => seen.push(size))

    await pollRemoteFilesOnce()

    assert.deepEqual(seen, [])
  })

  it('reports a changed mtime once the baseline is set', async () => {
    fakeExec(['/srv/app/a.ts|100|10\n', '/srv/app/a.ts|200|10\n'])
    const seen: number[] = []
    watchRemotePath('k', TARGET, (_key, size) => seen.push(size))

    await pollRemoteFilesOnce()
    await pollRemoteFilesOnce()

    assert.deepEqual(seen, [10])
  })

  it('reports a same-mtime write that changed size', async () => {
    // Coarse remote clocks make a same-second rewrite plausible; size is the
    // only signal that distinguishes it.
    fakeExec(['/srv/app/a.ts|100|10\n', '/srv/app/a.ts|100|11\n'])
    const seen: number[] = []
    watchRemotePath('k', TARGET, (_key, size) => seen.push(size))

    await pollRemoteFilesOnce()
    await pollRemoteFilesOnce()

    assert.deepEqual(seen, [11])
  })

  it('stays silent when nothing changed', async () => {
    fakeExec(['/srv/app/a.ts|100|10\n', '/srv/app/a.ts|100|10\n'])
    const seen: number[] = []
    watchRemotePath('k', TARGET, (_key, size) => seen.push(size))

    await pollRemoteFilesOnce()
    await pollRemoteFilesOnce()

    assert.deepEqual(seen, [])
  })

  it('stays silent when a file disappears, then reports its recreation', async () => {
    fakeExec(['/srv/app/a.ts|100|10\n', '', '/srv/app/a.ts|300|12\n'])
    const seen: number[] = []
    watchRemotePath('k', TARGET, (_key, size) => seen.push(size))

    await pollRemoteFilesOnce()
    await pollRemoteFilesOnce()
    assert.deepEqual(seen, [], 'a delete is not broadcast')

    await pollRemoteFilesOnce()
    assert.deepEqual(seen, [12], 'the recreate is')
  })

  it('batches every path for a host into one command', async () => {
    const { commands } = fakeExec(['/srv/app/a.ts|100|10\n/srv/app/b.ts|100|20\n'])
    watchRemotePath('a', TARGET, () => undefined)
    watchRemotePath('b', { ...TARGET, absPath: '/srv/app/b.ts' }, () => undefined)

    await pollRemoteFilesOnce()

    assert.equal(commands.length, 1)
    assert.match(commands[0] ?? '', /a\.ts/)
    assert.match(commands[0] ?? '', /b\.ts/)
  })

  it('sends one command per host', async () => {
    const { commands } = fakeExec(['', ''])
    watchRemotePath('a', TARGET, () => undefined)
    watchRemotePath('b', { hostId: 'other', remoteRoot: '/w', absPath: '/w/c.ts' }, () => undefined)

    await pollRemoteFilesOnce()

    assert.equal(commands.length, 2)
  })

  it('keeps polling other hosts when one fails', async () => {
    const sent: string[] = []
    setRemotePollExecForTest((hostId, _root, command) => {
      sent.push(command)
      return hostId === 'dev'
        ? Promise.reject(new Error('connection closed'))
        : Promise.resolve({ stdout: '' })
    })
    watchRemotePath('a', TARGET, () => undefined)
    watchRemotePath('b', { hostId: 'other', remoteRoot: '/w', absPath: '/w/c.ts' }, () => undefined)

    await pollRemoteFilesOnce()

    assert.equal(sent.length, 2, 'a failing host does not abort the tick')
  })

  it('stops reporting an unwatched path', async () => {
    fakeExec(['/srv/app/a.ts|100|10\n', '/srv/app/a.ts|200|10\n'])
    const seen: number[] = []
    watchRemotePath('k', TARGET, (_key, size) => seen.push(size))

    await pollRemoteFilesOnce()
    unwatchRemotePath('k')
    await pollRemoteFilesOnce()

    assert.deepEqual(seen, [])
  })

  it('ignores a duplicate subscription for the same key', async () => {
    const { commands } = fakeExec(['/srv/app/a.ts|100|10\n'])
    watchRemotePath('k', TARGET, () => undefined)
    watchRemotePath('k', TARGET, () => undefined)

    await pollRemoteFilesOnce()

    assert.equal((commands[0]?.match(/a\.ts/g) ?? []).length, 2, 'one path, in both stat flavours')
  })

  it('does nothing with no subscriptions', async () => {
    const { commands } = fakeExec([])
    await pollRemoteFilesOnce()
    assert.deepEqual(commands, [])
  })
})
