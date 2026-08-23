import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultScratchRoots,
  globalTempWrites,
  isGlobalTempWriteTarget,
  shellWriteTargets,
  type ScratchRoots,
  type ShellObservation,
} from './eval-scratch-paths.mts'

/**
 * Fixed roots rather than the host's, so the assertions mean the same thing on
 * a macOS laptop (`/var/folders/...`) and a Linux runner (`/tmp`).
 */
const ROOTS: ScratchRoots = {
  allowed: ['/Users/dev/.copse/workspace/tmp', '/Users/dev/project'],
  global: ['/tmp', '/private/tmp', '/var/tmp', '/var/folders/9q/xyz/T'],
}

const shellCall = (command: string, name = 'run_shell'): ShellObservation => ({
  name,
  args: { command },
})

const isShellTool = (name: string): boolean =>
  name === 'run_shell' || name === 'run_background' || name.endsWith('.run_shell')

describe('shellWriteTargets', () => {
  it('finds the redirect target that is the whole footgun', () => {
    assert.deepEqual(shellWriteTargets('gh pr view 1842 --json title > /tmp/pr.json'), [
      '/tmp/pr.json',
    ])
  })

  it('finds append and multi-segment redirects', () => {
    assert.deepEqual(shellWriteTargets('echo a >> /tmp/log && echo b > /tmp/other'), [
      '/tmp/log',
      '/tmp/other',
    ])
  })

  it('ignores redirects that open no file', () => {
    assert.deepEqual(shellWriteTargets('npm test > /dev/null 2>&1'), [])
  })

  it('finds argv write targets for the documented verbs', () => {
    assert.deepEqual(shellWriteTargets('rg -c TODO src | tee /tmp/counts.txt'), ['/tmp/counts.txt'])
    assert.deepEqual(shellWriteTargets('mkdir -p /tmp/scratch'), ['/tmp/scratch'])
    assert.deepEqual(shellWriteTargets('touch /tmp/a /tmp/b'), ['/tmp/a', '/tmp/b'])
    assert.deepEqual(shellWriteTargets('curl -o /tmp/page.html https://example.com'), [
      '/tmp/page.html',
    ])
    assert.deepEqual(shellWriteTargets('dd if=/dev/zero of=/tmp/blob bs=1k count=1'), ['/tmp/blob'])
  })

  it('takes only the destination of the copy/move family, not its sources', () => {
    // `cp /tmp/in ./out` reads global temp and writes the workspace, which is a
    // different (and not-failing) shape from writing into global temp.
    assert.deepEqual(shellWriteTargets('cp /tmp/in ./out'), ['./out'])
    assert.deepEqual(shellWriteTargets('mv ./out /tmp/in'), ['/tmp/in'])
  })

  it('finds a copy-family target directory even when it precedes the sources', () => {
    assert.deepEqual(shellWriteTargets('cp -t /tmp ./one ./two'), ['/tmp'])
    assert.deepEqual(shellWriteTargets('mv --target-directory=/var/tmp ./out'), ['/var/tmp'])
    assert.deepEqual(shellWriteTargets('install -m 755 -t /tmp ./tool'), ['/tmp'])
    assert.deepEqual(shellWriteTargets('ln --target-directory /tmp ./target'), ['/tmp'])
  })

  it('treats a bare mktemp as writing nothing, and an explicit template as a target', () => {
    // Bare `mktemp` honours the $TMPDIR the sandbox overlays — the sanctioned
    // form, and the one a scorer must not punish.
    assert.deepEqual(shellWriteTargets('mktemp'), [])
    assert.deepEqual(shellWriteTargets('mktemp /tmp/counts.XXXXXX'), ['/tmp/counts.XXXXXX'])
    assert.deepEqual(shellWriteTargets('mktemp -p /tmp'), ['/tmp'])
    assert.deepEqual(shellWriteTargets('mktemp --tmpdir=/tmp'), ['/tmp'])
  })

  it('sees a redirect hidden inside inline shell code', () => {
    // shell-quote hands back `cmd > /tmp/x` as one quoted token, so the outer
    // parse finds no redirect at all.
    assert.deepEqual(shellWriteTargets(`sh -c 'rg -c TODO src > /tmp/counts.txt'`), [
      '/tmp/counts.txt',
    ])
    assert.deepEqual(shellWriteTargets(`bash -c "echo hi > /tmp/x"`), ['/tmp/x'])
  })

  it('reads nothing as a write', () => {
    for (const command of [
      'cat /tmp/notes.txt',
      'rg TODO /tmp',
      'ls -la /tmp',
      'git diff --stat',
      'node -e "console.log(1)"',
    ]) {
      assert.deepEqual(shellWriteTargets(command), [], command)
    }
  })

  it('returns nothing rather than throwing on a command it cannot parse', () => {
    assert.deepEqual(shellWriteTargets('echo "unterminated'), [])
  })
})

describe('isGlobalTempWriteTarget', () => {
  it('fails a hardcoded global temp path in either macOS spelling', () => {
    assert.equal(isGlobalTempWriteTarget('/tmp/pr.json', ROOTS), true)
    assert.equal(isGlobalTempWriteTarget('/private/tmp/pr.json', ROOTS), true)
    assert.equal(isGlobalTempWriteTarget('/var/tmp/pr.json', ROOTS), true)
  })

  it('passes the sanctioned $TMPDIR and the workspace', () => {
    assert.equal(isGlobalTempWriteTarget('/Users/dev/.copse/workspace/tmp/pr.json', ROOTS), false)
    assert.equal(isGlobalTempWriteTarget('/Users/dev/project/scratch.txt', ROOTS), false)
    assert.equal(isGlobalTempWriteTarget('scratch.txt', ROOTS), false)
    assert.equal(isGlobalTempWriteTarget('./out/scratch.txt', ROOTS), false)
  })

  it('passes a $TMPDIR-relative target without guessing what it expands to', () => {
    for (const target of ['$TMPDIR/pr.json', '${TMPDIR}/pr.json', '$TMP/x', '$TEMP/x']) {
      assert.equal(isGlobalTempWriteTarget(target, ROOTS), false, target)
    }
  })

  it('passes /var/folders when it IS the active $TMPDIR, and fails it otherwise', () => {
    // The distinction the issue calls out: the same path shape is sanctioned on
    // an unsandboxed host and a footgun inside the seatbelt.
    const hostTmp = '/var/folders/9q/xyz/T'
    assert.equal(isGlobalTempWriteTarget(`${hostTmp}/pr.json`, ROOTS), true)
    const unsandboxed: ScratchRoots = { allowed: [hostTmp], global: ROOTS.global }
    assert.equal(isGlobalTempWriteTarget(`${hostTmp}/pr.json`, unsandboxed), false)
  })

  it('says nothing about paths that are neither temp nor sanctioned', () => {
    // Out of scope here — writing to $HOME is the outside-path rule's business.
    assert.equal(isGlobalTempWriteTarget('/Users/dev/elsewhere/x', ROOTS), false)
  })
})

describe('globalTempWrites', () => {
  it('reports the offending command string, not just the path', () => {
    const command = 'gh pr view 1842 --json title > /tmp/pr.json'
    assert.deepEqual(globalTempWrites([shellCall(command)], ROOTS, isShellTool), [
      { tool: 'run_shell', command, target: '/tmp/pr.json' },
    ])
  })

  it('scores a bridged shell call the same as a native one', () => {
    const command = 'echo hi > /tmp/x'
    const writes = globalTempWrites([shellCall(command, 'mcp.copse.run_shell')], ROOTS, isShellTool)
    assert.deepEqual(
      writes.map((w) => w.target),
      ['/tmp/x'],
    )
  })

  it('ignores calls that are not shell tools, and shell calls with no command', () => {
    const notShell = { name: 'write_file', args: { command: 'echo hi > /tmp/x' } }
    assert.deepEqual(globalTempWrites([notShell], ROOTS, isShellTool), [])
    assert.deepEqual(globalTempWrites([{ name: 'run_shell' }], ROOTS, isShellTool), [])
    assert.deepEqual(
      globalTempWrites([{ name: 'run_shell', args: { command: '  ' } }], ROOTS, isShellTool),
      [],
    )
  })

  it('passes a run whose scratch went to $TMPDIR', () => {
    assert.deepEqual(
      globalTempWrites([shellCall('rg -c TODO src > "$TMPDIR/counts.txt"')], ROOTS, isShellTool),
      [],
    )
  })
})

describe('defaultScratchRoots', () => {
  it('resolves $TMPDIR through the same path the sandbox overlays', () => {
    const roots = defaultScratchRoots({
      env: { COPSE_WORKSPACE_DIR: '/Users/dev/.copse/workspace' },
      workspaceRoot: '/Users/dev/project',
    })
    assert.ok(roots.allowed.includes('/Users/dev/.copse/workspace/tmp'))
    assert.ok(roots.allowed.includes('/Users/dev/project'))
    assert.ok(roots.global.includes('/tmp'))
    assert.ok(roots.global.includes('/private/tmp'))
  })

  it('leaves the workspace out when the caller does not know it', () => {
    const roots = defaultScratchRoots({ env: { COPSE_WORKSPACE_DIR: '/w' } })
    assert.deepEqual(roots.allowed, ['/w/tmp', '/private/w/tmp'])
  })
})
