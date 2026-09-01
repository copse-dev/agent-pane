import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CODE_INTERPRETERS,
  PASS_THROUGH_WRAPPERS,
  SCRIPT_EXTENSIONS,
  TRUST_TRANSPARENT_WRAPPERS,
  commandName,
  inlineCodeBody,
  isReadOnlySimpleCommand,
  isStructurallyReadOnlyShellCommand,
  shellRedirects,
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

  it('consumes a wrapper option whose value is a separate argument', () => {
    // Only flag-shaped tokens were dropped, so `root` became argv[0] and the real
    // command was never reached.
    for (const command of [
      'sudo -u root rm -rf /',
      'sudo --user root rm -rf /',
      'nice -n 10 rm -rf /',
      'ionice -c 3 -n 7 rm -rf /',
      'xargs -n 1 rm -rf /',
      'xargs -I {} rm -rf /',
      'timeout -s KILL 5 rm -rf /',
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
    for (const wrapper of ['sudo', 'env', 'xargs', 'command', 'exec']) {
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

describe('shellRedirects', () => {
  it('reports write targets and whether the write truncates', () => {
    assert.deepEqual(shellRedirects('echo x > out.txt'), [{ target: 'out.txt', truncates: true }])
    assert.deepEqual(shellRedirects('echo x >> a.log'), [{ target: 'a.log', truncates: false }])
    assert.deepEqual(shellRedirects(': > ~/.ssh/id_rsa'), [
      { target: '~/.ssh/id_rsa', truncates: true },
    ])
  })

  it('ignores reads and file-descriptor duplication, which write no file', () => {
    assert.deepEqual(shellRedirects('sort < src/in.txt'), [])
    assert.deepEqual(shellRedirects('cmd 2>&1'), [])
  })

  it('finds the write target on either side of a control operator', () => {
    assert.deepEqual(shellRedirects('echo a > one.txt && echo b > two.txt'), [
      { target: 'one.txt', truncates: true },
      { target: 'two.txt', truncates: true },
    ])
  })

  it('keeps redirect targets out of the argv segments', () => {
    // A relative path after `>` or `<` used to become a segment head, so callers
    // mistook the file for an executable they should read.
    for (const command of ['echo x > dist/out.txt', 'sort < src/in.txt']) {
      for (const argv of shellSegments(command)) {
        assert.notEqual(argv[0], 'dist/out.txt', command)
        assert.notEqual(argv[0], 'src/in.txt', command)
      }
    }
  })

  it('drops attached redirects isolated by the raw fallback splitter', () => {
    const command = String.raw`find . -exec grep yolo {} \; 2>/dev/null`
    const argvSegments = shellSegments(command)
    assert.ok(argvSegments.some((argv) => argv[0] === 'find'))
    for (const argv of argvSegments) {
      assert.notEqual(argv[0], '2>/dev/null')
    }
    assert.deepEqual(shellRedirects(command), [{ target: '/dev/null', truncates: true }])
  })
})

describe('commandName', () => {
  it('strips the path and lowercases', () => {
    assert.equal(commandName('/usr/bin/RM'), 'rm')
    assert.equal(commandName('Remove-Item'), 'remove-item')
    assert.equal(commandName(undefined), '')
  })
})

describe('read-only classification and its escape hatches', () => {
  it('accepts genuine read/query commands and pipelines of them', () => {
    for (const command of [
      'cat data.txt',
      'ls -la',
      'head -n 20 data.txt',
      'sort -u data.txt',
      'sort -rn data.txt',
      'grep -o foo data.txt',
      'file data.txt',
      'fd . -e ts',
      'rg --json foo',
      'grep foo data.txt | sort | uniq -c',
      'git log --oneline',
    ]) {
      assert.equal(isStructurallyReadOnlyShellCommand(command), true, command)
    }
  })

  it('rejects an allow-listed command pointed at a program to run', () => {
    // The allow-list is by basename, so a flag that takes a program turns a
    // "read-only" command into a launcher: these run ./tool.sh, while
    // `./tool.sh` on its own line is opaque local execution and prompts.
    for (const command of [
      'sort --compress-program=./tool.sh data.txt',
      'sort --compress-program ./tool.sh data.txt',
      'fd . -x ./tool.sh',
      'fd . --exec ./tool.sh',
      'fd . -X ./tool.sh',
      'fd . --exec-batch ./tool.sh',
      'rg --pre ./tool.sh foo',
      'rg --hostname-bin=./tool.sh foo',
    ]) {
      assert.equal(isStructurallyReadOnlyShellCommand(command), false, command)
    }
  })

  it('rejects an allow-listed command pointed at a file to write', () => {
    for (const command of [
      'sort -o out.txt data.txt',
      'sort --output=out.txt data.txt',
      'sort --output out.txt data.txt',
      'sort -uo out.txt data.txt',
      'tree -o out.txt',
      'file -C -m magic',
    ]) {
      assert.equal(isStructurallyReadOnlyShellCommand(command), false, command)
    }
  })

  it('matches escape-hatch flags per command, never globally', () => {
    // `-o` is an output file for sort and tree but "only matching" for grep,
    // so the table has to stay keyed by command.
    assert.equal(isReadOnlySimpleCommand('grep -o foo data.txt'), true)
    assert.equal(isReadOnlySimpleCommand('sort -o out.txt data.txt'), false)
    // A bare `-` is stdin, not a flag.
    assert.equal(isReadOnlySimpleCommand('sort -'), true)
  })
})
