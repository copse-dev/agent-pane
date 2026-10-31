import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  buildAcpAgentEnv,
  claudeAcpConfigDirOverride,
  type AcpAgentSpawnConfig,
} from './acp-client.ts'
import { setProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'

/** What {@link spawnAcpAgentProcess} actually hands the child process's env. */
function spawnedEnv(config: AcpAgentSpawnConfig): Record<string, string> {
  const base = buildAcpAgentEnv(config)
  return { ...base, ...claudeAcpConfigDirOverride(config, base) }
}

/**
 * The spawned external ACP agent runs its own model loop, so it must not inherit
 * Copse's cloud LLM/provider API keys. `buildAcpAgentEnv` scrubs those secrets
 * from the base env while letting the caller's explicit `config.env` allowlist
 * (and legitimate non-LLM tool tokens like GITHUB_TOKEN) through.
 */
describe('buildAcpAgentEnv', () => {
  const injected = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'PARALLEL_API_KEY',
    'CURSOR_API_KEY',
    'CURSOR_SESSION_TOKEN',
    'GITHUB_TOKEN',
  ]

  afterEach(() => {
    for (const key of injected) Reflect.deleteProperty(process.env, key)
  })

  it('strips LLM API keys from the spawned env but keeps non-LLM tool tokens', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret'
    process.env['OPENAI_API_KEY'] = 'sk-openai-secret'
    process.env['OPENROUTER_API_KEY'] = 'sk-or-secret'
    process.env['PARALLEL_API_KEY'] = 'parallel-secret'
    process.env['CURSOR_API_KEY'] = 'cursor-secret'
    process.env['CURSOR_SESSION_TOKEN'] = 'cursor-session'
    process.env['GITHUB_TOKEN'] = 'gh-token'

    const env = buildAcpAgentEnv({ command: 'agent', cwd: '/tmp/project' })

    assert.equal(env['ANTHROPIC_API_KEY'], undefined)
    assert.equal(env['OPENAI_API_KEY'], undefined)
    assert.equal(env['OPENROUTER_API_KEY'], undefined)
    assert.equal(env['PARALLEL_API_KEY'], undefined)
    assert.equal(env['CURSOR_API_KEY'], undefined)
    assert.equal(env['CURSOR_SESSION_TOKEN'], undefined)
    assert.equal(env['GITHUB_TOKEN'], 'gh-token')
  })

  it('overlays config.env on top of the scrubbed base', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret'

    const env = buildAcpAgentEnv({
      command: 'agent',
      cwd: '/tmp/project',
      env: { GEMINI_API_KEY: 'explicitly-allowed', AGENT_FLAG: '1' },
    })

    // A secret the agent is explicitly meant to receive is honored when passed
    // through config.env, even though it would otherwise be scrubbed.
    assert.equal(env['GEMINI_API_KEY'], 'explicitly-allowed')
    assert.equal(env['AGENT_FLAG'], '1')
    // But the ambient process.env secret is still not leaked.
    assert.equal(env['ANTHROPIC_API_KEY'], undefined)
  })
})

/**
 * A Copse coding thread's `claude-agent-acp` backend must not inherit the
 * user's real `~/.claude` — personal synced skills, plugins, and MCP servers
 * have no business loading into a project thread. `claudeAcpConfigDirOverride`
 * (which {@link spawnAcpAgentProcess} overlays onto {@link buildAcpAgentEnv})
 * defaults `CLAUDE_CONFIG_DIR` to a directory scoped to the spawn's workspace
 * root instead, unless an explicit override or a sandboxed spawn says
 * otherwise. It is kept out of `buildAcpAgentEnv` itself so the Settings
 * auth-status check — which also calls `buildAcpAgentEnv`, but to run the real
 * `claude` CLI against the user's actual login — is unaffected.
 */
describe('claudeAcpConfigDirOverride (as spawnAcpAgentProcess applies it)', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'copse-user-data-'))
    process.env['COPSE_PANEL_USER_DATA'] = userDataDir
  })

  afterEach(() => {
    Reflect.deleteProperty(process.env, 'COPSE_PANEL_USER_DATA')
    rmSync(userDataDir, { recursive: true, force: true })
    setProjectSandboxEnabled(false)
  })

  it('defaults CLAUDE_CONFIG_DIR to a directory under the Copse user-data dir and creates it', () => {
    const env = spawnedEnv({ command: 'claude-agent-acp', cwd: '/tmp/project-a' })
    const configDir = env['CLAUDE_CONFIG_DIR']
    assert.ok(configDir)
    assert.ok(configDir.startsWith(join(userDataDir, 'acp-claude-config')))
    assert.ok(existsSync(configDir))
  })

  it('is stable for a repeated cwd and distinct for a different one', () => {
    const envA1 = spawnedEnv({ command: 'claude-agent-acp', cwd: '/tmp/project-a' })
    const envA2 = spawnedEnv({ command: 'claude-agent-acp', cwd: '/tmp/project-a' })
    const envB = spawnedEnv({ command: 'claude-agent-acp', cwd: '/tmp/project-b' })
    assert.equal(envA1['CLAUDE_CONFIG_DIR'], envA2['CLAUDE_CONFIG_DIR'])
    assert.notEqual(envA1['CLAUDE_CONFIG_DIR'], envB['CLAUDE_CONFIG_DIR'])
  })

  it('honors an explicit config.env CLAUDE_CONFIG_DIR override', () => {
    const env = spawnedEnv({
      command: 'claude-agent-acp',
      cwd: '/tmp/project-a',
      env: { CLAUDE_CONFIG_DIR: '/explicit/dir' },
    })
    assert.equal(env['CLAUDE_CONFIG_DIR'], '/explicit/dir')
  })

  it('leaves a non-Claude ACP agent unscoped', () => {
    const env = spawnedEnv({ command: 'gemini', args: ['--acp'], cwd: '/tmp/project-a' })
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined)
  })

  it('keeps the previous (unscoped) behavior for a sandboxed spawn', () => {
    mock.method(SandboxManager, 'isSandboxingEnabled', () => true)
    setProjectSandboxEnabled(true)
    try {
      const env = spawnedEnv({
        command: 'claude-agent-acp',
        cwd: '/tmp/project-a',
        sandbox: { allowedDomains: ['claude.ai'], homeDirs: ['.claude'] },
      })
      assert.equal(env['CLAUDE_CONFIG_DIR'], undefined)
    } finally {
      mock.restoreAll()
    }
  })

  it('does not scope the Settings auth-status check, which must read the real ~/.claude', () => {
    // `acp-auth-status.ts` calls `buildAcpAgentEnv` directly, never through
    // `spawnAcpAgentProcess` — so it never gets the override at all.
    const env = buildAcpAgentEnv({ command: 'claude-agent-acp', cwd: process.cwd() })
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined)
  })
})
