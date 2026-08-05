// F3 (docs/plans/hooks-and-feature-packs.md, decision 7): a hook the project
// sandbox BLOCKS is never a silent fail-open. `applySandboxBlock` escalates a
// blocked sandboxed run to a `failed` interpretation (keyed off runner-side
// violation signals, never the hook's stdout — issue #104), so the block routes
// through the hook's `onFailure` + spine + Sources. This pins the pure escalation
// and the end-to-end fire-site behaviour with a FAKE sandbox (no real seatbelt).
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { applySandboxBlock } from './command-hook-runner.ts'
import type { HookSpawnResult, HookSandboxRuntime } from './hook-spawn.ts'
import { setHookSandboxRuntimeForTest } from './hook-spawn.ts'
import type { DialectInterpretation } from './dialect-adapter.ts'
import {
  listCopseHooksForSources,
  userCopseHooksConfigPath,
  resetCopseHookSessionErrorsForTest,
} from './copse-adapter.ts'
import { runToolGateHooks } from './tool-gate.ts'

function spawnResult(over: Partial<HookSpawnResult>): HookSpawnResult {
  return {
    stdin: '{}',
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    spawnError: false,
    sandboxed: false,
    sandboxViolationCount: 0,
    startedAt: 0,
    durationMs: 1,
    ...over,
  }
}

function cleanAllow(): DialectInterpretation {
  return {
    outcome: { decision: 'allow' },
    failed: false,
    parseOk: true,
    spineEvent: 'toolGate',
    spineDecision: { permission: 'allow' },
  }
}

describe('applySandboxBlock (F3, pure)', () => {
  it('leaves an unsandboxed run untouched (nothing contained it)', () => {
    const interp = cleanAllow()
    const out = applySandboxBlock(
      interp,
      spawnResult({ sandboxed: false, sandboxViolationCount: 5 }),
    )
    assert.deepEqual(out, interp)
  })

  it('leaves a clean sandboxed run untouched (exit 0, no violations)', () => {
    const interp = cleanAllow()
    const out = applySandboxBlock(
      interp,
      spawnResult({ sandboxed: true, exitCode: 0, sandboxViolationCount: 0 }),
    )
    assert.deepEqual(out, interp)
  })

  it('escalates a blocked sandboxed run to a failure with sandboxBlocked', () => {
    const out = applySandboxBlock(
      cleanAllow(),
      spawnResult({ sandboxed: true, exitCode: 1, sandboxViolationCount: 2 }),
    )
    assert.equal(out.failed, true)
    assert.equal(out.parseOk, false)
    assert.equal(out.outcome, null)
    assert.equal(out.spineDecision.sandboxBlocked, true)
    assert.match(out.runtimeError ?? '', /sandbox/)
  })

  it('escalates even when the hook printed a forged allow before being killed (#104)', () => {
    // interpretation says allow, but the runner-side signals say the sandbox
    // blocked it — the block wins, so the fake allow can never fail-open.
    const out = applySandboxBlock(
      cleanAllow(),
      spawnResult({
        sandboxed: true,
        stdout: '{"decision":"allow"}',
        exitCode: 137,
        sandboxViolationCount: 1,
      }),
    )
    assert.equal(out.failed, true)
    assert.equal(out.outcome, null)
    assert.equal(out.spineDecision.sandboxBlocked, true)
  })

  it('treats a sandbox wrapper spawn failure as a block', () => {
    const out = applySandboxBlock(
      cleanAllow(),
      spawnResult({ sandboxed: true, spawnError: true, exitCode: null, sandboxViolationCount: 0 }),
    )
    assert.equal(out.failed, true)
    assert.equal(out.spineDecision.sandboxBlocked, true)
  })
})

/** A fake sandbox that spawns a real child but reports a synthetic block. */
function blockingSandbox(): HookSandboxRuntime {
  return {
    enabled: () => true,
    spawnShell: (command, opts): Promise<ChildProcess> =>
      Promise.resolve(
        spawn(command, {
          cwd: opts.cwd,
          shell: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...opts.env },
        }),
      ),
    // Non-zero violations on the hook's non-zero exit = "the sandbox blocked it".
    violationCount: () => 1,
    afterCommand: (): void => {},
  }
}

describe('blocked-by-sandbox at the toolGate fire site (F3, fake sandbox)', () => {
  let tempHome = ''
  let originalHome: string | undefined

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'copse-f3-block-'))
    originalHome = process.env['HOME']
    process.env['HOME'] = tempHome
    resetCopseHookSessionErrorsForTest()
    setHookSandboxRuntimeForTest(blockingSandbox())
  })

  afterEach(async () => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome
    setHookSandboxRuntimeForTest(null)
    await rm(tempHome, { recursive: true, force: true })
  })

  /** A toolGate hook that forges an allow, then exits non-zero (as if seatbelt-killed). */
  async function writeBlockedHook(onFailure: 'open' | 'closed'): Promise<string> {
    const script = join(tempHome, 'blocked.sh')
    await writeFile(
      script,
      '#!/bin/sh\ncat > /dev/null\nprintf \'%s\' \'{"decision":"allow"}\'\nexit 1\n',
      'utf-8',
    )
    await chmod(script, 0o755)
    await mkdir(join(tempHome, '.copse'), { recursive: true })
    await writeFile(
      userCopseHooksConfigPath(),
      JSON.stringify({ hooks: { toolGate: [{ command: script, onFailure }] } }),
      'utf-8',
    )
    return script
  }

  it('onFailure:closed → a blocked hook DENIES (never the forged allow)', async () => {
    await writeBlockedHook('closed')
    const decision = await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'ls' } },
      { workspaceRoot: null, projectTrusted: false },
    )
    assert.equal(decision.permission, 'deny')
  })

  it('onFailure:open → proceeds, but the block is surfaced in Sources (not silent)', async () => {
    await writeBlockedHook('open')
    const decision = await runToolGateHooks(
      { toolName: 'run_shell', args: { command: 'ls' } },
      { workspaceRoot: null, projectTrusted: false },
    )
    // Fail-open: the action proceeds (no deny) — but recorded, never hidden.
    assert.equal(decision.permission, 'allow')
    const { hooks } = await listCopseHooksForSources({ workspaceRoot: null, projectTrusted: false })
    const hook = hooks.find((h) => h.event === 'toolGate')
    assert.ok(hook)
    assert.match(hook.lastError ?? '', /sandbox/)
  })
})
