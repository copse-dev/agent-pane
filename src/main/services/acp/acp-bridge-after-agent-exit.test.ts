import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type McpServer,
} from '@agentclientprotocol/sdk/unstable'
import { z } from 'zod'
import { ToolRegistry } from '../tool-registry.ts'
import {
  runAcpSessionPrompt,
  type AcpAgentSpawnConfig,
  type AcpClientHandlers,
  type AcpTransport,
} from './acp-client.ts'
import { acpErrorMessage, isAcpConnectionDropped } from './acp-agent-service.ts'
import {
  acpAgentConfigDir,
  CLAUDE_MCP_FAILURE_CACHE_FILE,
  forgetClaudeMcpServerFailure,
} from './acp-agent-config-dir.ts'
import { acquireAcpSession, disposeAcpSession, disposeAllAcpSessions } from './acp-session-pool.ts'

/**
 * #4142: a Claude Code chat lost its `mcp__copse__*` tools after a turn failed
 * with `-32603 Unable to verify organization` and the agent process exited
 * with code 1. Copse offered the next process a new, live bridge; Claude Code
 * never connected to it.
 *
 * The fake agent behaves like Claude Code 2.1.278+ where it matters: the
 * failure of an MCP server to connect is written, by server **name**, to
 * `mcp-needs-auth-cache.json` in `CLAUDE_CONFIG_DIR`, and a CLI started within
 * 15 minutes skips that server whatever URL it is given. Copse keeps one
 * config dir per thread across agent processes, so the note outlives the
 * process that wrote it.
 */
const FAILURE_TTL_MS = 15 * 60 * 1000
const ORG_ERROR = 'Unable to verify organization for the current authentication token'

interface FakeClaude {
  createTransport: (config: AcpAgentSpawnConfig) => Promise<AcpTransport>
  /** The Copse tools each session could see, in session order. */
  visibleTools: string[][]
  /** Make the next prompt fail like the reported turn, then exit. */
  failNextPrompt: boolean
}

function failureCachePath(config: AcpAgentSpawnConfig): string {
  const dir = config.env?.['CLAUDE_CONFIG_DIR']
  assert.ok(dir, 'the fake needs a config dir')
  return join(dir, CLAUDE_MCP_FAILURE_CACHE_FILE)
}

function readFailureCache(config: AcpAgentSpawnConfig): Record<string, { timestamp: number }> {
  try {
    return z
      .record(z.string(), z.object({ timestamp: z.number() }))
      .parse(JSON.parse(readFileSync(failureCachePath(config), 'utf8')))
  } catch {
    return {}
  }
}

/** List the tools of a bridge, as the agent's MCP client would. */
async function listTools(server: McpServer): Promise<string[]> {
  if (!('url' in server)) return []
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  const text = await response.text()
  const json = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}')
  const parsed = z
    .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
    .safeParse(JSON.parse(json))
  return parsed.success ? parsed.data.result.tools.map((tool) => tool.name) : []
}

function fakeClaude(): FakeClaude {
  let nextId = 0
  const fake: FakeClaude = {
    visibleTools: [],
    failNextPrompt: false,
    createTransport: (config) => {
      const c2a = new TransformStream<Uint8Array, Uint8Array>()
      const a2c = new TransformStream<Uint8Array, Uint8Array>()
      // What a CLI start does with the servers it is handed.
      const connectServers = async (servers: McpServer[]): Promise<void> => {
        const cached = readFailureCache(config)
        const tools: string[] = []
        for (const server of servers) {
          const failedAt = cached[server.name]?.timestamp
          if (failedAt !== undefined && Date.now() - failedAt < FAILURE_TTL_MS) continue
          tools.push(...(await listTools(server)))
        }
        fake.visibleTools.push(tools)
      }
      const connection = agent({ name: 'fake-claude-agent' })
        .onRequest('initialize', () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true },
            sessionCapabilities: { resume: {} },
          },
        }))
        .onRequest('session/new', async (ctx) => {
          await connectServers(ctx.params.mcpServers)
          return { sessionId: `s${String(++nextId)}` }
        })
        .onRequest('session/resume', async (ctx) => {
          await connectServers(ctx.params.mcpServers ?? [])
          return {}
        })
        .onRequest('session/prompt', async (ctx) => {
          await ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'working' },
            },
          })
          if (!fake.failNextPrompt) return { stopReason: 'end_turn' }
          fake.failNextPrompt = false
          // The CLI dies mid-turn; its connection to the bridge drops on the
          // way, and the failure is noted against the server's name.
          writeFileSync(
            failureCachePath(config),
            JSON.stringify({
              ...readFailureCache(config),
              copse: { timestamp: Date.now() },
              'plugin:github-connector:github': { timestamp: Date.now() },
            }),
          )
          setTimeout(() => {
            connection.close()
          }, 0)
          throw RequestError.internalError({ details: ORG_ERROR })
        })
        .connect(ndJsonStream(a2c.writable, c2a.readable))
      return Promise.resolve({
        stream: ndJsonStream(c2a.writable, a2c.readable),
        dispose: () => {
          connection.close()
        },
      })
    },
  }
  return fake
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.register({
    name: 'read_file',
    description: 'Read a workspace file',
    parameters: z.object({}),
    execute: () => Promise.resolve('contents'),
  })
  return tools
}

const PROJECT = 'proj'
const THREAD = 'thread-4142'

/** One Copse turn, disposing the session on failure as `runAcpAgent` does. */
async function turn(fake: FakeClaude, config: AcpAgentSpawnConfig): Promise<unknown> {
  const { entry } = await acquireAcpSession({
    projectId: PROJECT,
    threadId: THREAD,
    config,
    registry: registry(),
    createTransport: fake.createTransport,
  })
  const handlers: AcpClientHandlers = {
    onChunk: () => {},
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
  }
  entry.open.handlers.current = handlers
  try {
    await runAcpSessionPrompt(entry.open, 'go', undefined)
    return null
  } catch (err) {
    await disposeAcpSession(THREAD, { preserveForResume: isAcpConnectionDropped(err) })
    return err
  }
}

describe('the native bridge after a Claude turn dies (#4142)', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-bridge-after-exit-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(async () => {
    await disposeAllAcpSessions()
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  function threadScopedConfig(): AcpAgentSpawnConfig {
    const configDir = acpAgentConfigDir(PROJECT, THREAD, 'claude-acp')
    mkdirSync(configDir, { recursive: true })
    return { command: 'fake-claude', cwd: root, env: { CLAUDE_CONFIG_DIR: configDir } }
  }

  it("gives the next agent process the thread's Copse tools", async () => {
    const fake = fakeClaude()
    const config = threadScopedConfig()
    assert.equal(await turn(fake, config), null)
    assert.deepEqual(fake.visibleTools, [['read_file']])

    fake.failNextPrompt = true
    const failure = await turn(fake, config)
    assert.ok(failure instanceof Error)
    assert.match(acpErrorMessage(failure), /Internal error: Unable to verify organization/)

    assert.equal(await turn(fake, config), null)
    assert.deepEqual(fake.visibleTools.at(-1), ['read_file'], 'the new bridge was skipped')
    // Only Copse's own entry is dropped: other servers' failures are not ours to forget.
    assert.deepEqual(Object.keys(readFailureCache(config)), ['plugin:github-connector:github'])
  })

  it('leaves a config dir chosen in Settings alone', async () => {
    const fake = fakeClaude()
    const ownDir = join(root, 'my-claude')
    mkdirSync(ownDir, { recursive: true })
    const config: AcpAgentSpawnConfig = {
      command: 'fake-claude',
      cwd: root,
      env: { CLAUDE_CONFIG_DIR: ownDir },
    }
    writeFileSync(failureCachePath(config), JSON.stringify({ copse: { timestamp: Date.now() } }))

    assert.equal(await turn(fake, config), null)

    assert.deepEqual(Object.keys(readFailureCache(config)), ['copse'])
  })
})

describe('forgetClaudeMcpServerFailure', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copse-claude-failure-cache-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const cacheFile = (): string => join(dir, CLAUDE_MCP_FAILURE_CACHE_FILE)

  it('drops only the named server', async () => {
    writeFileSync(cacheFile(), JSON.stringify({ copse: { timestamp: 1 }, figma: { timestamp: 2 } }))
    assert.equal(await forgetClaudeMcpServerFailure(dir, 'copse'), true)
    assert.deepEqual(JSON.parse(readFileSync(cacheFile(), 'utf8')), { figma: { timestamp: 2 } })
  })

  it('does nothing without a cache, an entry, or a readable file', async () => {
    assert.equal(await forgetClaudeMcpServerFailure(dir, 'copse'), false)

    writeFileSync(cacheFile(), JSON.stringify({ figma: { timestamp: 2 } }))
    assert.equal(await forgetClaudeMcpServerFailure(dir, 'copse'), false)

    writeFileSync(cacheFile(), '{not json')
    assert.equal(await forgetClaudeMcpServerFailure(dir, 'copse'), false)
    assert.equal(readFileSync(cacheFile(), 'utf8'), '{not json')
  })
})
