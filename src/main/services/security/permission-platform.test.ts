/**
 * Pins the per-platform shell-permission matrix documented in AGENTS.md
 * ("Shell / tool permissions across platforms"). These tests encode the
 * INTENDED behavior for each platform so it can't silently drift:
 *
 * - macOS + ASRT sandbox active  → sandbox-contained commands auto-run,
 *   network and outside-filesystem commands prompt before running outside the sandbox.
 * - Any platform, sandbox unavailable (Linux/Windows, or macOS init failure)
 *   → every shell command prompts. The optional LM Studio classifier can only
 *   support a strict-mode denial; it can never authorize host execution.
 * - Auto-run disabled in Settings → always prompt, on every platform.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideShellPermission,
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

for (const platform of ['Linux', 'Windows'] as const) {
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

    it('prompts when the classifier is below the confidence threshold', () => {
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
