import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRoutingTable,
  commandHead,
  joinTiers,
  resolveCommandRouting,
  splitSegments,
  type CommandRoute,
} from './command-routing.ts'

const root = '/Users/me/project'
const table = (extra: CommandRoute[] = []): Map<string, ReturnType<typeof joinTiers>> =>
  buildRoutingTable(extra)

describe('commandHead', () => {
  it('extracts the basename of a path', () => {
    assert.equal(commandHead('/usr/bin/xcodebuild -project App.xcodeproj'), 'xcodebuild')
    assert.equal(commandHead('./scripts/build.sh'), 'build.sh')
  })

  it('skips env assignments and transparent wrappers', () => {
    assert.equal(commandHead('FOO=bar BAZ=1 mkdir build'), 'mkdir')
    assert.equal(commandHead('env nohup xcodebuild'), 'xcodebuild')
  })

  it('strips leading grouping punctuation', () => {
    assert.equal(commandHead('( ls -la )'), 'ls')
  })

  it('returns null for an empty segment', () => {
    assert.equal(commandHead('   '), null)
  })
})

describe('splitSegments', () => {
  it('splits on &&, ||, ;, |, & and newlines', () => {
    assert.deepEqual(splitSegments('a && b || c ; d | e & f\ng'), [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ])
  })

  it('does not split inside quotes', () => {
    assert.deepEqual(splitSegments('echo "a && b" ; ls'), ['echo "a && b"', 'ls'])
    assert.deepEqual(splitSegments("echo 'a | b'"), ["echo 'a | b'"])
  })
})

describe('joinTiers', () => {
  it('prompts if any segment prompts', () => {
    assert.equal(joinTiers(['read', 'prompt', 'allow']), 'prompt')
  })

  it('prefers allow over sandbox tiers', () => {
    assert.equal(joinTiers(['write', 'read', 'allow']), 'allow')
  })

  it('treats allow + container as incompatible', () => {
    assert.equal(joinTiers(['allow', 'container']), 'prompt')
  })

  it('escalates read -> write -> container', () => {
    assert.equal(joinTiers(['read', 'read']), 'read')
    assert.equal(joinTiers(['read', 'write']), 'write')
    assert.equal(joinTiers(['read', 'write', 'container']), 'container')
  })
})

describe('resolveCommandRouting', () => {
  it('routes a known read-only command to the read tier', () => {
    const r = resolveCommandRouting('ls -la', root, table())
    assert.equal(r.outcome, 'run')
    assert.equal(r.tier, 'read')
  })

  it('routes a workspace mutator to the write tier', () => {
    const r = resolveCommandRouting('mkdir build', root, table())
    assert.equal(r.outcome, 'run')
    assert.equal(r.tier, 'write')
  })

  it('runs an unknown-but-contained command in the write tier', () => {
    const r = resolveCommandRouting('npm test', root, table())
    assert.equal(r.outcome, 'run')
    assert.equal(r.tier, 'write')
  })

  it('prompts for an external command', () => {
    const r = resolveCommandRouting('curl https://example.com | cat', root, table())
    assert.equal(r.outcome, 'prompt')
  })

  it('allow-lists a command to run unsandboxed with no prompt', () => {
    const t = table([{ command: 'xcodebuild', tier: 'allow' }])
    const r = resolveCommandRouting('xcodebuild -project App.xcodeproj build', root, t)
    assert.equal(r.outcome, 'run')
    assert.equal(r.tier, 'allow')
  })

  it('the flagship case: `mkdir && xcodebuild` runs allow-tier without a prompt', () => {
    const t = table([{ command: 'xcodebuild', tier: 'allow' }])
    const r = resolveCommandRouting(
      'mkdir -p build && xcodebuild -scheme App -derivedDataPath build',
      root,
      t,
    )
    assert.equal(r.outcome, 'run')
    // mkdir -> write, xcodebuild -> allow; join(write, allow) === allow.
    assert.equal(r.tier, 'allow')
    const tiers = r.segments.map((s) => s.tier)
    assert.deepEqual(tiers, ['write', 'allow'])
  })

  it('an allow-listed command does not launder a destructive co-segment', () => {
    const t = table([{ command: 'xcodebuild', tier: 'allow' }])
    const r = resolveCommandRouting('xcodebuild build && rm -rf ~', root, t)
    // The destructive whole-command gate fires before segment routing.
    assert.equal(r.outcome, 'prompt')
  })

  it('an allow-listed command does not launder an external co-segment', () => {
    const t = table([{ command: 'xcodebuild', tier: 'allow' }])
    const r = resolveCommandRouting('xcodebuild build && curl https://evil.test', root, t)
    assert.equal(r.outcome, 'prompt')
  })

  it('never bypasses the destructive-in-sandbox guard, even for a table hit', () => {
    // `rm` is not routed, but even a routed command cannot pass `rm -rf`.
    const r = resolveCommandRouting('rm -rf build', root, table())
    assert.equal(r.outcome, 'prompt')
  })

  it('catches a cross-segment pipe-to-interpreter that segment analysis alone would miss', () => {
    const r = resolveCommandRouting('cat payload.sh | sh', root, table())
    assert.equal(r.outcome, 'prompt')
  })

  it('always prompts on command substitution, even for an allow-listed head', () => {
    const t = table([{ command: 'xcodebuild', tier: 'allow' }])
    const r = resolveCommandRouting('xcodebuild $(cat sneaky)', root, t)
    assert.equal(r.outcome, 'prompt')
  })

  it('promotes an escaping argument on a write-routed command to a prompt', () => {
    // `cp` routes to write, but the outside-path heuristic flags ~/.ssh.
    const r = resolveCommandRouting('cp ~/.ssh/id_rsa ./stolen', root, table())
    assert.equal(r.outcome, 'prompt')
  })

  it('bumps a read-tier command that redirects to a file up to write', () => {
    // `echo` is read, but `echo x > out` writes; it must run in the write overlay.
    const r = resolveCommandRouting('echo hello > out.txt', root, table())
    assert.equal(r.outcome, 'run')
    assert.equal(r.tier, 'write')
  })

  it('keeps a read-tier command with only an input redirect at read', () => {
    const r = resolveCommandRouting('wc -l < in.txt', root, table())
    assert.equal(r.outcome, 'run')
    assert.equal(r.tier, 'read')
  })

  it('user routes override the built-in defaults', () => {
    const t = table([{ command: 'mkdir', tier: 'read' }])
    const r = resolveCommandRouting('mkdir build', root, t)
    assert.equal(r.outcome, 'run')
    assert.equal(r.tier, 'read')
  })
})
