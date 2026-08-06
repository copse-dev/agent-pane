import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasUnquotedPipeline,
  isSigpipeOnlyFailure,
  maybeEnablePipefail,
  pipefailWasInjected,
  SIGPIPE_EXIT_CODE,
} from './shell-pipeline.ts'

describe('hasUnquotedPipeline (issue #787)', () => {
  it('recognizes a real top-level pipeline', () => {
    assert.equal(hasUnquotedPipeline('false | tail -100'), true)
    assert.equal(hasUnquotedPipeline('printf hi | head -1'), true)
    assert.equal(hasUnquotedPipeline('a | b | c'), true)
  })

  it('treats `|&` (pipe including stderr) as a pipeline', () => {
    assert.equal(hasUnquotedPipeline('make |& tail'), true)
  })

  it('does not mistake `||` (logical OR) for a pipeline', () => {
    assert.equal(hasUnquotedPipeline('a || b'), false)
    assert.equal(hasUnquotedPipeline('test -f x || echo missing'), false)
  })

  it('ignores a `|` inside single or double quotes', () => {
    assert.equal(hasUnquotedPipeline("echo 'a|b'"), false)
    assert.equal(hasUnquotedPipeline('echo "a|b"'), false)
    assert.equal(hasUnquotedPipeline("grep 'foo|bar' file"), false)
  })

  it('ignores a backslash-escaped pipe', () => {
    assert.equal(hasUnquotedPipeline('echo a\\|b'), false)
  })

  it('does not confuse an escaped quote for the closing quote', () => {
    // The `|` here is genuinely inside the double-quoted string.
    assert.equal(hasUnquotedPipeline('echo "he said \\"a|b\\""'), false)
    // A real pipe after a quoted segment is still found.
    assert.equal(hasUnquotedPipeline('echo "hi" | cat'), true)
  })

  it('returns false for a command with no pipe', () => {
    assert.equal(hasUnquotedPipeline('xcodebuild -scheme App build'), false)
  })
})

describe('maybeEnablePipefail (issue #787)', () => {
  const mac = { platform: 'darwin' as NodeJS.Platform, isRemote: false }

  it('prefixes a macOS local pipeline with set -o pipefail', () => {
    assert.equal(maybeEnablePipefail('false | tail', mac), 'set -o pipefail\nfalse | tail')
  })

  it('preserves the user command bytes verbatim after the prefix', () => {
    const cmd = 'xcodebuild -scheme App 2>&1 | tail -100'
    assert.equal(maybeEnablePipefail(cmd, mac), `set -o pipefail\n${cmd}`)
  })

  it('leaves a command without a pipeline untouched', () => {
    assert.equal(maybeEnablePipefail('npm run build', mac), 'npm run build')
  })

  it('leaves a command that already controls pipefail untouched', () => {
    const cmd = 'set -o pipefail; make | tail'
    assert.equal(maybeEnablePipefail(cmd, mac), cmd)
  })

  it('preserves behavior on non-macOS shells (dash aborts on set -o pipefail)', () => {
    for (const platform of ['linux', 'win32'] as NodeJS.Platform[]) {
      assert.equal(
        maybeEnablePipefail('false | tail', { platform, isRemote: false }),
        'false | tail',
      )
    }
  })

  it('preserves behavior for remote (SSH) targets of unknown shell', () => {
    assert.equal(
      maybeEnablePipefail('false | tail', { platform: 'darwin', isRemote: true }),
      'false | tail',
    )
  })
})

describe('isSigpipeOnlyFailure', () => {
  it('treats a producer killed by a downstream head as success', () => {
    // `cargo check | grep -E "^error" | head -60`: grep dies of SIGPIPE once head
    // has its 60 lines, and pipefail promotes that to the pipeline's status even
    // though the output is exactly what was asked for.
    assert.equal(isSigpipeOnlyFailure(SIGPIPE_EXIT_CODE, true), true)
  })

  it('leaves every other non-zero status a failure', () => {
    for (const code of [1, 2, 127, 130, 137]) {
      assert.equal(isSigpipeOnlyFailure(code, true), false)
    }
  })

  it('does not second-guess a shell whose pipefail we did not inject', () => {
    assert.equal(isSigpipeOnlyFailure(SIGPIPE_EXIT_CODE, false), false)
  })
})

describe('pipefailWasInjected', () => {
  const mac = { platform: 'darwin' as NodeJS.Platform, isRemote: false }

  it('is true only when maybeEnablePipefail changed the command', () => {
    const piped = 'make | head -5'
    assert.equal(pipefailWasInjected(piped, maybeEnablePipefail(piped, mac)), true)
    const plain = 'npm run build'
    assert.equal(pipefailWasInjected(plain, maybeEnablePipefail(plain, mac)), false)
  })
})
