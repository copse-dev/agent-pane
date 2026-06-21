import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideShellPermission, SANDBOX_TOOLS } from './permission-policy.ts'
import { setPermissionGateForTests } from './tool-registry.ts'
import { ensureToolPermitted, ensureTerminalPermitted } from './permission-gate.ts'
import { decideMcpPermission, describeMcpAnnotations } from './permission-policy.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('SANDBOX_TOOLS', () => {
  it('includes read_skill so skill reads auto-run without approval', () => {
    assert.equal(SANDBOX_TOOLS.has('read_skill'), true)
  })
})

describe('ensureToolPermitted', () => {
  it('auto-allows read_skill without prompting', async () => {
    setPermissionGateForTests(null)
    assert.equal(
      await ensureToolPermitted({ toolName: 'read_skill', args: { name: 'demo-skill' } }),
      true,
    )
  })
})

describe('ensureTerminalPermitted', () => {
  it('allows integrated terminal without shell approval when workspace is open', async () => {
    const restore = setWorkspaceRootForTest('/tmp/project')
    try {
      assert.equal(await ensureTerminalPermitted(), true)
    } finally {
      restore()
    }
  })

  it('throws when no workspace is open', async () => {
    const restore = setWorkspaceRootForTest(null)
    try {
      await assert.rejects(() => ensureTerminalPermitted(), /No workspace open/)
    } finally {
      restore()
    }
  })
})

describe('decideShellPermission', () => {
  const root = '/Users/me/project'

  it('prompts when auto-run is disabled', () => {
    const d = decideShellPermission('npm test', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: false,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
  })

  it('allows sandbox-contained commands when OS sandbox is active', () => {
    const d = decideShellPermission('npm test', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'allow')
  })

  it('prompts for external commands when OS sandbox is active', () => {
    const d = decideShellPermission('curl https://example.com', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
    assert.ok(d.reasons.some((x) => x.includes('curl')))
  })

  it('prompts for gh CLI when OS sandbox is active', () => {
    const d = decideShellPermission('gh pr view --json state', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
    assert.ok(d.reasons.some((x) => x.includes('GitHub CLI')))
  })

  it('prompts for home-directory paths when OS sandbox is active', () => {
    const d = decideShellPermission('ls ~/.nvm/nvm.sh', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
    assert.ok(d.reasons.some((x) => x.includes('home directory')))
  })

  it('uses safety model on unsandboxed platforms when confident', () => {
    const d = decideShellPermission('npm test', {
      workspaceRoot: root,
      sandboxEnabled: false,
      autoRun: true,
      classification: { scope: 'sandbox', confidence: 0.95, reason: 'local test runner' },
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'allow')
  })

  it('prompts on unsandboxed platforms when safety model is uncertain', () => {
    const d = decideShellPermission('npm test', {
      workspaceRoot: root,
      sandboxEnabled: false,
      autoRun: true,
      classification: { scope: 'sandbox', confidence: 0.5, reason: 'uncertain' },
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
  })

  it('prompts on unsandboxed platforms when safety model is unavailable', () => {
    const d = decideShellPermission('npm test', {
      workspaceRoot: root,
      sandboxEnabled: false,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
  })
})

describe('decideMcpPermission', () => {
  const baseInput = { remembered: false, autoAllowReadOnly: false }

  it('prompts for an unannotated external tool by default', () => {
    assert.equal(decideMcpPermission(baseInput).action, 'prompt')
  })

  it('allows when the user remembered the tool', () => {
    assert.equal(decideMcpPermission({ ...baseInput, remembered: true }).action, 'allow')
  })

  it('auto-allows read-only tools only when the setting is on', () => {
    const ann = { readOnlyHint: true }
    assert.equal(decideMcpPermission({ ...baseInput, annotations: ann }).action, 'prompt')
    assert.equal(
      decideMcpPermission({ ...baseInput, annotations: ann, autoAllowReadOnly: true }).action,
      'allow',
    )
  })

  it('always prompts for destructive tools even when read-only auto-allow is on', () => {
    const d = decideMcpPermission({
      ...baseInput,
      annotations: { readOnlyHint: true, destructiveHint: true },
      autoAllowReadOnly: true,
    })
    assert.equal(d.action, 'prompt')
  })
})

describe('describeMcpAnnotations', () => {
  it('lists relevant hints', () => {
    assert.deepEqual(describeMcpAnnotations({ readOnlyHint: true, openWorldHint: true }), [
      'Read-only',
      'May access external systems',
    ])
  })
  it('returns empty when no annotations', () => {
    assert.deepEqual(describeMcpAnnotations(undefined), [])
  })
})
