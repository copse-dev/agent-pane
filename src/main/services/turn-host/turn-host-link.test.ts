import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Thread } from '@shared/types/thread.ts'
import type { HostDispatchRecord } from './host-dispatch-record.ts'
import type { AppToHost, HostToApp, TurnHostConnection } from './turn-host-protocol.ts'
import { TurnHostLink, type TurnHostLinkDependencies } from './turn-host-link.ts'

const childThread: Thread = {
  id: 'child',
  title: 'Build checks',
  status: 'idle',
  model: 'claude-sonnet-4-6',
  messages: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  createdAt: 0,
  updatedAt: 0,
}

const VERSION = '1.0.0'

/**
 * A scripted host. Each connection it accepts records what the app sends and
 * answers through `respond`; `drop` ends the current line as a crash would.
 */
class FakeHost {
  sent: AppToHost[] = []
  connections = 0
  reachable = true
  pid = 4242
  respond: (message: AppToHost, reply: (message: HostToApp) => void) => void = () => undefined
  private current: { onClose: () => void; open: boolean } | null = null
  private listener: ((message: HostToApp) => void) | null = null

  connect: TurnHostLinkDependencies['connect'] = (onMessage, onClose) => {
    if (!this.reachable) return Promise.resolve(null)
    this.connections += 1
    const line = { onClose, open: true }
    this.current = line
    this.listener = onMessage
    const connection: TurnHostConnection = {
      send: (message) => {
        if (!line.open) return
        this.sent.push(message)
        if (message.t === 'hello') {
          queueMicrotask(() => {
            onMessage({ t: 'hello', version: VERSION, protocol: 1, pid: this.pid })
          })
          return
        }
        this.respond(message, (reply) => {
          queueMicrotask(() => {
            if (line.open) onMessage(reply)
          })
        })
      },
      close: () => {
        line.open = false
      },
    }
    return Promise.resolve(connection)
  }

  /** Say something unprompted, as the host does for a turn's prompt. */
  say(message: HostToApp): void {
    const line = this.current
    if (line?.open) this.listener?.(message)
  }

  drop(): void {
    const line = this.current
    if (!line?.open) return
    line.open = false
    line.onClose()
  }
}

function link(
  host: FakeHost,
  overrides: Partial<TurnHostLinkDependencies> = {},
): { link: TurnHostLink; uncertain: string[]; taken: string[] } {
  const uncertain: string[] = []
  const taken: string[] = []
  return {
    link: new TurnHostLink({
      version: VERSION,
      connect: host.connect,
      readRecord: () => Promise.resolve(null),
      isAlive: () => true,
      settleUncertain: (_projectId, threadId): Promise<void> => {
        uncertain.push(threadId)
        return Promise.resolve()
      },
      onThreadTaken: (_projectId, threadId) => taken.push(threadId),
      createId: () => 'op-1',
      ...overrides,
    }),
    uncertain,
    taken,
  }
}

const dispatched = (host: FakeHost): number => host.sent.filter((m) => m.t === 'dispatch').length

describe('TurnHostLink', () => {
  it('runs a turn in the host and resolves once it ends', async () => {
    const host = new FakeHost()
    host.respond = (message, reply): void => {
      if (message.t !== 'dispatch') return
      reply({ t: 'accepted', id: message.id, threadId: message.threadId })
      reply({ t: 'ended', id: message.id, threadId: message.threadId })
    }
    const { link: line, taken } = link(host)
    assert.equal(await line.run('p1', 't1', 'Hello'), 'host')
    assert.deepEqual(taken, ['t1'])
    assert.deepEqual(line.runningThreadIds(), [])
  })

  it('stops host turns for a quit and waits for them to end', async () => {
    const host = new FakeHost()
    let endTurn = (): void => undefined
    const dispatchedTurn = Promise.withResolvers<undefined>()
    host.respond = (message, reply): void => {
      if (message.t === 'dispatch') {
        reply({ t: 'accepted', id: message.id, threadId: message.threadId })
        dispatchedTurn.resolve(undefined)
        endTurn = (): void => {
          reply({ t: 'ended', id: message.id, threadId: message.threadId })
        }
      }
      if (message.t === 'stop-all') {
        endTurn()
        reply({ t: 'stopped-all' })
      }
    }
    const { link: line } = link(host)
    const placed = line.run('p1', 't1', 'Hello')
    await dispatchedTurn.promise
    await line.stopAllForQuit(60_000)
    assert.deepEqual(
      host.sent.filter((m) => m.t === 'stop-all'),
      [{ t: 'stop-all', reason: 'quit' }],
    )
    assert.equal(await placed, 'host')
    assert.deepEqual(line.runningThreadIds(), [])
  })

  it("waits for a quit to stop the host's own turns too, not only the ones it sent", async () => {
    const host = new FakeHost()
    let drained = (): void => undefined
    host.respond = (message, reply): void => {
      if (message.t === 'stop-all')
        drained = (): void => {
          reply({ t: 'stopped-all' })
        }
    }
    const { link: line } = link(host)
    assert.ok(await line.ensureConnected())
    let stopped = false
    const quit = line.stopAllForQuit(60_000).then(() => {
      stopped = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(stopped, false, 'a wake the host began is still ending')
    drained()
    await quit
    assert.equal(stopped, true)
  })

  it('gives up on a host that never says hello', async () => {
    const host = new FakeHost()
    const connect = host.connect
    // It takes the line and never answers.
    const silentConnect: TurnHostLinkDependencies['connect'] = (_onMessage, onClose) =>
      connect(() => undefined, onClose)
    host.connect = silentConnect
    const { link: line } = link(host, { connect: host.connect, helloTimeoutMs: 5 })
    assert.equal(await line.ensureConnected(), false)
    assert.equal(await line.run('p1', 't1', 'Hello'), 'app')
  })

  it('answers a task call it carried out after the line dropped, without a second run', async () => {
    const host = new FakeHost()
    const calls = Promise.withResolvers<undefined>()
    let runs = 0
    const result = Promise.withResolvers<{ task: null }>()
    const { link: line } = link(host, {
      callTaskSupervisor: () => {
        runs += 1
        calls.resolve(undefined)
        return result.promise
      },
    })
    assert.ok(await line.ensureConnected())
    const call = {
      t: 'task-call' as const,
      id: 'call-1',
      projectId: 'p1',
      threadId: 't1',
      call: { op: 'cancel' as const, projectId: 'p1', taskId: 'task-1' },
    }
    host.say(call)
    await calls.promise
    host.drop()
    result.resolve({ task: null })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(await line.ensureConnected())
    host.say(call)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(runs, 1, 'carried out once')
    assert.deepEqual(host.sent.filter((m) => m.t === 'task-call-answer').at(-1), {
      t: 'task-call-answer',
      id: 'call-1',
      result: { task: null },
    })
  })

  it('hands a refused turn back to the app', async () => {
    const host = new FakeHost()
    host.respond = (message, reply): void => {
      if (message.t === 'dispatch')
        reply({ t: 'refused', id: message.id, threadId: message.threadId, reason: 'no' })
    }
    const { link: line } = link(host)
    assert.equal(await line.run('p1', 't1', 'Hello'), 'app')
  })

  it('runs in the app when no host answers', async () => {
    const host = new FakeHost()
    host.reachable = false
    const { link: line } = link(host)
    assert.equal(await line.run('p1', 't1', 'Hello'), 'app')
    assert.equal(dispatched(host), 0)
  })

  it('never reruns a turn the host finished after the line dropped', async () => {
    const host = new FakeHost()
    let ran = 0
    host.respond = (message, reply): void => {
      if (message.t === 'dispatch') {
        ran += 1
        reply({ t: 'accepted', id: message.id, threadId: message.threadId })
        // The line drops before `ended` arrives; the host finishes anyway.
        queueMicrotask(() => {
          host.drop()
        })
      }
      if (message.t === 'status') reply({ t: 'status', id: message.id, state: 'ended' })
    }
    const { link: line } = link(host)
    assert.equal(await line.run('p1', 't1', 'Hello'), 'host')
    assert.equal(ran, 1)
    assert.equal(host.connections, 2, 'the app reconnected to ask')
  })

  it('never reruns a turn whose host was killed after taking it', async () => {
    const host = new FakeHost()
    const record: HostDispatchRecord = { operationId: 'op-1', state: 'claimed', at: 1 }
    host.respond = (message, reply): void => {
      if (message.t !== 'dispatch') return
      reply({ t: 'accepted', id: message.id, threadId: message.threadId })
      queueMicrotask(() => {
        // Killed mid-turn: the line drops and nothing answers any more.
        host.reachable = false
        host.drop()
      })
    }
    const { link: line, uncertain } = link(host, {
      readRecord: () => Promise.resolve(record),
      isAlive: () => false,
    })
    assert.equal(await line.run('p1', 't1', 'Hello'), 'host')
    assert.equal(dispatched(host), 1)
    assert.deepEqual(uncertain, [], 'the follower settles it from the abandoned lease')
  })

  it('runs in the app a turn a dead host never claimed', async () => {
    const host = new FakeHost()
    host.respond = (message): void => {
      if (message.t !== 'dispatch') return
      queueMicrotask(() => {
        host.reachable = false
        host.drop()
      })
    }
    const { link: line } = link(host, { isAlive: () => false })
    assert.equal(await line.run('p1', 't1', 'Hello'), 'app')
  })

  it('leaves a turn it cannot place to the user rather than running it', async () => {
    const host = new FakeHost()
    host.respond = (message): void => {
      if (message.t !== 'dispatch') return
      queueMicrotask(() => {
        host.reachable = false
        host.drop()
      })
    }
    // No record, but the host process is still alive: it may yet have claimed it.
    const { link: line, uncertain } = link(host, { isAlive: () => true })
    assert.equal(await line.run('p1', 't1', 'Hello'), 'host')
    assert.deepEqual(uncertain, ['t1'])
  })

  it('sends no turns to a host of another version', async () => {
    const host = new FakeHost()
    const { link: line } = link(host, { version: '2.0.0' })
    assert.equal(await line.run('p1', 't1', 'Hello'), 'app')
    assert.equal(dispatched(host), 0)
  })

  it("puts a host turn's prompt to the user once, and sends the answer back", async () => {
    const host = new FakeHost()
    const asked: string[] = []
    let answer = (_approved: boolean): void => undefined
    const { link: line } = link(host, {
      askUser: (prompt) =>
        new Promise((resolve) => {
          asked.push(prompt.threadId)
          answer = (approved): void => {
            resolve({ approved, remember: false })
          }
        }),
    })
    assert.ok(await line.ensureConnected())
    const prompt = {
      t: 'approval' as const,
      id: 'a1',
      projectId: 'p1',
      threadId: 't1',
      request: { title: 'Run ls?', body: 'ls', type: 'shell' as const },
    }
    host.say(prompt)
    // Asked again on attach while it still shows: one prompt, not two.
    host.say(prompt)
    assert.deepEqual(asked, ['t1'])
    answer(true)
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve)
    })
    await Promise.resolve()
    assert.deepEqual(
      host.sent.filter((m) => m.t === 'approval-answer'),
      [{ t: 'approval-answer', id: 'a1', response: { approved: true, remember: false } }],
    )
  })

  it('takes a prompt down when the host no longer needs it, and sends nothing', async () => {
    const host = new FakeHost()
    let aborted = false
    const { link: line } = link(host, {
      askUser: (_prompt, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve({ approved: false, remember: false })
          })
        }),
    })
    assert.ok(await line.ensureConnected())
    host.say({
      t: 'approval',
      id: 'a2',
      projectId: 'p1',
      threadId: 't1',
      request: { title: 'Run ls?', body: 'ls', type: 'shell' },
    })
    host.say({ t: 'approval-cancel', id: 'a2' })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(aborted, true)
    assert.equal(host.sent.filter((m) => m.t === 'approval-answer').length, 0)
  })

  it('sends a staged edit to the diff panel and an SSH question to its dialog', async () => {
    const host = new FakeHost()
    const { link: line } = link(host, {
      reviewDiff: () => Promise.resolve(true),
      askSsh: () => Promise.resolve({ value: 'yes' }),
    })
    assert.ok(await line.ensureConnected())
    host.say({
      t: 'review-diff',
      id: 'd1',
      projectId: 'p1',
      threadId: 't1',
      entry: { path: 'a.txt', before: 'a', after: 'b', language: 'plaintext' },
    })
    host.say({
      t: 'ssh-prompt',
      id: 's1',
      projectId: 'p1',
      threadId: 't1',
      request: { prompt: 'Continue connecting?', kind: 'confirm' },
    })
    // An approval with nothing to show it stays with the host.
    host.say({
      t: 'approval',
      id: 'a1',
      projectId: 'p1',
      threadId: 't1',
      request: { title: 'Run ls?', body: 'ls', type: 'shell' },
    })
    for (let i = 0; i < 4; i++) await Promise.resolve()
    assert.deepEqual(
      host.sent.filter((m) => m.t.endsWith('-answer')),
      [
        { t: 'review-diff-answer', id: 'd1', approved: true },
        { t: 'ssh-prompt-answer', id: 's1', response: { value: 'yes' } },
      ],
    )
  })

  it('runs a scripted scenario operation in the host, and gives up when the line drops', async () => {
    const host = new FakeHost()
    const status = {
      complete: false,
      turn: 0,
      response: 1,
      waitingFor: 'hold',
      cancelledTurns: 0,
      errors: [],
    }
    host.respond = (message, reply): void => {
      if (message.t !== 'test-scenario') return
      if (message.op.kind === 'status') reply({ t: 'test-scenario-result', id: message.id, status })
      else
        queueMicrotask(() => {
          host.drop()
        })
    }
    const { link: line } = link(host)
    assert.deepEqual(await line.testScenario({ kind: 'status', scenarioId: 's1' }), { status })
    assert.equal(await line.testScenario({ kind: 'clear' }), null)
    host.reachable = false
    assert.equal(await line.testScenario({ kind: 'clear' }), null, 'no host, no answer')
  })

  it("has this window submit a host turn's prompt to another thread", async () => {
    const host = new FakeHost()
    const answered = Promise.withResolvers<AppToHost>()
    host.respond = (message): void => {
      if (message.t === 'thread-prompt-answer') answered.resolve(message)
    }
    const submitted: string[] = []
    const { link: line } = link(host, {
      sendThreadPrompt: (command) => {
        submitted.push(command.text)
        return Promise.resolve({ ok: true, queued: true })
      },
    })
    assert.ok(await line.ensureConnected())
    const command = {
      sourceThreadId: 't1',
      projectId: 'p1',
      thread: childThread,
      text: 'Check the build.',
    }
    const prompt = {
      t: 'thread-prompt',
      id: 'q1',
      projectId: 'p1',
      threadId: 't1',
      command,
    } as const
    host.say(prompt)
    // Asked again on a re-attach while the first is still out: submitted once.
    host.say(prompt)
    assert.deepEqual(await answered.promise, {
      t: 'thread-prompt-answer',
      id: 'q1',
      result: { ok: true, queued: true },
    })
    assert.deepEqual(submitted, ['Check the build.'])
  })

  it("mirrors a host turn's live command output to the terminal pane", async () => {
    const host = new FakeHost()
    const output: Array<[string, string | null]> = []
    const { link: line } = link(host, {
      onShellOutput: (chunk, taskId) => output.push([chunk, taskId]),
    })
    assert.ok(await line.ensureConnected())
    host.say({ t: 'shell-output', chunk: '1\n2\n', taskId: 'call-1' })
    assert.deepEqual(output, [['1\n2\n', 'call-1']])
  })

  it("saves a host turn's store write and tells the host the profile changed", async () => {
    const host = new FakeHost()
    const saved: unknown[] = []
    const { link: line } = link(host, {
      applyStoreWrite: (message) => saved.push([message.store, message.changes]),
    })
    line.profileChanged()
    assert.equal(host.sent.length, 0, 'no host on the line yet')
    assert.ok(await line.ensureConnected())
    host.say({ t: 'store-write', store: 'config', changes: [{ key: 'k', deleted: true }] })
    line.profileChanged()
    assert.deepEqual(saved, [['config', [{ key: 'k', deleted: true }]]])
    assert.ok(host.sent.some((m) => m.t === 'profile-changed'))
  })
})
