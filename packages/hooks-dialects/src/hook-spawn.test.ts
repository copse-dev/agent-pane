// F3 (docs/plans/hooks-and-feature-packs.md, decision 7): hook processes run
// **inside the project sandbox by default** (reversing the earlier
// outside-sandbox spawn), with the Copse `sandbox: false` per-hook escape as the
// only opt-out. Enforcement is macOS-only (seatbelt), so this pins the routing
// decision + the runner-side signals with an injected FAKE sandbox — no real
// seatbelt is required on Linux CI (F3 acceptance).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  effectiveHookTimeoutMs,
  MAX_HOOK_TIMEOUT_MS,
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

/** Whether `pid` is a live (non-zombie) process, via portable `ps`. */
function processAlive(pid: number): boolean {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' })
    return stat.trim() !== '' && !stat.trim().startsWith('Z')
  } catch {
    return false // ps exits non-zero when the pid is gone
  }
}

describe('hook-spawn — timeout arming', () => {
  afterEach(() => {
    setHookSandboxRuntimeForTest(null)
  })

  it('clamps a timeout beyond setTimeout range instead of overflowing to 1 ms', async () => {
    // A Claude/Cursor `"timeout": 2147484` (seconds) normalizes past 2^31-1 ms;
    // Node would fire that timer after 1 ms and SIGKILL a blocking hook at once.
    const huge = 2_147_484 * 1000
    assert.equal(effectiveHookTimeoutMs(huge), MAX_HOOK_TIMEOUT_MS)
    setHookSandboxRuntimeForTest(fakeSandbox({ enabled: false }))
    const result = await spawnHookProcess(
      'sleep 0.2; printf ok',
      {},
      {
        cwd: process.cwd(),
        timeoutMs: huge,
      },
    )
    assert.equal(result.timedOut, false)
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'ok')
    assert.equal(result.timeoutMs, MAX_HOOK_TIMEOUT_MS)
  })

  it('reports the per-hook timeout it armed', async () => {
    setHookSandboxRuntimeForTest(fakeSandbox({ enabled: false }))
    const result = await spawnHookProcess('sleep 5', {}, { cwd: process.cwd(), timeoutMs: 120 })
    assert.equal(result.timedOut, true)
    assert.equal(result.timeoutMs, 120)
  })

  it(
    'a timeout kills the whole hook process group, not just the shell',
    { skip: process.platform === 'win32' },
    async () => {
      setHookSandboxRuntimeForTest(fakeSandbox({ enabled: false }))
      const result = await spawnHookProcess(
        'sleep 30 & echo $!; wait',
        {},
        {
          cwd: process.cwd(),
          timeoutMs: 300,
        },
      )
      assert.equal(result.timedOut, true)
      const grandchild = Number(result.stdout.trim())
      assert.ok(grandchild > 0, `expected the background pid on stdout, got ${result.stdout}`)
      const deadline = Date.now() + 2_000
      while (processAlive(grandchild) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const orphaned = processAlive(grandchild)
      if (orphaned) process.kill(grandchild, 'SIGKILL')
      assert.equal(orphaned, false, 'the backgrounded grandchild outlived the hook timeout')
    },
  )
})
