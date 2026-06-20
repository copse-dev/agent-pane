import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideShellPermission, SANDBOX_TOOLS } from './permission-policy.ts'
import { setPermissionGateForTests } from './tool-registry.ts'
import { ensureToolPermitted } from './permission-gate.ts'

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

  it('auto-runs external commands inside OS sandbox (unsandboxed retry is separate)', () => {
    const d = decideShellPermission('curl https://example.com', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'allow')
  })

  it('auto-runs home-directory probes inside OS sandbox', () => {
    const d = decideShellPermission('ls ~/.nvm/nvm.sh', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'allow')
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
