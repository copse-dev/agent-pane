import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideShellPermission,
  decideWebFetchPermission,
  decideWebSearchPermission,
  formatInstallPromptBody,
  shellRequiresOutsideSandbox,
  shellSandboxFailureShouldOfferUnsandboxedRetry,
  SANDBOX_TOOLS,
} from './permission-policy.ts'
import { DEFAULT_WEB_ALLOWED_ORIGINS } from './web-origin-policy.ts'
import { setPermissionGateForTests } from './tool-registry.ts'
import { ensureToolPermitted, ensureTerminalPermitted } from './permission-gate.ts'
import { decideMcpPermission, describeMcpAnnotations } from './permission-policy.ts'
import { setWorkspaceRootForTest } from './workspace.ts'

describe('SANDBOX_TOOLS', () => {
  it('includes read_skill so skill reads auto-run without approval', () => {
    assert.equal(SANDBOX_TOOLS.has('read_skill'), true)
  })

  it('includes read-only GitHub PR tools', () => {
    assert.equal(SANDBOX_TOOLS.has('gh_pr_list'), true)
    assert.equal(SANDBOX_TOOLS.has('gh_pr_view'), true)
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

  it('auto-allows gh_pr_list without prompting', async () => {
    setPermissionGateForTests(null)
    assert.equal(
      await ensureToolPermitted({ toolName: 'gh_pr_list', args: { state: 'open', limit: 20 } }),
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

  it('prompts for destructive commands even when OS sandbox is active (#103)', () => {
    // Seatbelt contains network + out-of-workspace FS, but not in-workspace deletes,
    // so the classifier must still run and prompt rather than blanket auto-allow.
    const d = decideShellPermission('rm -rf src', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
    assert.ok(d.reasons.some((x) => x.includes('delete')))
  })

  it('prompts for fork bombs even when OS sandbox is active (#103)', () => {
    const d = decideShellPermission(':(){ :|:& };:', {
      workspaceRoot: root,
      sandboxEnabled: true,
      autoRun: true,
      classification: null,
      confidenceThreshold: 0.85,
    })
    assert.equal(d.action, 'prompt')
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

  it('runs approved git network commands outside the OS sandbox', () => {
    assert.equal(shellRequiresOutsideSandbox('git pull origin main', root, true), true)
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

  it('does not offer unsandboxed retries for network-only sandbox failures', () => {
    assert.equal(
      shellSandboxFailureShouldOfferUnsandboxedRetry('curl https://example.com', root),
      false,
    )
  })

  it('still offers unsandboxed retries for outside-filesystem sandbox failures', () => {
    assert.equal(shellSandboxFailureShouldOfferUnsandboxedRetry('ls ~/.ssh', root), true)
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

describe('formatInstallPromptBody', () => {
  it('leads with the command and never the nested external reason list', () => {
    const body = formatInstallPromptBody('npm install', {
      outsideSandbox: false,
      safeInstall: true,
      jsManager: true,
    })
    assert.ok(body.startsWith('npm install\n'))
    assert.ok(!body.includes('may fetch + run code from network'))
    assert.ok(!body.includes('((')) // no nested parentheticals
    assert.ok(body.includes('Allow this install?'))
  })

  it('mentions Socket Firewall scanning and (for JS) disabled scripts', () => {
    const body = formatInstallPromptBody('npm install', {
      outsideSandbox: false,
      safeInstall: true,
      jsManager: true,
    })
    assert.ok(body.includes('Socket Firewall (sfw)'))
    assert.ok(body.includes('install lifecycle scripts are disabled'))
  })

  it('omits the scripts note for non-JS managers', () => {
    const body = formatInstallPromptBody('pip install requests', {
      outsideSandbox: false,
      safeInstall: true,
      jsManager: false,
    })
    assert.ok(body.includes('Socket Firewall (sfw)'))
    assert.ok(!body.includes('install lifecycle scripts'))
  })

  it('explains the macOS sandbox exit only when running outside it', () => {
    const outside = formatInstallPromptBody('npm install', {
      outsideSandbox: true,
      safeInstall: true,
      jsManager: true,
    })
    assert.ok(outside.includes('outside the macOS sandbox'))
    const inside = formatInstallPromptBody('npm install', {
      outsideSandbox: false,
      safeInstall: true,
      jsManager: true,
    })
    assert.ok(!inside.includes('macOS sandbox'))
  })

  it('warns when package scanning is disabled in Settings', () => {
    const body = formatInstallPromptBody('npm install', {
      outsideSandbox: false,
      safeInstall: false,
      jsManager: true,
    })
    assert.ok(body.includes('off in Settings'))
    assert.ok(!body.includes('Socket Firewall (sfw) scans'))
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

describe('web tool permission decisions', () => {
  it('allows default DuckDuckGo web search', () => {
    const d = decideWebSearchPermission({
      allowedOrigins: DEFAULT_WEB_ALLOWED_ORIGINS,
      allowUserApproval: true,
    })
    assert.equal(d.action, 'allow')
  })

  it('prompts for fetch_url to a new public origin', () => {
    const d = decideWebFetchPermission({
      url: 'https://example.com/docs',
      allowedOrigins: DEFAULT_WEB_ALLOWED_ORIGINS,
      allowUserApproval: true,
    })
    assert.equal(d.action, 'prompt')
    assert.equal(d.origin, 'https://example.com:443')
  })

  it('denies fetch_url to private network targets without prompting', () => {
    const d = decideWebFetchPermission({
      url: 'http://169.254.169.254/latest/meta-data',
      allowedOrigins: DEFAULT_WEB_ALLOWED_ORIGINS,
      allowUserApproval: true,
    })
    assert.equal(d.action, 'deny')
  })

  it('denies new origins when user approvals are disabled', () => {
    const d = decideWebFetchPermission({
      url: 'https://example.com',
      allowedOrigins: DEFAULT_WEB_ALLOWED_ORIGINS,
      allowUserApproval: false,
    })
    assert.equal(d.action, 'deny')
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
