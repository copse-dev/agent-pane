import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { StreamChunk } from '@shared/types'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import type { AcpAgentSpawnConfig } from './acp-client.ts'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { setApprovalHandler, type ApprovalRequest } from '../approval.ts'
import { setSetting } from '../storage/settings.ts'
import { setWorkspaceRootForTest } from '../workspace.ts'
import { runWithThreadExecutionContext } from '../thread-execution-context.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { acpAgentConfigDir, resolveAcpAgentTurnEnv } from './acp-agent-config-dir.ts'
import { runAcpAgentFromSettings } from './acp-agent-service.ts'
import {
  gateRemoteAcpEnvForward,
  resetRemoteAcpEnvDecisionsForTests,
} from './acp-remote-env-gate.ts'
import { disposeAllAcpSessions } from './acp-session-pool.ts'

/**
 * The env a Claude ACP agent is spawned with, pinned where it matters: in the
 * agent process itself, after the real turn path (`runAcpAgentFromSettings`,
 * the session pool, `spawnAcpAgentProcess`) has composed and delivered it.
 *
 * The agent is `tests/fixtures/mock-acp-agent.mjs` behind a fake **npm global
 * install** — `bin/claude-agent-acp` linking into
 * `lib/node_modules/@agentclientprotocol/claude-agent-acp`, which nests the
 * `@anthropic-ai/claude-agent-sdk` whose `claudeCodeVersion` names the CLI
 * the adapter would really run. That layout is what the turn reads to decide
 * whether the CLI can keep the user's login inside a scoped config dir.
 *
 * HOME is a throwaway directory for the whole file (each test file runs in its
 * own process), holding a fake `~/.claude/.credentials.json`: nothing here can
 * read, link or rewrite a developer's real Claude login.
 */

const MOCK_AGENT = resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')
const PROBED_VARS = ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] as const
const PROJECT_ID = 'turn-env-project'

const receivedEnvSchema = z.record(z.string(), z.string().nullable())

let root = ''
let home = ''
const saved: Record<string, string | undefined> = {}
const OVERRIDDEN_ENV = [
  'HOME',
  'USERPROFILE',
  'COPSE_WORKSPACE_DIR',
  'CLAUDE_CODE_EXECUTABLE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
] as const

before(() => {
  root = mkdtempSync(join(tmpdir(), 'copse-acp-turn-env-'))
  home = join(root, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"fake":true}', { mode: 0o600 })
  for (const name of OVERRIDDEN_ENV) saved[name] = process.env[name]
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['COPSE_WORKSPACE_DIR'] = join(root, 'workspace')
  delete process.env['CLAUDE_CODE_EXECUTABLE']
  delete process.env['CLAUDE_CONFIG_DIR']
  delete process.env['CLAUDE_SECURESTORAGE_CONFIG_DIR']
})

after(() => {
  for (const name of OVERRIDDEN_ENV) {
    const value = saved[name]
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

/**
 * An npm-global-shaped Claude adapter install under `prefix` whose bundled
 * Agent SDK declares `claudeCodeVersion` — nested under the adapter (npm's
 * global layout) or hoisted beside it (a pnpm store, a deduped install).
 * Returns the `bin/` entry, which runs the mock agent.
 */
function installClaudeAdapter(
  prefix: string,
  claudeCodeVersion: string,
  sdkLayout: 'nested' | 'hoisted' = 'nested',
): string {
  const adapterDir = join(prefix, 'lib', 'node_modules', '@agentclientprotocol', 'claude-agent-acp')
  const entry = join(adapterDir, 'dist', 'index.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(
    join(adapterDir, 'package.json'),
    JSON.stringify({
      name: '@agentclientprotocol/claude-agent-acp',
      version: '0.99.1',
      bin: { 'claude-agent-acp': 'dist/index.js' },
    }),
  )
  // A shell shim rather than a node shebang, so the child runs on this
  // process's own node whatever PATH says.
  writeFileSync(
    entry,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_AGENT)} "$@"\n`,
  )
  chmodSync(entry, 0o755)
  const sdkDir = join(
    sdkLayout === 'nested' ? adapterDir : join(prefix, 'lib'),
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
  )
  mkdirSync(sdkDir, { recursive: true })
  writeFileSync(
    join(sdkDir, 'package.json'),
    JSON.stringify({
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.3.312',
      claudeCodeVersion,
    }),
  )
  const bin = join(prefix, 'bin', 'claude-agent-acp')
  mkdirSync(dirname(bin), { recursive: true })
  symlinkSync(relative(dirname(bin), entry), bin)
  return bin
}

function claudeAgent(command: string, env?: Record<string, string>): AcpAgentConfig {
  return { id: 'my-claude', title: 'My Claude', command, enabled: true, ...(env ? { env } : {}) }
}

/** The probed vars as the agent process received them (`null` = absent). */
async function envReceivedByAgent(
  agent: AcpAgentConfig,
  threadId: string,
): Promise<Record<string, string | null>> {
  const project = join(root, `project-${threadId}`)
  mkdirSync(project, { recursive: true })
  execFileSync('git', ['init', '--quiet', project])
  setWorkspaceRootForTest(project)
  await setSetting('registeredAcpAgents', [agent])
  const chunks: StreamChunk[] = []
  await runWithThreadExecutionContext(
    {
      projectId: PROJECT_ID,
      threadId,
      projectRoot: project,
      root: project,
      checkoutMode: 'shared',
      branch: 'main',
    },
    () =>
      runAcpAgentFromSettings({
        threadId,
        agentId: agent.id,
        userPrompt: `report-env:${PROBED_VARS.join(',')}`,
        priorMessages: [],
        signal: AbortSignal.timeout(20_000),
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
        registry: new ToolRegistry(),
      }),
  )
  const text = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : [])).join('')
  const reported = /env:(\{.*\})/.exec(text)?.[1]
  assert.ok(reported, `the agent did not report its env; it streamed: ${text}`)
  const received = safeJsonParse(reported, decodeWithSchema(receivedEnvSchema))
  assert.ok(received, `unparseable env report: ${reported}`)
  return received
}

describe(
  'the env a local Claude ACP turn spawns its agent with',
  { skip: process.platform === 'win32' },
  () => {
    afterEach(async () => {
      await disposeAllAcpSessions()
      setWorkspaceRootForTest(null)
      await setSetting('registeredAcpAgents', [])
    })

    it('scopes the config dir and points secure storage back at the default login', async () => {
      const bin = installClaudeAdapter(join(root, 'npm-current'), '2.1.312')
      const received = await envReceivedByAgent(claudeAgent(bin), 'thread-current')
      const scoped = acpAgentConfigDir(PROJECT_ID, 'thread-current', 'my-claude')
      assert.deepEqual(received, {
        CLAUDE_CONFIG_DIR: scoped,
        // Empty, not absent: the CLI reads `''` as "the default Keychain item and
        // ~/.claude/.credentials.json", the login Settings reports as signed in.
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      })
      // The login stays where it is — nothing links or copies it into the
      // thread, so a token refresh can never fork it.
      assert.equal(existsSync(join(scoped, '.credentials.json')), false)
    })

    it('leaves the agent unscoped when its CLI predates the secure-storage override', async () => {
      // 2.1.143 already hashes the Keychain item name off CLAUDE_CONFIG_DIR but
      // ignores CLAUDE_SECURESTORAGE_CONFIG_DIR: scoping it would sign it out.
      const bin = installClaudeAdapter(join(root, 'npm-old'), '2.1.143')
      const received = await envReceivedByAgent(claudeAgent(bin), 'thread-old')
      assert.deepEqual(received, { CLAUDE_CONFIG_DIR: null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null })
      assert.equal(existsSync(acpAgentConfigDir(PROJECT_ID, 'thread-old', 'my-claude')), false)
    })
  },
)

describe('resolveAcpAgentTurnEnv', { skip: process.platform === 'win32' }, () => {
  const sshTarget = { hostId: 'dev', remoteRoot: '/remote/project' }
  let bin = ''

  before(() => {
    bin = installClaudeAdapter(join(root, 'npm-unit'), '2.1.312')
  })

  afterEach(() => {
    setApprovalHandler(null)
    resetRemoteAcpEnvDecisionsForTests()
  })

  it('never hands an SSH-hosted agent a local config path', async () => {
    const env = await resolveAcpAgentTurnEnv({
      agent: claudeAgent(bin),
      projectId: PROJECT_ID,
      threadId: 'thread-ssh',
      sshTarget,
    })
    assert.equal(env, undefined)
    assert.equal(existsSync(acpAgentConfigDir(PROJECT_ID, 'thread-ssh', 'my-claude')), false)
  })

  it('asks to forward only the env the user configured to an SSH host', async () => {
    const prompts: ApprovalRequest[] = []
    setApprovalHandler((request) => {
      prompts.push(request)
      return Promise.resolve({ approved: true, remember: false })
    })
    const remoteTurn = async (
      agent: AcpAgentConfig,
    ): Promise<Record<string, string> | undefined> => {
      // Composed as `runAcpAgentTurn` composes it: `env` only when there is one.
      const env = await resolveAcpAgentTurnEnv({
        agent,
        projectId: PROJECT_ID,
        threadId: 'thread-ssh-gate',
        sshTarget,
      })
      const config: AcpAgentSpawnConfig = {
        command: agent.command,
        cwd: sshTarget.remoteRoot,
        sshTarget,
        ...(env ? { env } : {}),
      }
      return (await gateRemoteAcpEnvForward(agent.id, config)).env
    }

    // Nothing configured: nothing to forward, so no consent prompt at all.
    assert.equal(await remoteTurn(claudeAgent(bin)), undefined)
    assert.equal(prompts.length, 0)

    // A configured key is the whole of what crosses, and of what is asked.
    assert.deepEqual(await remoteTurn(claudeAgent(bin, { ANTHROPIC_API_KEY: 'sk-test' })), {
      ANTHROPIC_API_KEY: 'sk-test',
    })
    assert.equal(prompts.length, 1)
    assert.match(prompts[0]?.body ?? '', /: ANTHROPIC_API_KEY\. /)
  })

  it('passes an explicit CLAUDE_CONFIG_DIR through untouched', async () => {
    const env = await resolveAcpAgentTurnEnv({
      agent: claudeAgent(bin, { CLAUDE_CONFIG_DIR: '/shared/claude' }),
      projectId: PROJECT_ID,
      threadId: 'thread-explicit',
      sshTarget: null,
    })
    // No secure-storage override: a dir the user chose keeps the CLI's own
    // semantics, login included.
    assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/shared/claude' })
  })

  it('leaves the agent unscoped when CLAUDE_CODE_EXECUTABLE swaps in a CLI it cannot see', async () => {
    const env = await resolveAcpAgentTurnEnv({
      agent: claudeAgent(bin, { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' }),
      projectId: PROJECT_ID,
      threadId: 'thread-executable',
      sshTarget: null,
    })
    assert.deepEqual(env, { CLAUDE_CODE_EXECUTABLE: '/usr/local/bin/claude' })
  })

  it("vets the adapter the agent's own PATH spawns, not the one on Copse's", async () => {
    const current = dirname(installClaudeAdapter(join(root, 'npm-path-current'), '2.1.312'))
    const old = dirname(installClaudeAdapter(join(root, 'npm-path-old'), '2.1.143'))
    const inherited = process.env['PATH'] ?? ''
    const onPath = (dir: string): string => `${dir}${delimiter}${inherited}`
    // A bare command resolves through the spawn env's PATH, where Settings wins.
    const resolveWith = (agentPath: string): Promise<Record<string, string> | undefined> =>
      resolveAcpAgentTurnEnv({
        agent: claudeAgent('claude-agent-acp', { PATH: onPath(agentPath) }),
        projectId: PROJECT_ID,
        threadId: 'thread-path',
        sshTarget: null,
      })
    try {
      // Copse finds a current adapter, but the agent would spawn the old one.
      process.env['PATH'] = onPath(current)
      assert.deepEqual(await resolveWith(old), { PATH: onPath(old) })
      // And the reverse: the agent's PATH reaches a current adapter.
      process.env['PATH'] = onPath(old)
      assert.equal((await resolveWith(current))?.['CLAUDE_SECURESTORAGE_CONFIG_DIR'], '')
    } finally {
      process.env['PATH'] = inherited
    }
  })

  it('reads the CLI version from an SDK hoisted beside the adapter', async () => {
    const hoisted = installClaudeAdapter(join(root, 'npm-hoisted'), '2.1.144', 'hoisted')
    const env = await resolveAcpAgentTurnEnv({
      agent: claudeAgent(hoisted),
      projectId: PROJECT_ID,
      threadId: 'thread-hoisted',
      sshTarget: null,
    })
    assert.deepEqual(env, {
      CLAUDE_CONFIG_DIR: acpAgentConfigDir(PROJECT_ID, 'thread-hoisted', 'my-claude'),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    })
  })

  it('leaves the agent unscoped when no adapter install can be found for its command', async () => {
    const env = await resolveAcpAgentTurnEnv({
      agent: claudeAgent(join(root, 'nowhere', 'claude-agent-acp')),
      projectId: PROJECT_ID,
      threadId: 'thread-missing',
      sshTarget: null,
    })
    assert.equal(env, undefined)
  })

  it('does not scope an agent that does not wrap Claude', async () => {
    const env = await resolveAcpAgentTurnEnv({
      agent: { id: 'gemini', title: 'Gemini', command: 'gemini', enabled: true },
      projectId: PROJECT_ID,
      threadId: 'thread-gemini',
      sshTarget: null,
    })
    assert.equal(env, undefined)
  })
})
