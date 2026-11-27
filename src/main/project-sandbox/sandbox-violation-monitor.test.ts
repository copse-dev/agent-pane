import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { initProjectSandbox, isProjectSandboxEnabled, shutdownProjectSandbox } from './index.ts'
import { blockingViolationsAreNetworkOnly, countBlockingViolations } from './spawn.ts'
import { runShellOnce, type ShellRunResult } from '../services/exec/foreground-shell-process.ts'
import { detectSandboxFailure } from '../services/security/sandbox-failure.ts'
import { setGitAvailableForTest } from '../services/tool-availability.ts'

describe('countBlockingViolations', () => {
  it('ignores seatbelt denials that cannot be what failed a command', () => {
    const line = (text: string): { line: string } => ({ line: text })
    assert.equal(
      countBlockingViolations([
        line('bash(1) deny(1) sysctl-read kern.iossupportversion'),
        line('git(2) deny(1) mach-lookup com.apple.coreservices.launchservicesd'),
        // Toolchains read optional files under home on every run (`~/.npmrc`,
        // `$CARGO_HOME/config.toml`, Python's user site), so a refused read
        // says nothing about why a red test run failed.
        line('pnpm(5) deny(1) file-read-data /Users/someone/.npmrc'),
      ]),
      0,
    )
    assert.equal(
      countBlockingViolations([
        line('git(2) deny(1) file-write-create /tmp/project/.git'),
        line('cat(3) deny(1) file-read-data /Users/someone/.ssh/id_ed25519'),
        line('curl(4) deny(1) network-outbound 1.1.1.1:443'),
        line('git(2) deny(1) sysctl-read kern.iossupportversion'),
      ]),
      2,
    )
    // A write whose path spells an incidental clause still counts.
    assert.equal(
      countBlockingViolations([
        line('git(2) deny(1) file-write-create /tmp/deny(1) sysctl-read x'),
      ]),
      1,
    )
    // A line in any other shape (a proxy or seccomp report) still counts.
    assert.equal(countBlockingViolations([line('network denied: example.com:443')]), 1)
  })
})

describe('blockingViolationsAreNetworkOnly', () => {
  const line = (text: string): { line: string } => ({ line: text })

  it('holds when every denial is a refused connection, from the seatbelt or the proxy', () => {
    assert.equal(
      blockingViolationsAreNetworkOnly([
        line('ssh(4) deny(1) network-outbound 140.82.121.4:22'),
        line('deny network-outbound github.com:443 (not in allowlist)'),
        // Incidental denials do not spoil it.
        line('git(2) deny(1) sysctl-read kern.iossupportversion'),
      ]),
      true,
    )
  })

  it('fails closed for any file denial, an unknown shape or no denial', () => {
    // A refused read is not a block on its own, but it still spoils this.
    assert.equal(
      blockingViolationsAreNetworkOnly([
        line('deny network-outbound github.com:443 (not in allowlist)'),
        line('grep(3) deny(1) file-read-data /Users/someone/.ssh/id_ed25519'),
      ]),
      false,
    )
    assert.equal(
      blockingViolationsAreNetworkOnly([
        line('curl(4) deny(1) network-outbound 1.1.1.1:443'),
        line('git(2) deny(1) file-write-create /tmp/project/.git/hooks/x'),
      ]),
      false,
    )
    assert.equal(blockingViolationsAreNetworkOnly([line('network denied: example.com:443')]), false)
    // A denied path or process name can spell a clause of its own; such a line
    // is judged in neither direction.
    assert.equal(
      blockingViolationsAreNetworkOnly([
        line('git(1) deny(1) file-write-create /tmp/deny network-outbound host:443'),
      ]),
      false,
    )
    assert.equal(
      blockingViolationsAreNetworkOnly([
        line('deny network-outbound github.com:443 (not in allowlist)'),
        line('git(1) deny(1) file-write-create /tmp/x deny(1) sysctl-read y'),
      ]),
      false,
    )
    assert.equal(
      blockingViolationsAreNetworkOnly([
        line('bash(1) deny(1) sysctl-read kern.iossupportversion'),
      ]),
      false,
    )
    assert.equal(blockingViolationsAreNetworkOnly([]), false)
  })
})

// The real macOS seatbelt and its log monitor, through the foreground runner
// `run_shell` uses. Before the monitor ran, every count here read 0, so no
// sandbox block was ever verified and `git init` in a project without a
// repository could never be offered the outside retry.
describe('macOS sandbox violation monitor', () => {
  const cleanups: string[] = []
  after(async () => {
    await shutdownProjectSandbox()
    for (const path of cleanups) await rm(path, { recursive: true, force: true })
  })

  const run = (command: string, cwd: string): Promise<ShellRunResult> =>
    runShellOnce(command, cwd, 30_000, new AbortController().signal, false, {})

  it('verifies the block that refuses git init, and only real blocks', async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('the violation monitor runs on macOS only')
      return
    }
    const project = await mkdtemp(join(tmpdir(), 'copse-violation-monitor-'))
    cleanups.push(project)
    setGitAvailableForTest(true)
    await initProjectSandbox()
    if (!isProjectSandboxEnabled()) {
      t.skip('ASRT sandbox unavailable')
      return
    }

    // `log stream` attaches asynchronously and a denial before that is never
    // reported: repeat a denied write outside the workspace until one is seen,
    // so the assertions below are not racing its start. Each attempt is a real
    // sandboxed spawn, so the attempts themselves give it time.
    const outside = join(tmpdir(), '..', `copse-violation-monitor-${String(process.pid)}`)
    let warm: ShellRunResult | undefined
    for (let attempt = 0; attempt < 200; attempt++) {
      warm = await run(`touch '${outside}'`, project)
      if (warm.sandboxViolationCount) break
    }
    assert.ok(warm?.sandboxViolationCount, 'the log monitor never reported a denial')
    assert.equal(existsSync(outside), false)

    const init = await run('git init', project)
    assert.notEqual(init.exitCode, 0)
    assert.match(init.output, /\.git: Operation not permitted/)
    assert.ok(init.sandboxViolationCount, init.output)
    assert.equal(
      detectSandboxFailure({
        exitCode: init.exitCode,
        violationCount: init.sandboxViolationCount ?? 0,
        spawnFailed: false,
      }).likely,
      true,
      'a verified block, so run_shell offers the outside retry',
    )
    assert.equal(existsSync(join(project, '.git')), false)

    // Each attempt counts its own violations, not every earlier run's, and a
    // denial that reaches the store just after the close still counts (about 1
    // run in 20 before the settle wait).
    for (let attempt = 0; attempt < 40; attempt++) {
      const again = await run('git init', project)
      assert.equal(
        again.sandboxViolationCount,
        init.sandboxViolationCount,
        `attempt ${String(attempt)}`,
      )
    }

    // An ordinary failure trips only incidental denials, so it is not a block.
    const missing = await run('ls does-not-exist', project)
    assert.notEqual(missing.exitCode, 0)
    assert.equal(missing.sandboxViolationCount, 0)
    // A failing run that also had a read refused, as a toolchain reading an
    // optional file under home does, is not a block either.
    const homeFile = join(homedir(), `.copse-violation-monitor-${String(process.pid)}`)
    writeFileSync(homeFile, 'x')
    cleanups.push(homeFile)
    const readDenied = await run(`cat '${homeFile}'; exit 1`, project)
    assert.notEqual(readDenied.exitCode, 0)
    assert.match(readDenied.output, /Operation not permitted/)
    assert.equal(readDenied.sandboxViolationCount, 0)
    const ok = await run('mkdir allowed && touch allowed/file', project)
    assert.equal(ok.exitCode, 0, ok.output)
    assert.equal(ok.sandboxViolationCount, 0)
  })
})
