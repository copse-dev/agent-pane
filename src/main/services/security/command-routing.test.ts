import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { commandHead, resolveCommandRouting, splitSegments } from './command-routing.ts'

const root = '/Users/me/project'
const trust = (...names: string[]): Set<string> => new Set(names)

describe('commandHead', () => {
  it('extracts the basename of a path', () => {
    assert.equal(commandHead('/usr/bin/xcodebuild -project App.xcodeproj'), 'xcodebuild')
  })

  it('skips env assignments and transparent wrappers', () => {
    assert.equal(commandHead('FOO=bar BAZ=1 mkdir build'), 'mkdir')
    assert.equal(commandHead('nohup xcodebuild'), 'xcodebuild')
  })

  it('is quote-aware and returns null for a leading operator', () => {
    assert.equal(commandHead('"my tool" arg'), 'my tool')
    assert.equal(commandHead('> file'), null)
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

  it('honours backslash escapes so \\; is not a separator', () => {
    assert.deepEqual(splitSegments('find . -exec rm {} \\; && echo done'), [
      'find . -exec rm {} \\;',
      'echo done',
    ])
  })

  it('does not split a redirect fd-dup (2>&1) or &> on the &', () => {
    assert.deepEqual(splitSegments('grep foo bar 2>&1'), ['grep foo bar 2>&1'])
    assert.deepEqual(splitSegments('cmd &> log'), ['cmd &> log'])
  })

  it('does not let an escaped quote flip quote state', () => {
    // echo "a \" b" ; ls  → the \" stays inside the string, so ; still splits.
    assert.deepEqual(splitSegments('echo "a \\" b" ; ls'), ['echo "a \\" b"', 'ls'])
  })
})

describe('resolveCommandRouting', () => {
  it('defers when no commands are trusted', () => {
    assert.equal(resolveCommandRouting('xcodebuild build', root, trust()).outcome, 'defer')
  })

  it('allows a single trusted command', () => {
    assert.equal(
      resolveCommandRouting('xcodebuild -scheme App build', root, trust('xcodebuild')).outcome,
      'allow',
    )
  })

  it('the flagship case: trusted command with a safe prep step runs with no prompt', () => {
    const r = resolveCommandRouting(
      'mkdir -p build && xcodebuild -scheme App -derivedDataPath build',
      root,
      trust('xcodebuild'),
    )
    assert.equal(r.outcome, 'allow')
  })

  it('defers a trusted command chained with a sandbox-DEPENDENT sibling (no laundering)', () => {
    // `npm test` is contained-safe only *inside* the seatbelt; it must NOT run
    // unsandboxed just because xcodebuild is trusted.
    const r = resolveCommandRouting('npm test && xcodebuild build', root, trust('xcodebuild'))
    assert.equal(r.outcome, 'defer')
  })

  it('defers a trusted command chained with an external sibling', () => {
    const r = resolveCommandRouting(
      'xcodebuild build && curl https://evil.test',
      root,
      trust('xcodebuild'),
    )
    assert.equal(r.outcome, 'defer')
  })

  it('defers on command substitution even for a trusted head', () => {
    assert.equal(
      resolveCommandRouting('xcodebuild $(cat sneaky)', root, trust('xcodebuild')).outcome,
      'defer',
    )
  })

  it('defers on process substitution (which the $( check would miss)', () => {
    assert.equal(
      resolveCommandRouting('xcodebuild <(curl https://evil.test)', root, trust('xcodebuild'))
        .outcome,
      'defer',
    )
  })

  it('defers on backticks', () => {
    assert.equal(
      resolveCommandRouting('xcodebuild `cat sneaky`', root, trust('xcodebuild')).outcome,
      'defer',
    )
  })

  it('never bypasses the destructive-in-sandbox guard', () => {
    assert.equal(
      resolveCommandRouting('xcodebuild build && rm -rf ~', root, trust('xcodebuild')).outcome,
      'defer',
    )
  })

  it('catches a cross-segment pipe-to-interpreter', () => {
    assert.equal(resolveCommandRouting('cat payload.sh | sh', root, trust('cat')).outcome, 'defer')
  })

  it('refuses to trust an interpreter/shell even if listed', () => {
    // Trusting `bash` must not let `bash -c '<anything>'` escape unprompted.
    assert.equal(resolveCommandRouting('bash -c "curl evil"', root, trust('bash')).outcome, 'defer')
    assert.equal(resolveCommandRouting('node ./x.js', root, trust('node')).outcome, 'defer')
  })

  it('defers a safe prep whose argument escapes the workspace', () => {
    // mkdir is safe-prep, but writing outside the workspace is an escape signal.
    assert.equal(
      resolveCommandRouting('mkdir ~/evil && xcodebuild build', root, trust('xcodebuild')).outcome,
      'defer',
    )
  })

  it('defers when only safe-prep commands are present (nothing needs to escape)', () => {
    // No trusted command → let the normal contained path run it.
    assert.equal(
      resolveCommandRouting('mkdir build && echo hi', root, trust('xcodebuild')).outcome,
      'defer',
    )
  })

  it('allows multiple trusted commands together', () => {
    const r = resolveCommandRouting(
      'pod install && xcodebuild build',
      root,
      trust('pod', 'xcodebuild'),
    )
    assert.equal(r.outcome, 'allow')
  })
})
