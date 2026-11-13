import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { LLMMessage, LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import type { QueuedUserMessage } from '@shared/types'
import {
  closeThreadStoreIndexes,
  saveProjectThread,
  getThreadMeta,
  getProjectThread,
  updateMeta,
  saveAgentHistory,
  loadAgentHistory,
  loadUserSteeringReceipts,
} from './thread-store.ts'
import {
  NativeSteeringSession,
  bindNativeSteering,
  steerNativeParent,
  prepareNativeSteeringNote,
} from './native-steering.ts'

const prepare = async (text: string): Promise<LLMMessage[]> => [{ role: 'user', content: text }]

describe('native human steering boundary and durability', () => {
  let root: string
  let controller: AbortController
  let session: NativeSteeringSession
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-steering-'))
    configureThreadStore({ workspaceRoot: () => root })
    controller = new AbortController()
    session = new NativeSteeringSession('p', 't', 'human-epoch', controller.signal)
    await saveProjectThread('p', {
      id: 't',
      title: 'Steering',
      status: 'running',
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: 1,
      updatedAt: 1,
      currentEpoch: 'human-epoch',
      continuationUsed: 5,
    })
  })
  afterEach(async () => {
    await session.close()
    closeThreadStoreIndexes()
    configureThreadStore()
    rmSync(root, { recursive: true, force: true })
  })
  async function queue(id: string, overrides: Partial<QueuedUserMessage> = {}): Promise<void> {
    const meta = await getThreadMeta('p', 't')
    await updateMeta('p', 't', {
      pendingMessages: [
        ...(meta?.pendingMessages ?? []),
        {
          messageId: id,
          payload: { content: `Note ${id}` },
          createdAt: 2,
          autoDispatch: false,
          steeringRequested: session.runId,
          ...overrides,
        },
      ],
    })
  }

  it('finishes both tools, checkpoints the note, then sends it in the same loop without a budget grant', async () => {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const messages: LLMMessage[] = [{ role: 'user', content: 'Start' }]
    const requests: LLMMessage[][] = []
    const tools: string[] = []
    const provider: LLMProvider = {
      async *stream(input): AsyncGenerator<ProviderStreamChunk> {
        requests.push(structuredClone(input))
        if (requests.length === 1) {
          yield { type: 'tool_call', toolCall: { id: 'a', name: 'read_file', args: { path: 'a' } } }
          yield { type: 'tool_call', toolCall: { id: 'b', name: 'read_file', args: { path: 'b' } } }
        } else {
          assert.deepEqual(await loadAgentHistory('p', 't'), input)
          assert.equal((await loadUserSteeringReceipts('p', 't')).at(-1)?.state, 'applied')
          yield { type: 'text', text: 'Finished with the correction.' }
        }
        yield { type: 'done' }
      },
    }
    const loop = runAgentLoop({
      provider,
      messages,
      tools: [],
      signal: controller.signal,
      maxSteps: 2,
      adaptiveExtensions: false,
      maxLlmCalls: 2,
      continuationBudget: {
        remaining: () => 0,
        tryGrant: () => assert.fail('Steering cannot consume or reset C3'),
      },
      beforeStep: () =>
        session.drain(
          messages,
          () => saveAgentHistory('p', 't', messages),
          () => {},
          prepare,
        ),
      executeTool: async (_name, _args, signal, id) => {
        started.resolve(undefined)
        await release.promise
        assert.equal(signal.aborted, false)
        tools.push(id)
        return 'Read once'
      },
      onChunk: () => {},
    })
    await started.promise
    await queue('correction')
    const delivery = session.enqueue('correction')
    assert.equal(session.enqueue('correction'), delivery)
    assert.equal(requests.length, 1)
    release.resolve(undefined)
    await loop
    assert.deepEqual(await delivery, { state: 'applied' })
    assert.equal(requests.length, 2)
    assert.deepEqual(tools.sort(), ['a', 'b'])
    const next = requests[1]
    assert.equal(next?.at(-1)?.role, 'user')
    assert.deepEqual(next.at(-1), { role: 'user', content: 'Note correction' })
    assert.equal(next.at(-2)?.role, 'tool')
    assert.equal((await getThreadMeta('p', 't'))?.continuationUsed, 5)
    assert.equal((await getThreadMeta('p', 't'))?.currentEpoch, 'human-epoch')
  })

  it('holds a note when Stop wins the boundary and does not change history', async () => {
    await queue('stop')
    const delivery = session.enqueue('stop')
    controller.abort()
    await session.drain(
      [],
      async () => assert.fail('No checkpoint after Stop'),
      () => assert.fail(),
      prepare,
    )
    await session.close()
    assert.deepEqual(await delivery, { state: 'held' })
    assert.deepEqual(await loadAgentHistory('p', 't'), [])
    assert.equal((await getThreadMeta('p', 't'))?.pendingMessages?.[0]?.autoDispatch, false)
  })

  it('settles all notes when completion wins admission', async () => {
    await queue('one')
    await queue('two')
    const one = session.enqueue('one')
    const two = session.enqueue('two')
    await session.close()
    assert.deepEqual(await Promise.all([one, two]), [{ state: 'held' }, { state: 'held' }])
    assert.deepEqual(await loadAgentHistory('p', 't'), [])
  })

  it('applies concurrent admissions in FIFO order with a checkpoint for each note', async () => {
    await queue('one')
    await queue('two')
    const one = session.enqueue('one')
    const two = session.enqueue('two')
    const messages: LLMMessage[] = []
    const checkpoints: LLMMessage[][] = []
    await session.drain(
      messages,
      async () => {
        checkpoints.push(structuredClone(messages))
        await saveAgentHistory('p', 't', messages)
      },
      () => {},
      prepare,
    )
    assert.deepEqual(await Promise.all([one, two]), [{ state: 'applied' }, { state: 'applied' }])
    assert.deepEqual(checkpoints, [
      [{ role: 'user', content: 'Note one' }],
      [
        { role: 'user', content: 'Note one' },
        { role: 'user', content: 'Note two' },
      ],
    ])
  })

  it('holds a note when the existing model-call allowance runs out', async () => {
    await queue('capped')
    let delivery: Promise<{ state: 'applied' | 'held' }> | undefined
    let calls = 0
    const messages: LLMMessage[] = [{ role: 'user', content: 'Read a file' }]
    await runAgentLoop({
      provider: {
        async *stream(): AsyncGenerator<ProviderStreamChunk> {
          calls++
          yield {
            type: 'tool_call',
            toolCall: { id: 'read', name: 'read_file', args: { path: 'a' } },
          }
          yield { type: 'done' }
        },
      },
      messages,
      tools: [],
      maxSteps: 3,
      maxLlmCalls: 1,
      adaptiveExtensions: false,
      onChunk: () => {},
      executeTool: async () => {
        delivery = session.enqueue('capped')
        return 'Read once'
      },
      beforeStep: () =>
        session.drain(
          messages,
          async () => assert.fail('Steering cannot buy another model request'),
          () => assert.fail(),
          prepare,
        ),
    })
    await session.close()
    assert.deepEqual(await delivery, { state: 'held' })
    assert.equal(calls, 1)
    assert.equal(
      messages.some((message) => message.role === 'user' && message.content === 'Note capped'),
      false,
    )
  })

  it('rejects a stale run nonce even when the replacement shares the human epoch', async () => {
    const unbind = bindNativeSteering(session)
    try {
      assert.throws(() => steerNativeParent('p', 't', 'note', 'old-run'), /turn has ended/)
      assert.throws(
        () => steerNativeParent('other', 't', 'note', session.runId),
        /only during a native/,
      )
    } finally {
      unbind()
    }
    assert.throws(() => steerNativeParent('p', 't', 'note', session.runId), /only during a native/)
  })

  it('rejects hook and unpersisted admission markers before recording acceptance', async () => {
    await queue('hook', { origin: { kind: 'hook', hookId: 'h', event: 'stop' } })
    await assert.rejects(session.enqueue('hook'), /human-authored/)
    await queue('stale', { steeringRequested: 'old-run' })
    await assert.rejects(session.enqueue('stale'), /human-authored/)
    assert.deepEqual(await loadUserSteeringReceipts('p', 't'), [])
  })

  it('runs the production preparation gate before sending only redacted steering to the provider', async () => {
    await queue('blocked')
    await queue('redacted')
    const blocked = assert.rejects(session.enqueue('blocked'), /Hook blocked/)
    const delivered = session.enqueue('redacted')
    const messages: LLMMessage[] = []
    const preparation: string[] = []
    let requests = 0
    await runAgentLoop({
      messages,
      tools: [],
      signal: controller.signal,
      provider: {
        async *stream(input): AsyncGenerator<ProviderStreamChunk> {
          requests++
          assert.deepEqual(input, [{ role: 'user', content: '[PRIVATE]' }])
          yield { type: 'text', text: 'Done.' }
          yield { type: 'done' }
        },
      },
      executeTool: async () => assert.fail('No tools'),
      onChunk: () => {},
      beforeStep: () =>
        session.drain(
          messages,
          () => saveAgentHistory('p', 't', messages),
          () => {},
          (text) =>
            prepareNativeSteeringNote(text, {
              submit: async (note) => {
                preparation.push(`hook:${note}`)
                return note === 'Note blocked'
                  ? { blocked: 'Hook blocked' }
                  : { blocked: null, injectContext: 'Approved context' }
              },
              redact: async (note) => {
                preparation.push(`redact:${note}`)
                return { content: '[PRIVATE]', notice: 'Redacted' }
              },
              signal: controller.signal,
              inject: (context) => preparation.push(`inject:${context ?? ''}`),
              notice: (notice) => preparation.push(`notice:${notice}`),
            }),
        ),
    })
    await blocked
    assert.deepEqual(await delivered, { state: 'applied' })
    assert.deepEqual(await loadAgentHistory('p', 't'), [{ role: 'user', content: '[PRIVATE]' }])
    assert.equal(requests, 1)
    assert.deepEqual(preparation, [
      'hook:Note blocked',
      'hook:Note redacted',
      'redact:Note redacted',
      'inject:Approved context',
      'notice:Redacted',
    ])
    assert.deepEqual(
      (await getThreadMeta('p', 't'))?.pendingMessages?.map((item) => item.messageId),
      ['blocked'],
    )
  })

  it('removes an applied note without a window and rejects stale autosave resurrection after reload', async () => {
    await queue('detached')
    const stale = (await getThreadMeta('p', 't'))?.pendingMessages
    assert.ok(stale)
    const delivery = session.enqueue('detached')
    const messages: LLMMessage[] = []
    await session.drain(
      messages,
      () => saveAgentHistory('p', 't', messages),
      () => {},
      prepare,
    )
    assert.deepEqual(await delivery, { state: 'applied' })
    closeThreadStoreIndexes()
    assert.deepEqual((await getProjectThread('p', 't'))?.pendingMessages, [])
    await updateMeta('p', 't', { pendingMessages: stale })
    assert.deepEqual((await getProjectThread('p', 't'))?.pendingMessages, [])
    assert.deepEqual(await loadAgentHistory('p', 't'), [{ role: 'user', content: 'Note detached' }])
  })

  it('drops a persisted run nonce when loading metadata for a later run', async () => {
    const meta = await getThreadMeta('p', 't')
    assert.ok(meta)
    writeFileSync(
      join(root, 'p', 't', 'meta.json'),
      JSON.stringify({ ...meta, nativeSteeringRunId: 'old-run' }),
    )
    closeThreadStoreIndexes()
    assert.equal((await getThreadMeta('p', 't'))?.nativeSteeringRunId, undefined)
    assert.equal((await getProjectThread('p', 't'))?.nativeSteeringRunId, undefined)
  })

  it('does not acknowledge application when the awaited checkpoint fails', async () => {
    await queue('disk')
    const delivery = assert.rejects(session.enqueue('disk'), /Disk full/)
    const messages: LLMMessage[] = []
    await assert.rejects(
      session.drain(
        messages,
        async () => {
          throw new Error('Disk full')
        },
        () => assert.fail(),
        prepare,
      ),
      /Disk full/,
    )
    await delivery
    assert.deepEqual(messages, [])
    assert.deepEqual(
      (await loadUserSteeringReceipts('p', 't')).map((r) => r.state),
      ['accepted'],
    )
  })

  it('keeps a completed receipt through full saves and deduplicates after restart', async () => {
    await queue('saved')
    const delivery = session.enqueue('saved')
    const messages: LLMMessage[] = []
    await session.drain(
      messages,
      () => saveAgentHistory('p', 't', messages),
      () => {},
      prepare,
    )
    await delivery
    await session.close()
    const meta = await getThreadMeta('p', 't')
    assert.ok(meta)
    await saveProjectThread('p', { ...meta, messages: [] })
    closeThreadStoreIndexes()
    session = new NativeSteeringSession('p', 't', 'new-epoch', new AbortController().signal)
    assert.deepEqual(await session.enqueue('saved'), { state: 'applied' })
    await session.drain(
      [],
      async () => assert.fail('No replay'),
      () => assert.fail(),
      prepare,
    )
    assert.deepEqual(await loadAgentHistory('p', 't'), [{ role: 'user', content: 'Note saved' }])
    assert.equal((await loadUserSteeringReceipts('p', 't')).length, 2)
  })

  it('fails closed on a truncated receipt instead of silently replaying', async () => {
    await queue('bad')
    appendFileSync(join(root, 'p', 't', 'user-steering.jsonl'), '{truncated')
    await assert.rejects(session.enqueue('bad'), /delivery receipts/)
  })

  it('saves ordinary metadata past a torn receipt while admission stays strict', async () => {
    await queue('delivered')
    const stale = (await getThreadMeta('p', 't'))?.pendingMessages
    assert.ok(stale)
    const delivery = session.enqueue('delivered')
    const messages: LLMMessage[] = []
    await session.drain(
      messages,
      () => saveAgentHistory('p', 't', messages),
      () => {},
      prepare,
    )
    await delivery
    appendFileSync(join(root, 'p', 't', 'user-steering.jsonl'), '{truncated')
    await updateMeta('p', 't', { pendingMessages: stale, title: 'Still writable' })
    assert.equal((await getThreadMeta('p', 't'))?.title, 'Still writable')
    assert.deepEqual((await getThreadMeta('p', 't'))?.pendingMessages, [])
    await queue('held')
    await updateMeta('p', 't', { title: 'Held note survives' })
    assert.equal((await getThreadMeta('p', 't'))?.pendingMessages?.[0]?.messageId, 'held')
    await assert.rejects(session.enqueue('held'), /delivery receipts/)
  })

  it('does not treat an unreadable receipt file as an empty delivery history', async () => {
    mkdirSync(join(root, 'p', 't', 'user-steering.jsonl'))
    await assert.rejects(loadUserSteeringReceipts('p', 't'), /EISDIR/)
  })

  it('does not force another model step when a text-only response finishes with a pending note', async () => {
    await queue('late')
    let delivery: Promise<{ state: 'applied' | 'held' }> | undefined
    let calls = 0
    const messages: LLMMessage[] = [{ role: 'user', content: 'Finish' }]
    await runAgentLoop({
      provider: {
        async *stream(): AsyncGenerator<ProviderStreamChunk> {
          calls++
          delivery = session.enqueue('late')
          yield { type: 'text', text: 'Finished.' }
          yield { type: 'done' }
        },
      },
      messages,
      tools: [],
      onChunk: () => {},
      executeTool: async () => '',
      beforeStep: () =>
        session.drain(
          messages,
          async () => assert.fail('No later boundary'),
          () => assert.fail(),
          prepare,
        ),
    })
    await session.close()
    assert.deepEqual(await delivery, { state: 'held' })
    assert.equal(calls, 1)
  })

  it('retains saved insertion when Stop arrives during the awaited checkpoint', async () => {
    await queue('saving')
    const delivery = session.enqueue('saving')
    const messages: LLMMessage[] = []
    let requests = 0
    let attempts = 0
    await runAgentLoop({
      messages,
      tools: [],
      signal: controller.signal,
      provider: {
        async *stream(): AsyncGenerator<ProviderStreamChunk> {
          requests++
          yield { type: 'done' }
        },
      },
      onLlmCall: () => {
        attempts++
      },
      executeTool: async () => assert.fail('No tool after Stop'),
      onChunk: () => {},
      beforeStep: () =>
        session.drain(
          messages,
          async () => {
            await saveAgentHistory('p', 't', messages)
            controller.abort()
          },
          () => {},
          prepare,
        ),
    })
    assert.deepEqual(await delivery, { state: 'applied' })
    assert.deepEqual(await loadAgentHistory('p', 't'), [{ role: 'user', content: 'Note saving' }])
    assert.equal((await loadUserSteeringReceipts('p', 't')).at(-1)?.state, 'applied')
    assert.equal(requests, 0)
    assert.equal(attempts, 0)
  })

  it('never retries a crash-ambiguous accepted note in a replacement run', async () => {
    await queue('uncertain')
    const attempted = assert.rejects(session.enqueue('uncertain'), /checkpoint failed/)
    await assert.rejects(
      session.drain(
        [],
        async () => {
          throw new Error('checkpoint failed')
        },
        () => assert.fail(),
        prepare,
      ),
    )
    await attempted
    await session.close()
    session = new NativeSteeringSession('p', 't', 'new-epoch', new AbortController().signal)
    await assert.rejects(session.enqueue('uncertain'), /earlier delivery attempt/)
  })

  it('bounds admissions independently of step and continuation allowances', async () => {
    const pending: Promise<{ state: 'applied' | 'held' }>[] = []
    for (let i = 0; i < 16; i++) {
      const id = String(i)
      await queue(id)
      pending.push(session.enqueue(id))
    }
    await queue('overflow')
    await assert.rejects(session.enqueue('overflow'), /16-note steering limit/)
    await session.close()
    assert.ok((await Promise.all(pending)).every((result) => result.state === 'held'))
    assert.equal((await getThreadMeta('p', 't'))?.continuationUsed, 5)
  })
})
