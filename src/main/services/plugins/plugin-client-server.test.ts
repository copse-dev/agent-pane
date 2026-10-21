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
  clientActivitySnapshotSchema,
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
