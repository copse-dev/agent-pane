import { ClientActions } from '../clients/client-actions.ts'
import { clientActionSnapshotSchema } from '@shared/client-actions.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import {
  HumanDecisions,
  humanDecisionActor,
  humanDecisionSource,
  type HumanDecisionPrincipal,
} from '../human-decisions.ts'
import { startPluginClientServer } from './plugin-client-server.ts'
import {
  clientSnapshotSchema,
  clientQuestionSnapshotSchema,
  clientActivitySnapshotSchema,
  clientThreadContentSchema,
} from '../../../shared/plugin-client-protocol.ts'

const pairingSchema = z.object({ id: z.uuid(), code: z.string() })
const pairedSchema = z.object({ state: z.string(), token: z.string().optional() })
const resultSchema = z.object({ ok: z.boolean(), reason: z.string() })
async function read<T extends z.ZodType>(response: Response, schema: T): Promise<z.infer<T>> {
  const parsed = safeJsonParse(await response.text(), decodeWithSchema(schema))
  assert.ok(parsed)
  return parsed
}
async function pair(origin: string, browserOrigin?: string): Promise<string> {
  const headers = {
    'Content-Type': 'application/json',
    ...(browserOrigin ? { Origin: browserOrigin } : {}),
  }
  const created = await read(
    await fetch(`${origin}/v1/pair`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version: 1, label: 'Interactive fixture' }),
    }),
    pairingSchema,
  )
  const paired = await read(
    await fetch(`${origin}/v1/pair/${created.id}`, { headers }),
    pairedSchema,
  )
  assert.equal(paired.state, 'approved')
  assert.ok(paired.token)
  return paired.token
}

describe('interactive client approval transport', () => {
  it('does not carry authenticated control across disable while a decision body is arriving', async () => {
    let enabled = true
    let watch = false
    let observed: () => void = () => {}
    const entered = new Promise<void>((resolve) => {
      observed = resolve
    })
    const server = await startPluginClientServer({
      decisions: new HumanDecisions(),
      enabled: () => {
        if (watch) observed()
        return enabled
      },
      approvePair: async () => true,
    })
    try {
      const token = await pair(server.origin)
      watch = true
      let finish: () => void = () => {}
      const status = new Promise<number>((resolve, reject) => {
        const req = request(
          `${server.origin}/v1/decisions`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('error', reject)
        req.flushHeaders()
        finish = (): void => {
          req.end(
            JSON.stringify({
              version: 1,
              submissionId: randomUUID(),
              sessionId: randomUUID(),
              projectId: 'p',
              threadId: 't',
              requestId: randomUUID(),
              revision: 1,
              approved: true,
            }),
          )
        }
      })
      await entered
      enabled = false
      finish()
      assert.equal(await status, 403)
    } finally {
      await server.close()
    }
  })

  it('rechecks pairing authority and rate limits after overlapping request bodies arrive', async () => {
    for (const revoke of [false, true]) {
      let enabled = true
      let entered = 0
      let observed = (): void => {}
      const ready = new Promise<void>((resolve) => {
        observed = resolve
      })
      let prompts = 0
      const server = await startPluginClientServer({
        decisions: new HumanDecisions(),
        enabled: () => {
          if (++entered === 2) observed()
          return enabled
        },
        approvePair: () => {
          prompts++
          return new Promise(() => {})
        },
      })
      try {
        const attempts = [0, 1].map(() => {
          let finish = (): void => {}
          const status = new Promise<number>((resolve, reject) => {
            const req = request(
              `${server.origin}/v1/pair`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              },
              (res) => {
                res.resume()
                resolve(res.statusCode ?? 0)
              },
            )
            req.on('error', reject)
            req.flushHeaders()
            finish = (): void => {
              req.end(JSON.stringify({ version: 1, label: 'Concurrent client' }))
            }
          })
          return { finish, status }
        })
        await ready
        if (revoke) enabled = false
        for (const attempt of attempts) attempt.finish()
        assert.deepEqual(
          (await Promise.all(attempts.map((attempt) => attempt.status))).sort(),
          revoke ? [403, 403] : [202, 429],
        )
        assert.equal(prompts, revoke ? 0 : 1)
      } finally {
        await server.close()
      }
    }
  })

  it('requires desktop pairing, binds browser origin, streams real registrations and settles once', async () => {
    const decisions = new HumanDecisions(),
      id = randomUUID()
    const received: HumanDecisionPrincipal[] = []
    decisions.register(
      'project',
      'thread',
      { id, kind: 'approval', title: 'Run shell', body: 'echo approved', advice: 'Once only' },
      (_answer, principal) => received.push(principal),
      { interactiveClientSupported: true },
    )
    const server = await startPluginClientServer({
      decisions,
      enabled: () => true,
      approvePair: async () => true,
    })
    const controller = new AbortController()
    try {
      assert.equal((await fetch(`${server.origin}/v1/events`)).status, 401)
      assert.equal(
        (
          await fetch(`${server.origin}/v1/pair`, {
            method: 'POST',
            headers: { Origin: 'https://evil.test' },
          })
        ).status,
        403,
      )
      const browserOrigin = 'http://127.0.0.1:17341'
      assert.equal(
        (
          await fetch(`${server.origin}/v1/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: 1, label: 'Spoofed\nPairing code: 000000' }),
          })
        ).status,
        400,
      )
      const token = await pair(server.origin, browserOrigin)
      const headers = {
        Authorization: `Bearer ${token}`,
        Origin: browserOrigin,
        'Content-Type': 'application/json',
      }
      assert.equal(
        (
          await fetch(`${server.origin}/v1/events`, {
            headers: { ...headers, Origin: 'http://127.0.0.1:17342' },
          })
        ).status,
        401,
      )
      const response = await fetch(`${server.origin}/v1/events`, {
        headers,
        signal: controller.signal,
      })
      assert.ok(response.body)
      const reader = response.body.getReader()
      const frame = await reader.read()
      const text = new TextDecoder().decode(frame.value)
      const state = safeJsonParse(text.slice(6).trim(), decodeWithSchema(clientSnapshotSchema))
      assert.ok(state)
      assert.equal(state.canRespond, true)
      assert.equal(state.requests[0]?.body, 'echo approved')
      const request = {
        version: 1,
        sessionId: state.sessionId,
        submissionId: randomUUID(),
        requestId: id,
        projectId: 'project',
        threadId: 'thread',
        revision: state.requests[0].revision,
        approved: true,
      }
      const post = (value: unknown): Promise<Response> =>
        fetch(`${server.origin}/v1/decisions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(value),
        })
      assert.equal((await post({ ...request, remember: true })).status, 400)
      assert.equal(
        (await read(await post({ ...request, sessionId: randomUUID() }), resultSchema)).ok,
        false,
      )
      // Reusing the same submission identity with a changed body fails closed.
      assert.equal((await post(request)).status, 409)
      const valid = { ...request, submissionId: randomUUID() }
      assert.equal((await read(await post(valid), resultSchema)).ok, true)
      assert.equal((await read(await post(valid), resultSchema)).ok, true)
      assert.equal(received.length, 1)
      assert.equal(received[0]?.source, 'plugin-client')
      assert.deepEqual(decisions.snapshot().requests, [])
      const unsupportedId = randomUUID()
      decisions.register(
        'project',
        'thread',
        {
          id: unsupportedId,
          kind: 'approval',
          title: 'Always allow host',
          body: 'Persistent grant',
        },
        () => assert.fail('unsupported prompt answered'),
      )
      const unsupported = decisions.snapshot().requests[0]
      assert.ok(unsupported)
      assert.equal(
        (
          await read(
            await post({
              ...valid,
              submissionId: randomUUID(),
              requestId: unsupportedId,
              revision: unsupported.revision,
            }),
            resultSchema,
          )
        ).ok,
        false,
      )
      const filteredResponse = await fetch(`${server.origin}/v1/events`, {
        headers,
        signal: controller.signal,
      })
      assert.ok(filteredResponse.body)
      const next = await filteredResponse.body.getReader().read()
      const filtered = safeJsonParse(
        new TextDecoder().decode(next.value).slice(6).trim(),
        decodeWithSchema(clientSnapshotSchema),
      )
      assert.ok(filtered)
      assert.deepEqual(filtered.requests, [])
      assert.equal(
        (await read(await post({ ...valid, submissionId: randomUUID() }), resultSchema)).ok,
        false,
      )
      controller.abort()
    } finally {
      controller.abort()
      await server.close()
    }
  })

  it('rejects a previously paired client after disable', async () => {
    const decisions = new HumanDecisions()
    let enabled = true
    const server = await startPluginClientServer({
      decisions,
      enabled: () => enabled,
      approvePair: async () => true,
    })
    try {
      const token = await pair(server.origin)
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      enabled = false
      assert.equal((await fetch(`${server.origin}/v1/events`, { headers })).status, 403)
    } finally {
      await server.close()
    }
  })

  it('keeps pending pairing separate from the remote decision registry and cancels it on close', async () => {
    let signal: AbortSignal | undefined
    const decisions = new HumanDecisions()
    const server = await startPluginClientServer({
      decisions,
      enabled: () => true,
      approvePair: (_label, _code, pendingSignal) => {
        signal = pendingSignal
        return new Promise(() => {})
      },
    })
    const response = await fetch(`${server.origin}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, label: 'Waiting client' }),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(decisions.snapshot().requests, [])
    await server.close()
    assert.equal(signal?.aborted, true)
  })

  it('attributes interactive decisions to a human client rather than a phone', () => {
    const principal: HumanDecisionPrincipal = {
      id: 'client',
      label: 'Approval desk',
      source: 'plugin-client',
    }
    assert.equal(humanDecisionActor(principal), 'user')
    assert.equal(humanDecisionSource(principal), 'plugin-client:client (Approval desk)')
    assert.equal(humanDecisionActor({ id: 'phone', label: 'Phone' }), 'mobile-device')
  })
  it('serves authenticated bounded activity and opens only an exact current project/thread', async () => {
    const row = {
      projectId: 'project',
      projectName: 'Project',
      threadId: randomUUID(),
      title: 'Finished chat',
      state: 'finished',
      settledAt: 42,
    } satisfies import('../../../shared/plugin-client-protocol.ts').ClientActivityData['recentThreads'][number]
    let recent = [row]
    const opened: string[] = []
    const fresh: Array<boolean | undefined> = []
    const server = await startPluginClientServer({
      decisions: new HumanDecisions(),
      enabled: () => true,
      approvePair: async () => true,
      activity: {
        read: async (force) => {
          fresh.push(force)
          return { recentThreads: recent, runningCount: 0, waitingCount: 0 }
        },
      },
      openThread: (projectId, threadId) => {
        opened.push(`${projectId}/${threadId}`)
        return true
      },
    })
    try {
      assert.equal((await fetch(`${server.origin}/v1/activity`)).status, 401)
      const token = await pair(server.origin)
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      assert.equal(
        (
          await fetch(`${server.origin}/v1/activity`, {
            headers: { ...headers, Origin: 'http://127.0.0.1:9999' },
          })
        ).status,
        401,
      )
      const activity = await read(
        await fetch(`${server.origin}/v1/activity`, { headers }),
        clientActivitySnapshotSchema,
      )
      assert.deepEqual(activity.recentThreads, [row])
      const post = (projectId: string, threadId: string): Promise<Response> =>
        fetch(`${server.origin}/v1/threads/open`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ version: 1, projectId, threadId }),
        })
      assert.equal((await post('other', row.threadId)).status, 404)
      assert.equal((await read(await post(row.projectId, row.threadId), resultSchema)).ok, true)
      assert.deepEqual(opened, [`project/${row.threadId}`])
      assert.equal(fresh.at(-1), true)
      recent = []
      assert.equal((await post(row.projectId, row.threadId)).status, 404)
      assert.equal(opened.length, 1)
      assert.equal(
        (
          await fetch(`${server.origin}/v1/threads/open`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              version: 1,
              projectId: row.projectId,
              threadId: row.threadId,
              path: '/private',
            }),
          })
        ).status,
        400,
      )
    } finally {
      await server.close()
    }
  })

  it('rechecks authority after activity reads and never navigates after disable', async () => {
    for (const operation of ['activity', 'threads/open']) {
      let enabled = true
      let entered = (): void => {}
      const loading = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate =
        Promise.withResolvers<
          import('../../../shared/plugin-client-protocol.ts').ClientActivityData
        >()
      let opened = false
      const threadId = randomUUID()
      const server = await startPluginClientServer({
        decisions: new HumanDecisions(),
        enabled: () => enabled,
        approvePair: async () => true,
        activity: {
          read: () => {
            entered()
            return gate.promise
          },
        },
        openThread: () => {
          opened = true
          return true
        },
      })
      try {
        const token = await pair(server.origin)
        const response = fetch(`${server.origin}/v1/${operation}`, {
          method: operation === 'activity' ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(operation === 'activity'
            ? {}
            : { body: JSON.stringify({ version: 1, projectId: 'project', threadId }) }),
        })
        await loading
        enabled = false
        gate.resolve({
          recentThreads: [
            {
              projectId: 'project',
              projectName: 'Project',
              threadId,
              title: 'Private title',
              state: 'finished',
              settledAt: 1,
            },
          ],
          runningCount: 0,
          waitingCount: 0,
        })
        const result = await response
        assert.equal(result.status, 403)
        assert.equal((await result.text()).includes('Private title'), false)
        assert.equal(opened, false)
      } finally {
        await server.close()
      }
    }
  })
})

it('reads only exact recent completions and rechecks revocation and eligibility after hydration', async () => {
  for (const outcome of ['success', 'disabled', 'removed', 'new-completion']) {
    let enabled = true
    const row = {
      projectId: 'project',
      projectName: 'Project',
      threadId: randomUUID(),
      title: 'Finished',
      state: 'finished',
      settledAt: 42,
    } satisfies import('../../../shared/plugin-client-protocol.ts').ClientActivityData['recentThreads'][number]
    let rows = [row]
    let reads = 0
    const entered = Promise.withResolvers<undefined>()
    const gate =
      Promise.withResolvers<import('../../../shared/plugin-client-protocol.ts').ClientThreadText>()
    const server = await startPluginClientServer({
      decisions: new HumanDecisions(),
      enabled: () => enabled,
      approvePair: async () => true,
      activity: {
        read: async (fresh) => {
          assert.equal(fresh, true)
          return { recentThreads: rows, runningCount: 0, waitingCount: 0 }
        },
      },
      readThread: async (projectId, threadId) => {
        assert.equal(projectId, row.projectId)
        assert.equal(threadId, row.threadId)
        reads++
        entered.resolve(undefined)
        return gate.promise
      },
    })
    try {
      const target = {
        version: 1,
        projectId: row.projectId,
        threadId: row.threadId,
        settledAt: row.settledAt,
      }
      const url = `${server.origin}/v1/threads/content`
      assert.equal((await fetch(url, { method: 'POST' })).status, 401)
      const token = await pair(server.origin)
      const post = (value: unknown, origin?: string): Promise<Response> =>
        fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify(value),
        })
      assert.equal((await post(target, 'http://127.0.0.1:9999')).status, 401)
      assert.equal((await post({ ...target, path: '/private' })).status, 400)
      assert.equal((await post({ ...target, projectId: 'other' })).status, 404)
      assert.equal((await post({ ...target, settledAt: 1 })).status, 404)
      assert.equal(reads, 0)
      const pending = post(target)
      await entered.promise
      if (outcome === 'disabled') enabled = false
      if (outcome === 'removed') rows = []
      if (outcome === 'new-completion') rows = [{ ...row, settledAt: 43 }]
      gate.resolve({ messages: [{ role: 'assistant', text: 'Visible answer' }], truncated: false })
      const response = await pending
      if (outcome === 'success') {
        assert.equal(response.status, 200)
        const content = await read(response, clientThreadContentSchema)
        assert.deepEqual(content.messages, [{ role: 'assistant', text: 'Visible answer' }])
      } else {
        assert.equal(response.status, outcome === 'disabled' ? 403 : 404)
        assert.equal((await response.text()).includes('Visible answer'), false)
      }
    } finally {
      gate.resolve({ messages: [], truncated: false })
      await server.close()
    }
  }
})

describe('interactive client desktop actions', () => {
  it('authenticates exact offered actions, blocks approvals, and deduplicates submissions', async () => {
    const decisions = new HumanDecisions(),
      actions = new ClientActions()
    let enabled = true,
      calls = 0
    const revision = randomUUID()
    const offer = {
      projectId: 'p',
      threadId: 't',
      revision,
      actions: [{ id: 'next-step', label: 'Run tests', kind: 'next-step' }],
    } satisfies import('@shared/client-actions.ts').ClientActionOffer
    actions.publish(1, offer, async (_ref, authorized) => {
      if (!authorized()) return false
      calls++
      return true
    })
    const server = await startPluginClientServer({
      decisions,
      actions,
      enabled: () => enabled,
      approvePair: async () => true,
    })
    try {
      assert.equal((await fetch(server.origin + '/v1/actions')).status, 401)
      const token = await pair(server.origin),
        headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      const state = await read(
        await fetch(server.origin + '/v1/actions', { headers }),
        clientActionSnapshotSchema,
      )
      assert.deepEqual(state.offer, offer)
      const input = {
        version: 1,
        sessionId: state.sessionId,
        submissionId: randomUUID(),
        projectId: 'p',
        threadId: 't',
        revision,
        actionId: 'next-step',
      }
      const post = (data: unknown): Promise<Response> =>
        fetch(server.origin + '/v1/actions', {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        })
      assert.equal((await post({ ...input, prompt: 'unoffered prompt' })).status, 400)
      assert.equal((await post({ ...input, sessionId: randomUUID() })).status, 403)
      const cancel = decisions.register(
        'p',
        't',
        { id: randomUUID(), kind: 'approval', title: 'Wait', body: 'command' },
        () => {},
      )
      assert.equal(
        (
          await read(
            await fetch(server.origin + '/v1/actions', { headers }),
            clientActionSnapshotSchema,
          )
        ).offer,
        null,
      )
      assert.equal((await post(input)).status, 403)
      assert.equal(calls, 0)
      cancel()
      assert.equal(
        (await read(await post({ ...input, actionId: 'stale' }), resultSchema)).ok,
        false,
      )
      // Rejected stale references must not exhaust the session's 4096-entry delivery budget.
      for (let attempt = 0; attempt < 4096; attempt++) {
        assert.equal(
          (
            await read(
              await post({ ...input, actionId: 'stale', submissionId: randomUUID() }),
              resultSchema,
            )
          ).ok,
          false,
        )
      }
      const valid = { ...input, submissionId: randomUUID() }
      assert.equal((await read(await post(valid), resultSchema)).ok, true)
      assert.equal((await read(await post(valid), resultSchema)).ok, true)
      assert.equal(calls, 1)
      assert.equal((await post({ ...valid, actionId: 'conflict' })).status, 409)
      actions.publish(1, offer, async () => {
        calls++
        return true
      })
      enabled = false
      assert.equal((await post({ ...input, submissionId: randomUUID() })).status, 403)
      assert.equal(calls, 1)
    } finally {
      await server.close()
    }
  })
})

describe('interactive client questions', () => {
  it('shows pending questions outside recent completions, opens them, settles exact answers once, and withdraws on timeout', async () => {
    const decisions = new HumanDecisions()
    const id = randomUUID()
    const answers: unknown[] = []
    const opened: string[] = []
    const withdraw = decisions.register(
      'p',
      'new-chat',
      {
        id,
        kind: 'question',
        questions: [
          {
            question: 'Which database?',
            options: ['SQLite', 'Postgres', 'Other'],
            recommendedOption: 'SQLite',
            recommendationReason: 'Local data',
          },
          { question: 'Anything else?' },
        ],
      },
      (answer, principal) => answers.push({ answer, principal }),
    )
    let enabled = true
    const server = await startPluginClientServer({
      decisions,
      enabled: () => enabled,
      approvePair: async () => true,
      activity: { read: async () => ({ recentThreads: [], runningCount: 0, waitingCount: 1 }) },
      openThread: (p, t) => {
        opened.push(p + '/' + t)
        return true
      },
    })
    try {
      assert.equal((await fetch(server.origin + '/v1/questions')).status, 401)
      const token = await pair(server.origin)
      const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
      const snapshot = await read(
        await fetch(server.origin + '/v1/questions', { headers }),
        clientQuestionSnapshotSchema,
      )
      const row = snapshot.requests[0]
      assert.ok(row)
      assert.equal(row.threadId, 'new-chat')
      assert.equal(row.questions[0]?.recommendedOption, 'SQLite')
      const open = await fetch(server.origin + '/v1/threads/open', {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 1, projectId: 'p', threadId: 'new-chat' }),
      })
      assert.equal(open.status, 200)
      assert.deepEqual(opened, ['p/new-chat'])
      const input = {
        version: 1,
        sessionId: snapshot.sessionId,
        submissionId: randomUUID(),
        projectId: row.projectId,
        threadId: row.threadId,
        requestId: row.requestId,
        revision: row.revision,
        answers: ['SQLite', 'Typed answer'],
      }
      const post = (value: unknown): Promise<Response> =>
        fetch(server.origin + '/v1/questions', {
          method: 'POST',
          headers,
          body: JSON.stringify(value),
        })
      for (const patch of [
        { sessionId: randomUUID() },
        { projectId: 'other' },
        { threadId: 'other' },
        { revision: row.revision + 1 },
        { requestId: randomUUID() },
        { answers: [] },
      ]) {
        const response = await post({ ...input, ...patch, submissionId: randomUUID() })
        if (response.status === 200) assert.equal((await read(response, resultSchema)).ok, false)
        else assert.equal(response.status, 400)
        assert.equal(answers.length, 0)
      }
      assert.equal((await post({ ...input, answers: ['x'.repeat(8193), ''] })).status, 400)
      assert.equal((await read(await post(input), resultSchema)).ok, true)
      assert.equal((await read(await post(input), resultSchema)).ok, true)
      assert.equal(
        (await read(await post({ ...input, submissionId: randomUUID() }), resultSchema)).ok,
        false,
      )
      assert.equal((await post({ ...input, answers: ['Postgres', ''] })).status, 409)
      assert.equal(answers.length, 1)
      assert.equal(
        (
          await read(
            await fetch(server.origin + '/v1/questions', { headers }),
            clientQuestionSnapshotSchema,
          )
        ).requests.length,
        0,
      )
      withdraw()
      const expired = randomUUID()
      const stop = decisions.register(
        'p',
        'new-chat',
        { id: expired, kind: 'question', questions: [{ question: 'Expired?', options: ['Yes'] }] },
        () => answers.push('unexpected'),
      )
      const pending = await read(
        await fetch(server.origin + '/v1/questions', { headers }),
        clientQuestionSnapshotSchema,
      )
      stop()
      assert.equal(
        (
          await read(
            await post({
              ...input,
              requestId: expired,
              revision: pending.requests[0]?.revision,
              answers: ['Yes'],
              submissionId: randomUUID(),
            }),
            resultSchema,
          )
        ).ok,
        false,
      )
      enabled = false
      assert.equal((await post({ ...input, submissionId: randomUUID() })).status, 403)
      assert.equal(answers.length, 1)
    } finally {
      withdraw()
      await server.close()
    }
  })
})
