// F3 (docs/plans/hooks-and-feature-packs.md, decision 7): hook processes run
// **inside the project sandbox by default** (reversing the earlier
// outside-sandbox spawn), with the Copse `sandbox: false` per-hook escape as the
// only opt-out. Enforcement is macOS-only (seatbelt), so this pins the routing
// decision + the runner-side signals with an injected FAKE sandbox — no real
// seatbelt is required on Linux CI (F3 acceptance).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  spawnHookProcess,
  setHookSandboxRuntimeForTest,
  type HookSandboxRuntime,
} from './hook-spawn.ts'

/**
 * A fake sandbox runtime that spawns a REAL child (so the stdio / timeout
 * handlers behave exactly as in production) but reports synthetic, runner-side
 * signals — `enabled()` and `violationCount()` are what the fake controls. This
 * is the Linux-CI stand-in for macOS seatbelt.
 */
interface FakeSandbox extends HookSandboxRuntime {
  spawnCalls: number
  afterCalls: number
}

function fakeSandbox(opts: {
  enabled: boolean
  violations?: number
  throwOnSpawn?: boolean
  hangOnSpawn?: boolean
}): FakeSandbox {
  const fake: FakeSandbox = {
    spawnCalls: 0,
    afterCalls: 0,
    enabled: () => opts.enabled,
    spawnShell: (command, spawnOpts): Promise<ChildProcess> => {
      fake.spawnCalls += 1
      if (opts.throwOnSpawn) return Promise.reject(new Error('fake sandbox wrapper failed'))
      if (opts.hangOnSpawn) return new Promise<ChildProcess>(() => {}) // never settles
      const child = spawn(command, {
        cwd: spawnOpts.cwd,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...spawnOpts.env },
      })
      return Promise.resolve(child)
    },
    violationCount: () => opts.violations ?? 0,
    afterCommand: (): void => {
      fake.afterCalls += 1
    },
  }
  return fake
}

describe('hook-spawn — sandbox-by-default reversal (F3)', () => {
  afterEach(() => {
    setHookSandboxRuntimeForTest(null)
  })

  it('routes a default hook through the project sandbox when an OS sandbox is active', async () => {
    const sandbox = fakeSandbox({ enabled: true })
    setHookSandboxRuntimeForTest(sandbox)
    // `sandbox` unset ⇒ default sandboxed.
    const result = await spawnHookProcess("printf '%s' hi", {}, { cwd: process.cwd() })
    assert.equal(sandbox.spawnCalls, 1, 'the sandboxed spawn path was taken')
    assert.equal(result.sandboxed, true)
    assert.equal(result.stdout, 'hi')
    assert.equal(result.exitCode, 0)
    // Per-command sandbox cleanup mirrors the shell tool.
    assert.equal(sandbox.afterCalls, 1)
  })

  it('the `sandbox: false` escape uses the raw unsandboxed spawn', async () => {
    const sandbox = fakeSandbox({ enabled: true })
    setHookSandboxRuntimeForTest(sandbox)
    const result = await spawnHookProcess(
      "printf '%s' hi",
      {},
      { cwd: process.cwd(), sandbox: false },
    )
    assert.equal(sandbox.spawnCalls, 0, 'the sandbox spawner was NOT called for the escape')
    assert.equal(result.sandboxed, false)
    assert.equal(result.sandboxViolationCount, 0)
    assert.equal(result.stdout, 'hi')
  })

  it('runs unsandboxed (macOS-only default, not a guarantee) when the OS sandbox is inactive', async () => {
    const sandbox = fakeSandbox({ enabled: false })
    setHookSandboxRuntimeForTest(sandbox)
    // A default (sandboxed) hook, but no OS boundary ⇒ raw spawn, sandboxed=false.
    const result = await spawnHookProcess("printf '%s' hi", {}, { cwd: process.cwd() })
    assert.equal(sandbox.spawnCalls, 0)
    assert.equal(result.sandboxed, false)
    assert.equal(result.stdout, 'hi')
  })

  it('reports the runner-recorded violation count for a sandboxed run', async () => {
    const sandbox = fakeSandbox({ enabled: true, violations: 3 })
    setHookSandboxRuntimeForTest(sandbox)
    // Exit non-zero to model a blocked hook (the runner keys off exit + violations).
    const result = await spawnHookProcess('exit 1', {}, { cwd: process.cwd() })
    assert.equal(result.sandboxed, true)
    assert.equal(result.sandboxViolationCount, 3)
    assert.equal(result.exitCode, 1)
  })

  it('a sandbox wrapper spawn failure surfaces as spawnError (still marked sandboxed)', async () => {
    const sandbox = fakeSandbox({ enabled: true, throwOnSpawn: true })
    setHookSandboxRuntimeForTest(sandbox)
    const result = await spawnHookProcess('printf hi', {}, { cwd: process.cwd() })
    assert.equal(result.spawnError, true)
    assert.equal(result.sandboxed, true)
    assert.equal(result.exitCode, null)
  })

  it('a wedged sandbox wrapper cannot hang a blocking hook: the timeout races the spawn', async () => {
    const sandbox = fakeSandbox({ enabled: true, hangOnSpawn: true })
    setHookSandboxRuntimeForTest(sandbox)
    // The wrapper promise never settles; without the race, the kill timer never
    // arms (it only exists once a ChildProcess does) and this would hang forever
    // with the run deadline paused (H4).
    const result = await spawnHookProcess('printf hi', {}, { cwd: process.cwd(), timeoutMs: 50 })
    assert.equal(result.spawnError, true)
    assert.equal(result.sandboxed, true)
    assert.equal(result.exitCode, null)
  })
})
