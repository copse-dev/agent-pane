import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CODE_INTERPRETERS,
  PASS_THROUGH_WRAPPERS,
  SCRIPT_EXTENSIONS,
  TRUST_TRANSPARENT_WRAPPERS,
  commandName,
  inlineCodeBody,
  shellSegments,
  unwrapWrappers,
} from './shell-argv.ts'

/** Every argv the lexers produce, as space-joined strings, for readable asserts. */
function segments(command: string): string[] {
  return shellSegments(command).map((argv) => argv.join(' '))
}

/** Does any segment, once unwrapped, start with `head`? */
function reaches(command: string, head: string): boolean {
  return shellSegments(command).some((argv) => commandName(unwrapWrappers(argv)[0]) === head)
}

describe('shellSegments', () => {
  it('splits a compound command at control operators', () => {
    // Both lexers see both commands, so each argv appears twice. Consumers dedupe
    // by reason, which is what makes unioning two incomplete lexers safe.
    assert.deepEqual(segments('echo a && rm -rf b'), ['echo a', 'rm -rf b', 'echo a', 'rm -rf b'])
  })

  it('keeps a globbed operand instead of dropping the target', () => {
    // shell-quote lexes `~/*` to {op:'glob'}. Treating that as a segment boundary
    // discarded the target, so `rm -rf ~/*` reached the harm gate as a bare
    // `rm -rf` and a home-directory wipe degraded to a generic prompt.
    assert.ok(segments('rm -rf ~/*').includes('rm -rf ~/*'))
    assert.ok(segments('rm -rf /work/*').includes('rm -rf /work/*'))
  })

  it('preserves Windows separators that shell-quote reads as escapes', () => {
    assert.ok(
      segments(String.raw`rd /s /q C:\work\project`).includes(String.raw`rd /s /q C:\work\project`),
    )
    assert.ok(
      segments(String.raw`Remove-Item -Recurse -Force C:\Users\tester`).includes(
        String.raw`Remove-Item -Recurse -Force C:\Users\tester`,
      ),
    )
  })

  it('strips matching quotes from a token', () => {
    assert.ok(segments('rm -rf "/work/project"').includes('rm -rf /work/project'))
  })

  it('never throws on input no lexer can parse', () => {
    for (const command of ['rm -rf "unterminated', 'echo $((', '((((']) {
      assert.doesNotThrow(() => shellSegments(command), command)
    }
  })
})

describe('unwrapWrappers', () => {
  it('looks through wrappers that execute their tail unchanged', () => {
    for (const command of [
      'timeout 5 rm -rf /',
      'stdbuf -oL rm -rf /',
      'nohup rm -rf /',
      'env -i rm -rf /',
      'env FOO=1 rm -rf /',
      'FOO=1 rm -rf /',
      'sudo rm -rf /',
      'xargs rm -rf',
      'nice rm -rf /',
    ]) {
      assert.ok(reaches(command, 'rm'), command)
    }
  })

  it('leaves a non-wrapper head alone', () => {
    assert.deepEqual(unwrapWrappers(['git', 'status']), ['git', 'status'])
    assert.deepEqual(unwrapWrappers([]), [])
  })

  it('keeps privilege- and environment-changing wrappers out of the trust-transparent set', () => {
    // Looking deeper is always safe for harm analysis but is a privilege grant for
    // routing: if `commandHead('sudo xcodebuild')` resolved to `xcodebuild`, an
    // allow-list entry for `xcodebuild` would authorise running it as root.
    for (const wrapper of ['sudo', 'env', 'xargs', 'command']) {
      assert.ok(PASS_THROUGH_WRAPPERS.has(wrapper), wrapper)
      assert.ok(!TRUST_TRANSPARENT_WRAPPERS.has(wrapper), wrapper)
    }
  })
})

describe('shared interpreter and script tables', () => {
  it('covers PowerShell alongside the POSIX interpreters', () => {
    for (const exe of ['sh', 'bash', 'zsh', 'node', 'python3', 'ruby', 'perl', 'pwsh']) {
      assert.ok(CODE_INTERPRETERS.has(exe), exe)
    }
  })

  it('recognises script suffixes on every platform the gate claims to cover', () => {
    for (const file of ['deploy.sh', 'build.js', 'x.mjs', 'run.py', 'a.rb', 'w.ps1', 'go.bat']) {
      assert.ok(SCRIPT_EXTENSIONS.test(file), file)
    }
    assert.ok(!SCRIPT_EXTENSIONS.test('README.md'))
  })

  it('finds an inline code body behind any recognised flag', () => {
    assert.equal(inlineCodeBody(['bash', '-c', 'rm -rf /']), 'rm -rf /')
    assert.equal(inlineCodeBody(['node', '--eval', 'x']), 'x')
    assert.equal(inlineCodeBody(['pwsh', '-Command', 'x']), 'x')
    assert.equal(inlineCodeBody(['bash', 'script.sh']), null)
  })
})

describe('commandName', () => {
  it('strips the path and lowercases', () => {
    assert.equal(commandName('/usr/bin/RM'), 'rm')
    assert.equal(commandName('Remove-Item'), 'remove-item')
    assert.equal(commandName(undefined), '')
  })
})
