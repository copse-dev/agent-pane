import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { setElectronAppRuntime } from '../electron-app-runtime.ts'
import { ToolRegistry, setPermissionGateForTests } from '../tool-registry.ts'
import { runWithWorkspaceRoot } from '../workspace.ts'
import { startAcpNativeBridge } from '../acp/acp-native-bridge.ts'
import type { ThreadExecutionContext } from '../thread-execution-context.ts'
import { setSetting } from '../storage/settings.ts'
import {
  clearMcpToolPermissionTargets,
  createMcpPermissionScope,
  mcpToolPermissionId,
  registerMcpToolPermissionTarget,
  resolveToolPermission,
  type McpPermissionTarget,
} from '../security/tool-permissions.ts'
import {
  acquireMcpToolScope,
  captureMcpToolScope,
  getMcpToolMeta,
  loadMcpServers,
  reloadMcpServers,
  reloadMcpServersForWorkspace,
  setMcpServerUserEnabled,
  shutdownMcpServers,
  type McpToolScope,
} from './mcp-registry.ts'
import { asProtocolTransport } from './streamable-http-transport.ts'

const TOOL = 'mcp__owned__report_workspace'
const eventSchema = z.object({
  type: z.string(),
  pid: z.number(),
  workspace: z.string(),
  call: z.number().optional(),
})

describe('MCP workspace connection ownership', () => {
  let directory: string
  let a: string
  let b: string
  let trace: string
  let registry: ToolRegistry
  let originalClient: object
  let closeOriginal: () => Promise<void>
  let priorE2e: string | undefined
  const scopes: McpToolScope[] = []

  async function events(): Promise<z.infer<typeof eventSchema>[]> {
    return (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const event = safeJsonParse(line, decodeWithSchema(eventSchema))
        assert.ok(event)
        return event
      })
  }

  async function waitForEvent(
    workspace: string,
    type: string,
  ): Promise<z.infer<typeof eventSchema>> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const event = (await events()).find(
        (event) => event.type === type && event.workspace === workspace,
      )
      if (event) return event
      await delay(5)
    }
    assert.fail(`The real MCP server did not reach ${type}`)
  }

  async function waitForEntered(workspace: string): Promise<void> {
    await waitForEvent(workspace, 'entered')
  }

  async function configure(
    label: string,
    readonly = true,
    holdInitialize = false,
    holdList = false,
  ): Promise<void> {
    await writeFile(
      join(directory, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          owned: {
            command: process.execPath,
            args: [resolve('tests/fixtures/mcp-owned-workspace.mjs')],
            env: {
              MCP_LIFETIME_TRACE: trace,
              MCP_LIFETIME_LABEL: label,
              MCP_LIFETIME_READONLY: String(readonly),
              ...(holdInitialize ? { MCP_LIFETIME_HOLD_INITIALIZE: '1' } : {}),
              ...(holdList ? { MCP_LIFETIME_HOLD_LIST: '1' } : {}),
            },
          },
        },
      }),
    )
  }

  async function acquire(workspace: string): Promise<McpToolScope> {
    const scope = await acquireMcpToolScope(registry, workspace)
    scopes.push(scope)
    return scope
  }

  beforeEach(async () => {
    await shutdownMcpServers()
    directory = await realpath(await mkdtemp(join(tmpdir(), 'copse-mcp-ownership-')))
    a = join(directory, 'project-a')
    b = join(directory, 'project-b')
    trace = join(directory, 'trace.jsonl')
    await Promise.all([mkdir(a), mkdir(b), writeFile(trace, '')])
    setElectronAppRuntime({ userDataPath: directory, version: 'test', isPackaged: false })
    priorE2e = process.env['COPSE_E2E']
    process.env['COPSE_E2E'] = '1'
    registry = new ToolRegistry()
    setPermissionGateForTests(
      async (check) => resolveToolPermission(check.toolName)?.policy !== 'block',
    )
    await setMcpServerUserEnabled('owned', true)
    await configure('A')
    const listed = mock.method(Client.prototype, 'listTools')
    try {
      await runWithWorkspaceRoot(a, () => loadMcpServers(registry))
      const client = listed.mock.calls[0]?.this
      assert.ok(client instanceof Client)
      originalClient = client
      closeOriginal = client.close.bind(client)
    } finally {
      listed.mock.restore()
    }
    assert.equal(registry.has(TOOL), true)
  })

  afterEach(async () => {
    await shutdownMcpServers()
    await Promise.all(scopes.splice(0).map((scope) => scope.release()))
    setPermissionGateForTests(null)
    setElectronAppRuntime(null)
    if (priorE2e === undefined) delete process.env['COPSE_E2E']
    else process.env['COPSE_E2E'] = priorE2e
    await rm(directory, { recursive: true, force: true })
  })

  it('finishes A and its next call on A while B uses its own client and live ordinary tools', async () => {
    const scopeA = await acquire(a)
    const signal = new AbortController().signal
    const first = scopeA.run(() => registry.executeNormalized(TOOL, { hold: true }, signal))
    await waitForEntered(a)
    await configure('B', false)
    await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    const scopeB = await acquire(b)
    assert.equal(
      scopeA.run(() => getMcpToolMeta(TOOL)?.annotations?.readOnlyHint),
      true,
    )
    assert.equal(
      scopeB.run(() => getMcpToolMeta(TOOL)?.annotations?.readOnlyHint),
      false,
    )
    assert.match(
      scopeA.run(() => registry.toLLMTools().find((tool) => tool.name === TOOL)?.description ?? ''),
      /Report the A workspace/,
    )
    assert.match(
      scopeB.run(() => registry.toMcpTools().find((tool) => tool.name === TOOL)?.description ?? ''),
      /Report the B workspace/,
    )
    const onB = await scopeB.run(() => registry.executeNormalized(TOOL, {}, signal))
    assert.ok(onB.result.includes(b))
    await writeFile(join(a, 'mcp.release'), '')
    const firstA = await first
    const secondA = await scopeA.run(() => registry.executeNormalized(TOOL, {}, signal))
    assert.ok(firstA.result.includes(a))
    assert.ok(secondA.result.includes(a))
    const entered = (await events()).filter((event) => event.type === 'entered')
    assert.deepEqual(
      entered.map((event) => event.workspace),
      [a, b, a],
    )
    assert.equal(
      entered[0]?.pid,
      entered[2]?.pid,
      'A keeps the same protocol session between calls',
    )
    assert.notEqual(entered[0]?.pid, entered[1]?.pid)
    registry.register({
      name: 'live_native',
      description: 'live',
      parameters: z.object({}),
      execute: () => 'new native tool',
    })
    assert.equal(
      scopeA.run(() => registry.has('live_native')),
      true,
    )
    registry.unregister('live_native')
    assert.equal(
      scopeA.run(() => registry.has('live_native')),
      false,
    )
  })

  it('loads an offscreen turn using A rather than the visible B workspace', async () => {
    await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    const scopeA = await acquire(a)
    const result = await scopeA.run(() =>
      registry.executeNormalized(TOOL, {}, new AbortController().signal),
    )
    assert.ok(result.result.includes(a))
    assert.ok(!result.result.includes(b))
    assert.equal((await events()).filter((event) => event.type === 'entered').length, 1)
  })

  for (const selfStarted of [false, true]) {
    it(`binds both ACP HTTP calls to A ${selfStarted ? 'during a self-started turn' : 'outside its original async chain'}`, async () => {
      const scopeA = await acquire(a)
      const session = new AbortController()
      // Create the listener outside scopeA: neither HTTP request may depend on
      // inheriting the scope of the server's creation or the visible project.
      const bridge = await startAcpNativeBridge(registry, session.signal, {
        projectId: 'project-a',
        threadId: 'thread-a',
      })
      assert.ok(bridge)
      const context: ThreadExecutionContext = {
        projectId: 'project-a',
        threadId: 'thread-a',
        projectRoot: a,
        root: a,
        checkoutMode: 'shared',
        branch: null,
      }
      const client = new Client({ name: 'agent', version: 'test' }, { capabilities: {} })
      try {
        if (selfStarted) {
          await scopeA.release()
          await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
          bridge.setTurnSignal(new AbortController().signal)
          // The production agent-initiated lease binds this same supported
          // bridge boundary after its continuation authority grants the turn.
          bridge.setExecutionContext(context)
        } else {
          scopeA.run(() => {
            bridge.setExecutionContext(context)
          })
        }
        await client.connect(
          asProtocolTransport(
            new StreamableHTTPClientTransport(new URL(bridge.url), {
              requestInit: { headers: { authorization: `Bearer ${bridge.token}` } },
            }),
          ),
        )
        const pending = client.callTool({ name: TOOL, arguments: { hold: true } })
        await waitForEntered(a)
        if (!selfStarted) {
          await configure('B', false)
          await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
          await scopeA.release()
          assert.match(
            (await client.listTools()).tools.find((tool) => tool.name === TOOL)?.description ?? '',
            /Report the A workspace/,
          )
          assert.match(
            registry.toMcpTools().find((tool) => tool.name === TOOL)?.description ?? '',
            /Report the B workspace/,
          )
        }
        const scopeB = await acquire(b)
        const onB = await scopeB.run(() => registry.executeNormalized(TOOL, {}, session.signal))
        assert.ok(onB.result.includes(b))
        await writeFile(join(a, 'mcp.release'), '')
        const first = await pending
        const second = await client.callTool({ name: TOOL, arguments: {} })
        assert.equal(first.isError, undefined)
        assert.equal(second.isError, undefined)
        const entered = (await events()).filter((event) => event.type === 'entered')
        assert.deepEqual(
          entered.map((event) => event.workspace),
          [a, b, a],
        )
        assert.equal(entered[0]?.pid, entered[2]?.pid)
        assert.notEqual(entered[0]?.pid, entered[1]?.pid)
        bridge.setExecutionContext(null)
        registry.register({
          name: 'read_file',
          description: 'New ordinary tool',
          parameters: z.object({}),
          execute: () => 'read',
        })
        assert.equal(
          (await client.listTools()).tools.some((tool) => tool.name === 'read_file'),
          true,
        )
        registry.unregister('read_file')
        assert.equal(
          (await client.listTools()).tools.some((tool) => tool.name === 'read_file'),
          false,
        )
        const refused = await client.callTool({ name: TOOL, arguments: {} })
        assert.equal(refused.isError, true)
        assert.equal((await events()).filter((event) => event.type === 'entered').length, 3)
      } finally {
        session.abort()
        bridge.setExecutionContext(null)
        await client.close()
        await bridge.close()
      }
    })
  }

  it('keeps an admitted callback alive after its turn releases, then closes its retired client once', async () => {
    const scopeA = await acquire(a)
    const callback = scopeA.run(captureMcpToolScope)
    assert.ok(callback)
    scopes.push(callback)
    const original = (await events()).find((event) => event.workspace === a)
    assert.ok(original)
    await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    await scopeA.release()
    process.kill(original.pid, 0)
    const result = await callback.run(() =>
      registry.executeNormalized(TOOL, {}, new AbortController().signal),
    )
    assert.ok(result.result.includes(a))
    await callback.release()
    await callback.release()
    assert.throws(() => process.kill(original.pid, 0), /ESRCH/)
    assert.throws(() => callback.retain(), /ended/)
  })

  for (const explicit of ['reload', 'disable', 'shutdown']) {
    it(`revokes the retained A connection on explicit ${explicit} without replay`, async () => {
      const scopeA = await acquire(a)
      const pending = scopeA.run(() =>
        registry.executeNormalized(TOOL, { hold: true }, new AbortController().signal),
      )
      const failure = assert.rejects(pending, /Connection closed|disconnected or reconfigured/)
      await waitForEntered(a)
      await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
      if (explicit === 'disable') await setMcpServerUserEnabled('owned', false)
      if (explicit === 'shutdown') await shutdownMcpServers()
      else await runWithWorkspaceRoot(b, () => reloadMcpServers(registry))
      await failure
      await assert.rejects(
        scopeA.run(() => registry.executeNormalized(TOOL, {}, new AbortController().signal)),
        /disconnected or reconfigured/,
      )
      assert.equal((await events()).filter((event) => event.type === 'entered').length, 1)
    })
  }

  it('cancels the original call after navigation and never replays it', async () => {
    const scopeA = await acquire(a)
    const abort = new AbortController()
    const pending = scopeA.run(() => registry.executeNormalized(TOOL, { hold: true }, abort.signal))
    const cancelled = assert.rejects(pending, /stopped by user/)
    await waitForEntered(a)
    await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    abort.abort(new Error('stopped by user'))
    await cancelled
    assert.equal((await events()).filter((event) => event.type === 'entered').length, 1)
  })

  it('cancels admission while another reconnect is held, without later opening a stale turn connection', async () => {
    let releaseClose = (): void => {}
    let enteredClose = (): void => {}
    const held = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enteredClose = resolve
    })
    const originalClose = closeOriginal
    let first = true
    const close = mock.method(Client.prototype, 'close', async function (this: Client) {
      assert.equal(this, originalClient)
      if (first) {
        first = false
        enteredClose()
        await held
      }
      await originalClose()
    })
    let reloading: Promise<unknown> | null = null
    try {
      reloading = runWithWorkspaceRoot(b, () => reloadMcpServers(registry))
      await entered
      const abort = new AbortController()
      const pending = acquireMcpToolScope(registry, a, abort.signal)
      abort.abort(new Error('stopped during admission'))
      await assert.rejects(pending, /stopped during admission/)
      // This assertion happens while the reconnect is deliberately still held.
      assert.equal((await events()).filter((event) => event.type === 'started').length, 1)
      releaseClose()
      await reloading
      // A queued acquisition sees cancellation again before any process starts.
      const scopeB = await acquire(b)
      assert.ok(
        (
          await scopeB.run(() => registry.executeNormalized(TOOL, {}, new AbortController().signal))
        ).result.includes(b),
      )
      assert.deepEqual(
        (await events())
          .filter((event) => event.type === 'started')
          .map((event) => event.workspace),
        [a, b],
      )
    } finally {
      releaseClose()
      await reloading
      close.mock.restore()
    }
  })

  it('isolates a retired connection close failure from the current project', async () => {
    const scopeA = await acquire(a)
    await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    const originalClose = closeOriginal
    const close = mock.method(Client.prototype, 'close', async function (this: Client) {
      assert.equal(this, originalClient)
      await originalClose()
      throw new Error('close acknowledgement failed')
    })
    try {
      await scopeA.release()
    } finally {
      close.mock.restore()
    }
    const scopeB = await acquire(b)
    const result = await scopeB.run(() =>
      registry.executeNormalized(TOOL, {}, new AbortController().signal),
    )
    assert.ok(result.result.includes(b))
    assert.equal((await events()).filter((event) => event.type === 'entered').length, 1)
  })

  it('stops held tool discovery, closes its child and admits the next project without releasing the server', async () => {
    await configure('held listing', true, false, true)
    const abort = new AbortController()
    const admission = acquireMcpToolScope(registry, b, abort.signal)
    const stopped = assert.rejects(admission, /stopped during discovery/)
    let next: Promise<McpToolScope> | undefined
    try {
      const listing = await waitForEvent(b, 'listing')
      abort.abort(new Error('stopped during discovery'))
      await stopped
      next = acquire(a)
      const completed = await Promise.race([next.then(() => true), delay(5000).then(() => false)])
      assert.equal(
        completed,
        true,
        'Stop must release discovery before the server answers tools/list',
      )
      assert.throws(() => process.kill(listing.pid, 0), /ESRCH/)
      assert.equal((await events()).filter((event) => event.type === 'entered').length, 0)
      assert.equal(
        (await events()).some((event) => event.type === 'list-cancelled' && event.workspace === b),
        true,
      )
      const original = await next
      assert.ok(
        (
          await original.run(() =>
            registry.executeNormalized(TOOL, {}, new AbortController().signal),
          )
        ).result.includes(a),
      )
    } finally {
      abort.abort(new Error('stopped during discovery'))
      await writeFile(join(b, 'mcp.list-release'), '')
      await stopped
      await next
    }
  })

  it('quits while a server is still initializing, closes that child and never runs a tool', async () => {
    await configure('initializing', true, true)
    const reloading = runWithWorkspaceRoot(b, () => reloadMcpServers(registry))
    let initializing: z.infer<typeof eventSchema> | undefined
    let quitting: Promise<void> | null = null
    try {
      for (let attempt = 0; attempt < 400; attempt++) {
        initializing = (await events()).find(
          (event) => event.type === 'started' && event.workspace === b,
        )
        if (initializing) break
        await delay(5)
      }
      assert.ok(initializing, 'The real child must be held before initialize responds')
      const pid = initializing.pid
      quitting = shutdownMcpServers()
      const completed = await Promise.race([
        quitting.then(() => true),
        delay(5000).then(() => false),
      ])
      assert.equal(
        completed,
        true,
        'Quit must cancel initialization rather than wait for its connect timeout',
      )
      assert.throws(() => process.kill(pid, 0), /ESRCH/)
      assert.equal((await events()).filter((event) => event.type === 'entered').length, 0)
    } finally {
      await writeFile(join(b, 'mcp.init-release'), '')
      await reloading
      await quitting
    }
  })

  it('cancels a queued reconnect before it can create a child during quit', async () => {
    const reloading = runWithWorkspaceRoot(b, () => reloadMcpServers(registry))
    const quitting = shutdownMcpServers()
    await Promise.all([reloading, quitting])
    assert.equal((await events()).filter((event) => event.workspace === b).length, 0)
    await assert.rejects(acquireMcpToolScope(registry, a), /shut down/)
  })

  it('revokes a queued turn admission before quit can start its held server', async () => {
    await configure('queued admission', true, true)
    const admission = acquireMcpToolScope(registry, b).then(
      (scope) => {
        scopes.push(scope)
        return undefined
      },
      (error: unknown) => error,
    )
    // No await: the actual acquisition is queued but cannot have created its
    // connection yet. Quit must invalidate it before initialization begins.
    const quitting = shutdownMcpServers()
    try {
      const completed = await Promise.race([
        quitting.then(() => true),
        delay(5000).then(() => false),
      ])
      assert.equal(completed, true, 'Queued admission must not postpone quit behind initialize')
      const error = await admission
      assert.ok(error instanceof Error)
      assert.match(error.message, /shut down|disconnected or reconfigured/)
      assert.equal((await events()).filter((event) => event.workspace === b).length, 0)
    } finally {
      await writeFile(join(b, 'mcp.init-release'), '')
      await admission
      await quitting
    }
  })

  it('does not let a queued turn survive a later explicit config reload', async () => {
    const admission = acquireMcpToolScope(registry, a).then(
      (scope) => {
        scopes.push(scope)
        return undefined
      },
      (error: unknown) => error,
    )
    const reloading = runWithWorkspaceRoot(b, () => reloadMcpServers(registry))
    try {
      const error = await admission
      assert.ok(error instanceof Error)
      assert.match(error.message, /shut down|disconnected or reconfigured/)
    } finally {
      await reloading
    }
    assert.deepEqual(
      (await events()).filter((event) => event.type === 'started').map((event) => event.workspace),
      [a, b],
    )
    const replacement = await acquire(b)
    assert.ok(
      (
        await replacement.run(() =>
          registry.executeNormalized(TOOL, {}, new AbortController().signal),
        )
      ).result.includes(b),
    )
  })

  it('preserves a queued offscreen turn through later ordinary navigation', async () => {
    const firstNavigation = runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    const admission = acquireMcpToolScope(registry, a)
    const nextNavigation = runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    const [, scope] = await Promise.all([firstNavigation, admission, nextNavigation])
    scopes.push(scope)
    assert.ok(
      (
        await scope.run(() => registry.executeNormalized(TOOL, {}, new AbortController().signal))
      ).result.includes(a),
    )
    const visible = await acquire(b)
    assert.ok(
      (
        await visible.run(() => registry.executeNormalized(TOOL, {}, new AbortController().signal))
      ).result.includes(b),
    )
  })

  it('does not undo an explicit disconnect when later navigation supersedes its replacement', async () => {
    const scopeA = await acquire(a)
    const original = (await events()).find((event) => event.workspace === a)
    assert.ok(original)
    await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    const reconnect = runWithWorkspaceRoot(b, () => reloadMcpServers(registry))
    const navigate = runWithWorkspaceRoot(a, () => reloadMcpServersForWorkspace(registry))
    await Promise.all([reconnect, navigate])
    assert.throws(() => process.kill(original.pid, 0), /ESRCH/)
    await assert.rejects(
      scopeA.run(() => registry.executeNormalized(TOOL, {}, new AbortController().signal)),
      /disconnected or reconfigured/,
    )
    const replacement = await acquire(a)
    assert.ok(
      (
        await replacement.run(() =>
          registry.executeNormalized(TOOL, {}, new AbortController().signal),
        )
      ).result.includes(a),
    )
    assert.equal((await events()).filter((event) => event.type === 'entered').length, 1)
  })

  it('reports a server error without poisoning B or replaying A', async () => {
    const scopeA = await acquire(a)
    await runWithWorkspaceRoot(b, () => reloadMcpServersForWorkspace(registry))
    await assert.rejects(
      scopeA.run(() =>
        registry.executeNormalized(TOOL, { fail: true }, new AbortController().signal),
      ),
      /Intentional server failure/,
    )
    const scopeB = await acquire(b)
    const result = await scopeB.run(() =>
      registry.executeNormalized(TOOL, {}, new AbortController().signal),
    )
    assert.ok(result.result.includes(b))
    assert.deepEqual(
      (await events()).filter((event) => event.type === 'entered').map((event) => event.workspace),
      [a, b],
    )
  })
})

describe('MCP scoped permission identities', () => {
  it('keeps A origin/source identity while reading later revocation live and isolating B', async () => {
    clearMcpToolPermissionTargets()
    const a: McpPermissionTarget = {
      serverName: 'same',
      toolName: 'read',
      origin: 'project',
      source: '/project-a/.mcp.json',
    }
    const b = { ...a, source: '/project-b/.mcp.json' }
    const idA = registerMcpToolPermissionTarget(a)
    const scopeA = createMcpPermissionScope()
    clearMcpToolPermissionTargets()
    const idB = registerMcpToolPermissionTarget(b)
    assert.notEqual(idA, idB)
    assert.equal(idA, mcpToolPermissionId(a))
    await setSetting('toolPermissionOverrides', { [idA]: 'allow', [idB]: 'ask' })
    assert.equal(
      scopeA(() => resolveToolPermission('mcp__same__read')?.policy),
      'allow',
    )
    assert.equal(resolveToolPermission('mcp__same__read')?.policy, 'ask')
    await setSetting('toolPermissionOverrides', { [idA]: 'block', [idB]: 'allow' })
    assert.deepEqual(
      scopeA(() => resolveToolPermission('mcp__same__read')),
      { id: idA, policy: 'block' },
    )
    assert.deepEqual(resolveToolPermission('mcp__same__read'), { id: idB, policy: 'allow' })
    clearMcpToolPermissionTargets()
    await setSetting('toolPermissionOverrides', {})
  })
})
