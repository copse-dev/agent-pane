import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@shared/types'
import {
  openAcpSession,
  runAcpSessionPrompt,
  type AcpAgentSpawnConfig,
  type AcpClientHandlers,
  type AcpTransport,
} from './acp-client.ts'
import {
  acquireAcpSession,
  disposeAllAcpSessions,
  reapIdleAcpSessions,
} from './acp-session-pool.ts'

/**
 * A thread's agent session surviving a new agent process — above all one
 * started in a different working directory, as when a read-only thread moves
 * into the worktree it was just given (docs/plans/acp-session-continuity.md).
 *
 * The fake agent keeps its sessions in a store that outlives every
 * "process" (transport), like an agent's on-disk session files, and files
 * them the ways real agents might:
 * - `global` finds a session from any cwd (Claude Agent ACP 0.70.0 and Codex
 *   ACP 1.6.2, per the continuity probe);
 * - `per-cwd` refuses a session created under another cwd;
 * - `per-cwd-silent` accepts it but starts empty.
 */
type Storage = 'global' | 'per-cwd' | 'per-cwd-silent'

interface FakeSession {
  cwd: string
  /** The user prompts this session has seen — the agent's "memory". */
  prompts: string[]
}

interface FakeAgent {
  createTransport: () => Promise<AcpTransport>
  spawns: number
  calls: string[]
  /** What the agent could see of the conversation when each prompt arrived. */
  memoryAtPrompt: string[][]
}

function fakeAgent(storage: Storage, caps: { load: boolean; resume: boolean }): FakeAgent {
  const store = new Map<string, FakeSession>()
  let nextId = 0
  const fake: FakeAgent = {
    spawns: 0,
    calls: [],
    memoryAtPrompt: [],
    createTransport: () => {
      fake.spawns++
      const live = new Map<string, FakeSession>()
      const attach = (sessionId: string, cwd: string): FakeSession => {
        const stored = store.get(sessionId)
        if (!stored) throw RequestError.resourceNotFound(sessionId)
        if (stored.cwd === cwd || storage === 'global') {
          stored.cwd = cwd
          live.set(sessionId, stored)
          return stored
        }
        if (storage === 'per-cwd') throw RequestError.resourceNotFound(sessionId)
        const empty = { cwd, prompts: [] }
        live.set(sessionId, empty)
        return empty
      }
      const c2a = new TransformStream<Uint8Array, Uint8Array>()
      const a2c = new TransformStream<Uint8Array, Uint8Array>()
      const connection = agent({ name: 'fake-continuity-agent' })
        .onRequest('initialize', () => ({
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: caps.load,
            ...(caps.resume ? { sessionCapabilities: { resume: {} } } : {}),
          },
        }))
        .onRequest('session/new', (ctx) => {
          fake.calls.push(`new ${ctx.params.cwd}`)
          const sessionId = `s${String(++nextId)}`
          const session = { cwd: ctx.params.cwd, prompts: [] }
          store.set(sessionId, session)
          live.set(sessionId, session)
          return { sessionId }
        })
        .onRequest('session/resume', (ctx) => {
          fake.calls.push(`resume ${ctx.params.sessionId} ${ctx.params.cwd}`)
          attach(ctx.params.sessionId, ctx.params.cwd)
          return {}
        })
        .onRequest('session/load', async (ctx) => {
          fake.calls.push(`load ${ctx.params.sessionId} ${ctx.params.cwd}`)
          const session = attach(ctx.params.sessionId, ctx.params.cwd)
          // Replay the conversation, as ACP requires, before answering.
          for (const text of session.prompts) {
            await ctx.client.notify(methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
            })
            await ctx.client.notify(methods.client.session.update, {
              sessionId: ctx.params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `replayed answer to ${text}` },
              },
            })
          }
          await ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'review', description: 'Review' }],
            },
          })
          return {}
        })
        .onRequest('session/prompt', async (ctx) => {
          const session = live.get(ctx.params.sessionId)
          if (!session) throw RequestError.resourceNotFound(ctx.params.sessionId)
          const text = ctx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
          fake.memoryAtPrompt.push([...session.prompts])
          session.prompts.push(text)
          await ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `echo:${text}` },
            },
          })
          return { stopReason: 'end_turn' }
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

const PROJECT = '/tmp/continuity/project'
const WORKTREE = '/tmp/continuity/worktree'
const READ_ONLY: AcpAgentSpawnConfig = { command: 'fake', cwd: PROJECT, permissionMode: 'plan' }
const WRITABLE: AcpAgentSpawnConfig = {
  command: 'fake',
  cwd: WORKTREE,
  permissionMode: 'acceptEdits',
}

async function prompt(
  fake: FakeAgent,
  config: AcpAgentSpawnConfig,
  text: string,
): Promise<{ chunks: StreamChunk[]; acquired: Awaited<ReturnType<typeof acquireAcpSession>> }> {
  const acquired = await acquireAcpSession({
    threadId: 'thread',
    config,
    createTransport: fake.createTransport,
  })
  const chunks: StreamChunk[] = []
  const handlers: AcpClientHandlers = {
    onChunk: (chunk) => chunks.push(chunk),
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
  }
  acquired.entry.open.handlers.current = handlers
  await runAcpSessionPrompt(acquired.entry.open, text, undefined)
  return { chunks, acquired }
}

function texts(chunks: StreamChunk[]): string[] {
  return chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.text] : []))
}

describe('ACP session continuity across a new agent process', () => {
  afterEach(async () => {
    await disposeAllAcpSessions()
  })

  it('carries the session into a new working directory with session/load', async () => {
    const fake = fakeAgent('global', { load: true, resume: true })
    await prompt(fake, READ_ONLY, 'plan the fix')

    const moved = await prompt(fake, WRITABLE, 'now make the fix')

    assert.equal(fake.spawns, 2, 'a new cwd needs a new process')
    assert.equal(moved.acquired.fresh, false, 'no transcript replay: the agent kept its memory')
    assert.equal(moved.acquired.handover, null)
    assert.equal(moved.acquired.entry.open.restoredBy, 'load')
    assert.deepEqual(fake.calls, [`new ${PROJECT}`, `load s1 ${WORKTREE}`])
    assert.deepEqual(fake.memoryAtPrompt.at(-1), ['plan the fix'])
    // The load replay is Copse's transcript already on screen; it must not be
    // rendered again as new output. The live state it carried still applies.
    assert.deepEqual(texts(moved.chunks), ['echo:now make the fix'])
    assert.deepEqual(
      moved.acquired.entry.open.availableCommands.map((command) => command.name),
      ['review'],
    )
  })

  it('stays in the moved session across a later idle reap', async () => {
    const fake = fakeAgent('global', { load: true, resume: true })
    await prompt(fake, READ_ONLY, 'one')
    await prompt(fake, WRITABLE, 'two')
    assert.deepEqual(await reapIdleAcpSessions(Date.now() + 11 * 60_000), ['thread'])

    const afterReap = await prompt(fake, WRITABLE, 'three')

    assert.equal(afterReap.acquired.entry.open.restoredBy, 'resume')
    assert.deepEqual(fake.calls.at(-1), `resume s1 ${WORKTREE}`)
    assert.deepEqual(fake.memoryAtPrompt.at(-1), ['one', 'two'])
  })

  it('resumes in place when only the permission mode changes', async () => {
    const fake = fakeAgent('global', { load: true, resume: true })
    await prompt(fake, READ_ONLY, 'one')

    const relaxed = await prompt(fake, { ...READ_ONLY, permissionMode: 'acceptEdits' }, 'two')

    assert.equal(relaxed.acquired.fresh, false)
    assert.equal(relaxed.acquired.entry.open.restoredBy, 'resume')
    assert.deepEqual(fake.memoryAtPrompt.at(-1), ['one'])
  })

  it('reattaches a load-only agent after an idle reap', async () => {
    const fake = fakeAgent('per-cwd', { load: true, resume: false })
    await prompt(fake, READ_ONLY, 'one')
    await reapIdleAcpSessions(Date.now() + 11 * 60_000)

    const again = await prompt(fake, READ_ONLY, 'two')

    assert.equal(again.acquired.entry.open.restoredBy, 'load')
    assert.deepEqual(texts(again.chunks), ['echo:two'])
    assert.deepEqual(fake.memoryAtPrompt.at(-1), ['one'])
  })

  it('hands over, and says why, when the agent cannot load into the new directory', async () => {
    const fake = fakeAgent('global', { load: false, resume: true })
    await prompt(fake, READ_ONLY, 'one')

    const moved = await prompt(fake, WRITABLE, 'two')

    // Resume might well have worked, but nothing could prove it had.
    assert.equal(
      fake.calls.some((call) => call.startsWith('resume')),
      false,
    )
    assert.equal(moved.acquired.fresh, true)
    assert.deepEqual(moved.acquired.handover, {
      reason: 'moved-without-load',
      fromCwd: PROJECT,
      toCwd: WORKTREE,
    })
  })

  it('hands over when a load into the new directory is refused', async () => {
    const fake = fakeAgent('per-cwd', { load: true, resume: true })
    await prompt(fake, READ_ONLY, 'one')

    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(' '))
    }
    let moved: Awaited<ReturnType<typeof prompt>>
    try {
      moved = await prompt(fake, WRITABLE, 'two')
    } finally {
      console.warn = warn
    }

    // The refusal is logged, but never with the agent's session ID in it.
    assert.ok(warnings.some((line) => line.includes('session/load was refused')))
    assert.equal(
      warnings.some((line) => line.includes('s1')),
      false,
    )

    assert.equal(moved.acquired.fresh, true)
    assert.equal(moved.acquired.handover?.reason, 'rejected')
    assert.deepEqual(fake.calls.slice(-2), [`load s1 ${WORKTREE}`, `new ${WORKTREE}`])
  })

  it('does not trust a load that replays none of the conversation', async () => {
    const fake = fakeAgent('per-cwd-silent', { load: true, resume: true })
    await prompt(fake, READ_ONLY, 'one')

    const moved = await prompt(fake, WRITABLE, 'two')

    assert.equal(moved.acquired.fresh, true, 'the transcript must be replayed into the new session')
    assert.equal(moved.acquired.handover?.reason, 'history-missing')
    assert.notEqual(moved.acquired.entry.open.session.sessionId, 's1')
  })

  it('reports nothing lost when the old session was never prompted', async () => {
    const fake = fakeAgent('global', { load: false, resume: false })
    await acquireAcpSession({
      threadId: 'thread',
      config: READ_ONLY,
      createTransport: fake.createTransport,
    })

    const moved = await prompt(fake, WRITABLE, 'first')

    assert.equal(moved.acquired.fresh, true)
    assert.equal(moved.acquired.handover, null)
  })

  it('never hands a session to a different agent', async () => {
    const fake = fakeAgent('global', { load: true, resume: true })
    await prompt(fake, READ_ONLY, 'one')

    const other = await prompt(fake, { ...WRITABLE, command: 'another-agent' }, 'two')

    assert.equal(other.acquired.fresh, true)
    assert.equal(other.acquired.handover, null)
    assert.equal(
      fake.calls.some((call) => call.startsWith('load')),
      false,
    )
  })

  it('drops the load replay even when a sink is already listening', async () => {
    const fake = fakeAgent('global', { load: true, resume: true })
    await prompt(fake, READ_ONLY, 'plan the fix')
    await disposeAllAcpSessions()

    // The pool installs a turn's sink only after the session opens; a sink
    // attached from the start shows what the update pump would forward.
    const seen: StreamChunk[] = []
    const open = await openAcpSession(
      WRITABLE,
      {
        current: {
          onChunk: (chunk) => seen.push(chunk),
          requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' as const } }),
        },
      },
      fake.createTransport,
      { sessionId: 's1', cwd: PROJECT, hasHistory: true },
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(open.restoredBy, 'load')
      assert.deepEqual(seen, [], 'replayed history must not be rendered as new output')
    } finally {
      open.dispose()
    }
  })
})
