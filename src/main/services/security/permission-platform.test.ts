/**
 * Pins the per-platform shell-permission matrix documented in AGENTS.md
 * ("Shell / tool permissions across platforms"). These tests encode the
 * INTENDED behavior for each platform so it can't silently drift:
 *
 * - macOS + ASRT sandbox active, or Linux + bubblewrap sandbox active
 *   → sandbox-contained commands auto-run; network and outside-filesystem
 *   commands prompt before running outside the sandbox. The deterministic
 *   auto-approval classifier may skip that prompt for recognised shapes.
 * - Sandbox unavailable (Windows, or macOS/Linux init failure)
 *   → every shell command prompts. The optional LM Studio classifier can only
 *   support a strict-mode denial; it can never authorize host execution. The
 *   deterministic auto-approval classifier is also refused: recognised shapes
 *   still prompt when there is no containment.
 * - Auto-run disabled in Settings → always prompt, on every platform.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideShellPermission,
  decideTerminalPermission,
  shellExpectedBlockEscalation,
  shellRequiresOutsideSandbox,
} from './permission-policy.ts'

const root = '/Users/me/project'
const SANDBOXED = 'npm test' // stays within the workspace, no network
const EXTERNAL = 'curl https://example.com' // network access
const OUTSIDE_FS = 'ls ~/.ssh'
const AMBIGUOUS = 'gh pr create' // writes to GitHub, but auto-runs inside seatbelt (read-only gh is sandbox-safe, #500)

describe('shell permissions: macOS with ASRT sandbox active', () => {
  const opts = {
    workspaceRoot: root,
    sandboxEnabled: true,
    autoRun: true,
  }

  it('auto-runs sandbox-contained commands without consulting a classifier', () => {
    const d = decideShellPermission(SANDBOXED, { ...opts, classification: null })
    assert.equal(d.action, 'allow')
  })

  it('auto-opens a local user terminal on macOS', () => {
    assert.deepEqual(
      decideTerminalPermission({
        sandboxEnabled: true,
        remoteTarget: false,
      }),
      { action: 'allow' },
    )
    assert.deepEqual(
      decideTerminalPermission({
        sandboxEnabled: true,
        remoteTarget: true,
      }),
      { action: 'prompt', reason: 'remote-target' },
    )
  })

  it('runs network commands outside the sandbox after approval', () => {
    const d = decideShellPermission(EXTERNAL, { ...opts, classification: null })
    assert.equal(d.action, 'prompt')
    assert.equal(shellRequiresOutsideSandbox(EXTERNAL, root, true), true)
    assert.equal(shellRequiresOutsideSandbox(SANDBOXED, root, true), false)
  })

  it('runs outside the sandbox only for outside-filesystem access after approval', () => {
    const d = decideShellPermission(OUTSIDE_FS, { ...opts, classification: null })
    assert.equal(d.action, 'prompt')
    assert.equal(shellRequiresOutsideSandbox(OUTSIDE_FS, root, true), true)
  })

  it('ignores the safety classifier when the OS sandbox is the boundary', () => {
    // Even a low-confidence "external" classification cannot override the
    // seatbelt verdict for a sandbox-contained command.
    const d = decideShellPermission(SANDBOXED, {
      ...opts,
      classification: { scope: 'external', confidence: 0.99, reason: 'noise' },
    })
    assert.equal(d.action, 'allow')
  })
})

describe('shell permissions: Linux with bubblewrap sandbox active', () => {
  const opts = {
    workspaceRoot: root,
    sandboxEnabled: true,
    autoRun: true,
  }

  it('uses the same contained/external matrix as macOS once the sandbox is up', () => {
    assert.equal(
      decideShellPermission(SANDBOXED, { ...opts, classification: null }).action,
      'allow',
    )
    assert.equal(
      decideShellPermission(EXTERNAL, { ...opts, classification: null }).action,
      'prompt',
    )
  })
})

for (const platform of ['Windows', 'sandbox init failure'] as const) {
  describe(`shell permissions: ${platform} (no OS sandbox)`, () => {
    const opts = {
      workspaceRoot: root,
      sandboxEnabled: false,
      autoRun: true,
    }

    it('prompts for static-analysis "external" verdicts regardless of classifier', () => {
      const d = decideShellPermission(EXTERNAL, {
        ...opts,
        classification: { scope: 'sandbox', confidence: 0.99, reason: 'looks fine' },
      })
      // Static "external" wins before the classifier is consulted.
      assert.equal(d.action, 'prompt')
    })

    it('prompts even when the classifier is confident the command is sandbox-scoped', () => {
      const d = decideShellPermission(SANDBOXED, {
        ...opts,
        classification: { scope: 'sandbox', confidence: 0.9, reason: 'local test runner' },
      })
      assert.equal(d.action, 'prompt')
    })

    it('prompts for a low-confidence sandbox classifier verdict (never auto-runs without an OS sandbox)', () => {
      const d = decideShellPermission(SANDBOXED, {
        ...opts,
        classification: { scope: 'sandbox', confidence: 0.5, reason: 'unsure' },
      })
      assert.equal(d.action, 'prompt')
    })

    it('prompts when the classifier is unavailable (no LM Studio safety model)', () => {
      const d = decideShellPermission(SANDBOXED, { ...opts, classification: null })
      assert.equal(d.action, 'prompt')
      assert.ok(d.reasons.some((r) => /sandbox unavailable/i.test(r)))
    })

    it('never claims a command needs to run "outside the sandbox" when there is no sandbox', () => {
      assert.equal(shellRequiresOutsideSandbox(EXTERNAL, root, false), false)
    })

    it('prompts for a terminal because the OS sandbox is unavailable', () => {
      assert.deepEqual(
        decideTerminalPermission({
          sandboxEnabled: false,
          remoteTarget: false,
        }),
        { action: 'prompt', reason: 'sandbox-unavailable' },
      )
    })
  })
}

describe('shell permissions: agent-declared "expects_sandbox_block" up-front escalation', () => {
  it('is eligible for an ambiguous command when the sandbox is active', () => {
    // gh/cloud CLIs/nc would auto-run inside seatbelt and escalate on a real block;
    // the up-front hint may pull that same prompt forward.
    const e = shellExpectedBlockEscalation(AMBIGUOUS, root, true)
    assert.equal(e.eligible, true)
    assert.ok(e.reasons.some((r) => /GitHub CLI/i.test(r)))
  })

  it('allows a known host-dependent build driver to request the same up-front approval (#786)', () => {
    const e = shellExpectedBlockEscalation(
      'xcodebuild -workspace App.xcworkspace build',
      root,
      true,
    )
    assert.equal(e.eligible, true)
    assert.ok(e.reasons.some((r) => /build driver may require host caches/i.test(r)))
  })

  it('is NOT eligible for a hard-external command (it already prompts + runs outside)', () => {
    assert.equal(shellExpectedBlockEscalation(EXTERNAL, root, true).eligible, false)
    assert.equal(shellExpectedBlockEscalation(OUTSIDE_FS, root, true).eligible, false)
  })

  it('is NOT eligible for a fully-contained command (no self-declared escape)', () => {
    // A 'sandbox' verdict has no external signal at all; honoring the hint here
    // would let the model route a contained command outside without a real block.
    assert.equal(shellExpectedBlockEscalation(SANDBOXED, root, true).eligible, false)
  })

  it('is NOT eligible when there is no OS sandbox to escalate out of', () => {
    assert.equal(shellExpectedBlockEscalation(AMBIGUOUS, root, false).eligible, false)
  })
})

describe('shell permissions: auto-run disabled in Settings', () => {
  it('always prompts, even for sandbox-contained commands on macOS', () => {
    const d = decideShellPermission(SANDBOXED, {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: false,
      classification: { scope: 'sandbox', confidence: 1, reason: 'safe' },
    })
    assert.equal(d.action, 'prompt')
    assert.ok(d.reasons.some((r) => /auto-run.*disabled/i.test(r)))
  })
})

describe('shell permissions: explicit Guarded YOLO mode', () => {
  for (const sandboxEnabled of [true, false]) {
    const platform = sandboxEnabled ? 'macOS sandbox active' : 'no OS sandbox'

    it(`auto-runs routine local and external work on ${platform}`, () => {
      for (const command of [SANDBOXED, EXTERNAL, AMBIGUOUS]) {
        const d = decideShellPermission(command, {
          workspaceRoot: root,
          sandboxEnabled,
          autoRun: false,
          classification: null,
          mode: 'guarded-yolo',
          harmDecision: { action: 'allow', reasons: ['no harmful signals'] },
        })
        assert.equal(d.action, 'allow', command)
      }
    })

    it(`preserves deterministic prompt and deny outcomes on ${platform}`, () => {
      const prompt = decideShellPermission('rm -rf build', {
        workspaceRoot: root,
        sandboxEnabled,
        autoRun: true,
        classification: null,
        mode: 'guarded-yolo',
        harmDecision: { action: 'prompt', reasons: ['bounded delete'] },
      })
      const deny = decideShellPermission('rm -rf /', {
        workspaceRoot: root,
        sandboxEnabled,
        autoRun: true,
        classification: null,
        mode: 'guarded-yolo',
        harmDecision: { action: 'deny', reasons: ['filesystem root'] },
      })
      assert.equal(prompt.action, 'prompt')
      assert.equal(deny.action, 'deny')
    })
  }

  it('fails closed when the host harm verdict is absent', () => {
    const d = decideShellPermission(SANDBOXED, {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      mode: 'guarded-yolo',
    })
    assert.equal(d.action, 'deny')
    assert.match(d.reasons.join(' '), /harm assessment unavailable/i)
  })
})
