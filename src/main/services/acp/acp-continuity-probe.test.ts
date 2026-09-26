import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type PromptRequest,
} from '@agentclientprotocol/sdk'
import {
  classifyReportedCwd,
  probeAgentContinuity,
  type AcpContinuityProbeConfig,
  type AcpContinuityProbeOptions,
  type AcpContinuitySnapshot,
} from './acp-continuity-probe.ts'

/**
 * How the fake agent files its transcripts, which is exactly what the probe
 * exists to tell apart:
 * - `global` finds a session from any cwd (the Codex shape);
 * - `per-cwd` rejects a session created under another cwd;
 * - `per-cwd-silent` accepts it but starts empty — continuity in name only.
 */
type Storage = 'global' | 'per-cwd' | 'per-cwd-silent'

type TransportFactory = NonNullable<AcpContinuityProbeOptions['createTransport']>

function promptText(prompt: PromptRequest['prompt']): string {
  return prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/**
 * A fake agent whose "disk" outlives each process: every transport is a new
 * process, and only `store` carries sessions across them.
 */
function fakeAgentFactory(
  storage: Storage,
  capabilities: { load: boolean; resume: boolean; delete?: boolean },
): {
  createTransport: TransportFactory
  spawnedIn: string[]
  store: Map<string, { cwd: string; transcript: string[] }>
} {
  const store = new Map<string, { cwd: string; transcript: string[] }>()
  const spawnedIn: string[] = []
  const createTransport: TransportFactory = (config) => {
    spawnedIn.push(config.cwd)
    const c2a = new TransformStream<Uint8Array, Uint8Array>()
    const a2c = new TransformStream<Uint8Array, Uint8Array>()
    const live = new Map<string, { cwd: string; transcript: string[] }>()
    let next = store.size
    const attach = (sessionId: string, cwd: string): { cwd: string; transcript: string[] } => {
      const stored = store.get(sessionId)
      if (!stored) throw RequestError.resourceNotFound(sessionId)
      if (stored.cwd !== cwd && storage === 'per-cwd') {
        throw RequestError.resourceNotFound(sessionId)
      }
      const session =
        stored.cwd !== cwd && storage === 'per-cwd-silent' ? { cwd, transcript: [] } : stored
      if (storage === 'global') stored.cwd = cwd
      live.set(sessionId, session)
      return session
    }
    agent({ name: 'fake-continuity-agent' })
      .onRequest('initialize', () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'fake', version: '1.2.3' },
        agentCapabilities: {
          loadSession: capabilities.load,
          sessionCapabilities: {
            ...(capabilities.resume ? { resume: {} } : {}),
            ...(capabilities.delete ? { delete: {} } : {}),
          },
        },
      }))
      .onRequest('session/new', (ctx) => {
        const sessionId = `s-${String(++next)}`
        const session = { cwd: ctx.params.cwd, transcript: [] }
        store.set(sessionId, session)
        live.set(sessionId, session)
        return { sessionId }
      })
      .onRequest('session/load', async (ctx) => {
        const session = attach(ctx.params.sessionId, ctx.params.cwd)
        for (const text of session.transcript) {
          await ctx.client.notify(methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
          })
        }
        return {}
      })
      .onRequest('session/delete', (ctx) => {
        store.delete(ctx.params.sessionId)
        return {}
      })
      .onRequest('session/resume', (ctx) => {
        attach(ctx.params.sessionId, ctx.params.cwd)
        return {}
      })
      .onRequest('session/prompt', async (ctx) => {
        const session = live.get(ctx.params.sessionId)
        if (!session) throw RequestError.resourceNotFound(ctx.params.sessionId)
        const text = promptText(ctx.params.prompt)
        let reply = 'OK'
        if (text.startsWith('Remember')) {
          session.transcript.push(text)
        } else {
          const codeword = session.transcript.join(' ').match(/[A-Z]+-\d{4}/)?.[0] ?? 'UNKNOWN'
          reply = `${codeword}\n${session.cwd}`
        }
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } },
        })
        return { stopReason: 'end_turn' }
      })
      .connect(ndJsonStream(a2c.writable, c2a.readable))
    return Promise.resolve({
      stream: ndJsonStream(c2a.writable, a2c.readable),
      dispose: () => {},
    })
  }
  return { createTransport, spawnedIn, store }
}

const CONFIG: AcpContinuityProbeConfig = {
  agentId: 'fake',
  title: 'Fake',
  command: 'fake-agent',
  originCwd: '/tmp/copse-probe/origin',
  otherCwd: '/tmp/copse-probe/worktree',
}

let seq = 0
const codeword = (): string => `HERON-${String(1000 + ++seq)}`

async function run(
  storage: Storage,
  caps = { load: true, resume: true },
): Promise<{ snapshot: AcpContinuitySnapshot; spawnedIn: string[] }> {
  const fake = fakeAgentFactory(storage, caps)
  const result = await probeAgentContinuity(CONFIG, {
    createTransport: fake.createTransport,
    codeword,
  })
  assert.ok(result.ok, result.ok ? '' : result.error)
  return { snapshot: result.snapshot, spawnedIn: fake.spawnedIn }
}

describe('probeAgentContinuity', () => {
  it('records recall in both directories for an agent that stores sessions globally', async () => {
    const { snapshot } = await run('global')
    assert.equal(snapshot.agentVersion, '1.2.3')
    assert.deepEqual(
      snapshot.trials.map((t) => [t.method, t.cwd, t.outcome, t.reportedCwd]),
      [
        ['load', 'same', 'recalled', 'target'],
        ['load', 'new', 'recalled', 'target'],
        ['resume', 'same', 'recalled', 'target'],
        ['resume', 'new', 'recalled', 'target'],
      ],
    )
    const loadNew = snapshot.trials[1]
    assert.equal(loadNew?.replayHadCodeword, true)
    assert.equal(loadNew.survivesSecondRestart, true)
    // Resume replays nothing, so its history is only provable by asking.
    assert.equal(snapshot.trials.at(3)?.replayedMessages, 0)
  })

  it('reports a rejected reattach when sessions are filed per cwd', async () => {
    const { snapshot } = await run('per-cwd')
    const outcomes = snapshot.trials.map((t) => `${t.method}/${t.cwd}=${t.outcome}`)
    assert.deepEqual(outcomes, [
      'load/same=recalled',
      'load/new=rejected',
      'resume/same=recalled',
      'resume/new=rejected',
    ])
    assert.match(snapshot.trials.at(1)?.error ?? '', /not found/i)
  })

  it('catches an agent that accepts a new-cwd reattach but has forgotten the conversation', async () => {
    const { snapshot } = await run('per-cwd-silent')
    const loadNew = snapshot.trials.find((t) => t.method === 'load' && t.cwd === 'new')
    const resumeNew = snapshot.trials.find((t) => t.method === 'resume' && t.cwd === 'new')
    assert.equal(loadNew?.outcome, 'forgot')
    assert.equal(loadNew.replayedMessages, 0)
    assert.equal(resumeNew?.outcome, 'forgot')
    assert.equal(resumeNew.survivesSecondRestart, null)
  })

  it('deletes every session it seeded when the agent can delete', async () => {
    const fake = fakeAgentFactory('global', { load: true, resume: true, delete: true })
    const result = await probeAgentContinuity(CONFIG, {
      createTransport: fake.createTransport,
      codeword,
    })
    assert.ok(result.ok)
    assert.equal(
      result.snapshot.trials.every((t) => t.outcome === 'recalled'),
      true,
    )
    assert.equal(fake.store.size, 0, 'probe sessions must not outlive the probe')
  })

  it('does not try a method the agent does not advertise', async () => {
    const { snapshot, spawnedIn } = await run('global', { load: true, resume: false })
    assert.deepEqual(snapshot.advertised, { load: true, resume: false })
    assert.deepEqual(
      snapshot.trials.filter((t) => t.method === 'resume').map((t) => t.outcome),
      ['unsupported', 'unsupported'],
    )
    // Initial handshake + two load trials (seed, restart; plus a second restart
    // after the new-cwd success) — never a resume process.
    assert.deepEqual(spawnedIn, [
      CONFIG.originCwd,
      CONFIG.originCwd,
      CONFIG.originCwd,
      CONFIG.originCwd,
      CONFIG.otherCwd,
      CONFIG.otherCwd,
    ])
  })
})

describe('classifyReportedCwd', () => {
  it('matches the target or origin path wherever it appears in the answer', () => {
    assert.equal(classifyReportedCwd('HERON-1\n`/a/b`', '/a/b', '/a/c'), 'target')
    assert.equal(classifyReportedCwd('HERON-1\n/a/d.', '/a/b', '/a/c'), 'other')
    assert.equal(classifyReportedCwd('HERON-1\nLine 2: /a/c', '/a/b', '/a/c'), 'origin')
    assert.equal(classifyReportedCwd('UNKNOWN', '/a/b', '/a/c'), null)
  })
})
