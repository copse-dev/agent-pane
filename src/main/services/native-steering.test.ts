import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { readFileSync, promises as fsPromises } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSpineEntries } from '@copse/thread-store/spine-schema.ts'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { LLMMessage, LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import type { QueuedUserMessage } from '@shared/types'
import {
  closeThreadStoreIndexes,
  saveProjectThread,
  appendMessage,
  appendHookRun,
  freezeQueuedUserMessage,
  acceptReviewedQueuedUserMessage,
  deleteQueuedMessage,
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
  type PreparedNativeSteeringNote,
  type NativeSteeringApproval,
} from './native-steering.ts'

const review = async (note: { text: string }): Promise<NativeSteeringApproval> => ({
  text: note.text,
  claim: () => true,
})

const prepare = async (text: string): Promise<PreparedNativeSteeringNote> => ({
  apply: () => [{ role: 'user', content: text }],
})

describe('native human steering boundary and durability', () => {
  let root: string
  let controller: AbortController
  let session: NativeSteeringSession
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'copse-steering-'))
    configureThreadStore({ workspaceRoot: () => root })
    controller = new AbortController()
    session = new NativeSteeringSession('p', 't', 'human-epoch', 'test-model', controller.signal)
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
    await appendMessage(
      'p',
      't',
      { id, role: 'user', content: `Note ${id}`, toolCalls: [], createdAt: 2 },
      { source: 'renderer' },
    )
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
    const delivery = session.enqueue('correction', review)
    assert.equal(session.enqueue('correction', review), delivery)
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
    const delivery = session.enqueue('stop', review)
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
    const one = session.enqueue('one', review)
    const two = session.enqueue('two', review)
    await session.close()
    assert.deepEqual(await Promise.all([one, two]), [{ state: 'held' }, { state: 'held' }])
    assert.deepEqual(await loadAgentHistory('p', 't'), [])
  })

  it('applies concurrent admissions in FIFO order with a checkpoint for each note', async () => {
    await queue('one')
    await queue('two')
    const one = session.enqueue('one', review)
    const two = session.enqueue('two', review)
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
        delivery = session.enqueue('capped', review)
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
      assert.throws(() => steerNativeParent('p', 't', 'note', 'old-run', review), /turn has ended/)
      assert.throws(
        () => steerNativeParent('other', 't', 'note', session.runId, review),
        /only during a native/,
      )
    } finally {
      unbind()
    }
    assert.throws(
      () => steerNativeParent('p', 't', 'note', session.runId, review),
      /only during a native/,
    )
  })

  it('rejects hook and unpersisted admission markers before recording acceptance', async () => {
    await queue('hook', { origin: { kind: 'hook', hookId: 'h', event: 'stop' } })
    await assert.rejects(session.enqueue('hook', review), /human-authored/)
    await queue('stale', { steeringRequested: 'old-run' })
    await assert.rejects(session.enqueue('stale', review), /human-authored/)
    assert.deepEqual(await loadUserSteeringReceipts('p', 't'), [])
  })

  it('runs the production preparation gate before sending only redacted steering to the provider', async () => {
    await queue('blocked')
    await queue('redacted')
    const blocked = assert.rejects(session.enqueue('blocked', review), /Hook blocked/)
    const delivered = session.enqueue('redacted', review)
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
    const delivery = session.enqueue('detached', review)
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
    const delivery = assert.rejects(session.enqueue('disk', review), /Disk full/)
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
    const delivery = session.enqueue('saved', review)
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
    await saveProjectThread('p', {
      ...meta,
      messages: (await getProjectThread('p', 't'))?.messages ?? [],
    })
    closeThreadStoreIndexes()
    session = new NativeSteeringSession(
      'p',
      't',
      'new-epoch',
      'test-model',
      new AbortController().signal,
    )
    assert.deepEqual(await session.enqueue('saved', review), { state: 'applied' })
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
    await assert.rejects(session.enqueue('bad', review), /delivery receipts/)
  })

  it('saves ordinary metadata past a torn receipt while admission stays strict', async () => {
    await queue('delivered')
    const stale = (await getThreadMeta('p', 't'))?.pendingMessages
    assert.ok(stale)
    const delivery = session.enqueue('delivered', review)
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
    await assert.rejects(session.enqueue('held', review), /delivery receipts/)
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
          delivery = session.enqueue('late', review)
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
    const delivery = session.enqueue('saving', review)
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
    const attempted = assert.rejects(session.enqueue('uncertain', review), /checkpoint failed/)
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
    session = new NativeSteeringSession(
      'p',
      't',
      'new-epoch',
      'test-model',
      new AbortController().signal,
    )
    await assert.rejects(session.enqueue('uncertain', review), /earlier delivery attempt/)
  })

  it('does not admit a denied protected review or trust a later renderer payload', async () => {
    await queue('denied')
    let reviews = 0
    const denied = session.enqueue('denied', async (note) => {
      reviews++
      assert.equal(note.text, 'Note denied')
      assert.equal(note.runId, session.runId)
      assert.match(note.revision, /^[a-f0-9]{64}$/)
      return null
    })
    const messages: LLMMessage[] = []
    await session.drain(
      messages,
      async () => assert.fail('No denied checkpoint'),
      () => assert.fail(),
      prepare,
    )
    assert.deepEqual(await denied, { state: 'held' })
    assert.equal(reviews, 1)
    assert.deepEqual(messages, [])
    assert.deepEqual(await loadUserSteeringReceipts('p', 't'), [])
    assert.equal((await getThreadMeta('p', 't'))?.pendingMessages?.[0]?.autoDispatch, false)
    await deleteQueuedMessage('p', 't', 'denied')
  })

  it('durably accepts the exact protected text before checkpoint and delivers once', async () => {
    await queue('reviewed')
    const delivery = session.enqueue('reviewed', async (): Promise<NativeSteeringApproval> => ({
      text: 'Protected correction',
      claim: () => true,
    }))
    const messages: LLMMessage[] = []
    let checkpoints = 0
    await session.drain(
      messages,
      async () => {
        checkpoints++
        assert.equal(
          (await getProjectThread('p', 't'))?.messages.find((m) => m.id === 'reviewed')?.content,
          'Protected correction',
        )
        await assert.rejects(deleteQueuedMessage('p', 't', 'reviewed'), /accepted/)
        await assert.rejects(
          appendMessage(
            'p',
            't',
            { id: 'reviewed', role: 'assistant', content: 'Forged', toolCalls: [], createdAt: 2 },
            { source: 'renderer' },
          ),
          /accepted/,
        )
        await saveAgentHistory('p', 't', messages)
      },
      () => {},
      prepare,
    )
    assert.deepEqual(await delivery, { state: 'applied' })
    assert.deepEqual(
      await session.enqueue('reviewed', async () => assert.fail('No second review')),
      { state: 'applied' },
    )
    await session.drain(
      messages,
      async () => assert.fail('No second checkpoint'),
      () => assert.fail(),
      prepare,
    )
    assert.equal(checkpoints, 1)
    assert.deepEqual(messages, [{ role: 'user', content: 'Protected correction' }])
  })

  for (const finish of ['stop', 'close'] as const) {
    it(`keeps the note unaccepted when ${finish} wins an open review`, async () => {
      await queue('late-review')
      const opened = Promise.withResolvers<undefined>()
      const response = Promise.withResolvers<NativeSteeringApproval>()
      const delivery = session.enqueue('late-review', async (note) => {
        note.signal.addEventListener(
          'abort',
          () => {
            response.resolve({
              text: 'Late approval',
              claim: () => assert.fail('No claim after Stop'),
            })
          },
          {
            once: true,
          },
        )
        opened.resolve(undefined)
        return response.promise
      })
      await opened.promise
      if (finish === 'stop') controller.abort()
      else await session.close()
      await session.drain(
        [],
        async () => assert.fail('No late checkpoint'),
        () => assert.fail(),
        prepare,
      )
      assert.deepEqual(await delivery, { state: 'held' })
      assert.deepEqual(await loadAgentHistory('p', 't'), [])
      await deleteQueuedMessage('p', 't', 'late-review')
    })
  }

  for (const mutation of ['retire', 'body', 'queue'] as const) {
    it(`rejects a frozen note after ${mutation} wins before acceptance`, async () => {
      await queue('changed')
      const ready = Promise.withResolvers<undefined>()
      const delivery = session.enqueue('changed', async (): Promise<NativeSteeringApproval> => {
        ready.resolve(undefined)
        return {
          text: 'Reviewed original',
          claim: () => assert.fail('No claim for changed revision'),
        }
      })
      await ready.promise
      // drain waits for admission and runs the ordinary blocking preparation gate.
      const messages: LLMMessage[] = []
      await session.drain(
        messages,
        async () => assert.fail('No changed checkpoint'),
        () => assert.fail(),
        async (text) => {
          if (mutation === 'retire') await deleteQueuedMessage('p', 't', 'changed')
          if (mutation === 'body')
            await appendMessage(
              'p',
              't',
              { id: 'changed', role: 'user', content: 'Forged body', toolCalls: [], createdAt: 2 },
              { source: 'renderer' },
            )
          if (mutation === 'queue')
            await updateMeta('p', 't', {
              pendingMessages: [
                {
                  messageId: 'changed',
                  payload: { content: 'Forged queue' },
                  createdAt: 2,
                  autoDispatch: false,
                  steeringRequested: session.runId,
                },
              ],
            })
          return {
            apply: (): LLMMessage[] => assert.fail(`No hook context after ${mutation}: ${text}`),
          }
        },
      )
      assert.deepEqual(await delivery, { state: 'held' })
      assert.deepEqual(messages, [])
      assert.deepEqual(await loadUserSteeringReceipts('p', 't'), [])
    })
  }

  it('preserves derived hook audit cards added during blocking preparation', async () => {
    await queue('audited')
    const delivery = session.enqueue('audited', review)
    const messages: LLMMessage[] = []
    await session.drain(
      messages,
      () => saveAgentHistory('p', 't', messages),
      () => {},
      async (text) => {
        await appendHookRun('p', 't', {
          v: 1,
          type: 'hook_run',
          id: 'audit',
          hookId: 'steering-submit',
          event: 'beforeSubmitPrompt',
          executor: 'command',
          startedAt: 3,
          durationMs: 1,
          exitCode: 0,
          parseOk: true,
          decision: {},
          stdout: { ref: 'blobs/audit.stdout.txt', sha256: 'x' },
          stderr: { ref: 'blobs/audit.stderr.txt', sha256: 'y' },
        })
        assert.equal(
          (await getProjectThread('p', 't'))?.messages.find((m) => m.id === 'audited')?.hookCards
            ?.length,
          1,
        )
        return prepare(text)
      },
    )
    assert.deepEqual(await delivery, { state: 'applied' })
    const note = (await getProjectThread('p', 't'))?.messages.find((m) => m.id === 'audited')
    assert.equal(note?.content, 'Note audited')
    assert.equal(note.hookCards?.length, 1)
    assert.deepEqual(await loadAgentHistory('p', 't'), [{ role: 'user', content: 'Note audited' }])
  })

  it('holds a note when its sender-bound append proof was revoked', async () => {
    await queue('revoked')
    const delivery = session.enqueue('revoked', async (): Promise<NativeSteeringApproval> => ({
      text: 'Reviewed',
      claim: () => false,
    }))
    await session.drain(
      [],
      async () => assert.fail('No revoked checkpoint'),
      () => assert.fail(),
      prepare,
    )
    assert.deepEqual(await delivery, { state: 'held' })
    assert.deepEqual(await loadUserSteeringReceipts('p', 't'), [])
    await deleteQueuedMessage('p', 't', 'revoked')
  })

  it('never treats forged queue metadata or an accepted identity as human authority', async () => {
    await updateMeta('p', 't', {
      pendingMessages: [
        {
          messageId: 'forged',
          payload: { content: 'Injected' },
          createdAt: 2,
          autoDispatch: false,
          steeringRequested: session.runId,
        },
      ],
    })
    await assert.rejects(
      session.enqueue('forged', async () => assert.fail('No review for nonexistent identity')),
      /unaccepted queued/,
    )
    await appendMessage('p', 't', {
      id: 'forged',
      role: 'user',
      content: 'Injected',
      toolCalls: [],
      createdAt: 2,
    })
    await assert.rejects(freezeQueuedUserMessage('p', 't', 'forged'), /unaccepted queued/)
    assert.deepEqual(await loadUserSteeringReceipts('p', 't'), [])
  })

  for (const fault of ['authority read', 'acceptance write', 'delivery receipt'] as const) {
    it(`stops before the provider when the actual ${fault} fails`, async () => {
      await queue('io-failure')
      const delivery = assert.rejects(
        session.enqueue('io-failure', async (): Promise<NativeSteeringApproval> => ({
          text: 'Reviewed IO correction',
          claim: () => true,
        })),
        /simulated steering IO failure/,
      )
      const messages: LLMMessage[] = []
      const events = join(root, 'p', 't', 'events.jsonl')
      const originalSpine = readFileSync(events, 'utf8')
      const originalBody = readFileSync(join(root, 'p', 't', 'messages', 'io-failure.md'), 'utf8')
      const receiptsPath = join(root, 'p', 't', 'user-steering.jsonl')
      const realOpen = fsPromises.open
      const realRename = fsPromises.rename
      let restore = (): void => {}
      let attempts = 0
      try {
        await assert.rejects(
          runAgentLoop({
            messages,
            tools: [],
            signal: controller.signal,
            provider: {
              async *stream(): AsyncGenerator<ProviderStreamChunk> {
                yield assert.fail('No provider request from uncertain acceptance')
              },
            },
            executeTool: async () => assert.fail('No tool'),
            onChunk: () => {},
            beforeStep: () =>
              session.drain(
                messages,
                async () => assert.fail('No uncertain checkpoint'),
                () => assert.fail(),
                async (text) => {
                  closeThreadStoreIndexes()
                  if (fault === 'acceptance write') {
                    const stub = mock.method(
                      fsPromises,
                      'rename',
                      async (
                        ...args: Parameters<typeof realRename>
                      ): ReturnType<typeof realRename> => {
                        if (String(args[1]) === events) {
                          attempts++
                          throw new Error('simulated steering IO failure')
                        }
                        return realRename(...args)
                      },
                    )
                    restore = (): void => {
                      stub.mock.restore()
                    }
                  } else {
                    const path = fault === 'authority read' ? events : receiptsPath
                    const stub = mock.method(
                      fsPromises,
                      'open',
                      async (...args: Parameters<typeof realOpen>): ReturnType<typeof realOpen> => {
                        if (String(args[0]) === path) {
                          attempts++
                          throw new Error('simulated steering IO failure')
                        }
                        return realOpen(...args)
                      },
                    )
                    restore = (): void => {
                      stub.mock.restore()
                    }
                  }
                  return prepare(text)
                },
              ),
          }),
          /simulated steering IO failure/,
        )
        await delivery
      } finally {
        restore()
      }
      assert.ok(attempts > 0, 'exercise the real filesystem boundary')
      assert.deepEqual(messages, [])
      assert.deepEqual(await loadAgentHistory('p', 't'), [])
      const accepted = parseSpineEntries(readFileSync(events, 'utf8')).some(
        (entry) =>
          entry.line?.type === 'user_message_lifecycle' &&
          entry.line.id === 'io-failure' &&
          entry.line.state === 'accepted',
      )
      assert.equal(accepted, fault === 'delivery receipt')
      if (fault !== 'delivery receipt') {
        closeThreadStoreIndexes()
        const reloaded = await getProjectThread('p', 't')
        assert.deepEqual(
          {
            spine: readFileSync(events, 'utf8'),
            body: readFileSync(join(root, 'p', 't', 'messages', 'io-failure.md'), 'utf8'),
            loaded: reloaded !== null,
            content: reloaded?.messages.find((message) => message.id === 'io-failure')?.content,
          },
          { spine: originalSpine, body: originalBody, loaded: true, content: 'Note io-failure' },
        )
      }
      assert.equal((await getThreadMeta('p', 't'))?.pendingMessages?.[0]?.autoDispatch, false)
    })
  }

  it('preserves original body and spine when Stop wins after the real edited-body write', async () => {
    await queue('body-stop')
    const events = join(root, 'p', 't', 'events.jsonl')
    const body = join(root, 'p', 't', 'messages', 'body-stop.md')
    const originalSpine = readFileSync(events, 'utf8')
    const originalBody = readFileSync(body, 'utf8')
    const delivery = session.enqueue('body-stop', async (): Promise<NativeSteeringApproval> => ({
      text: 'Edited protected body',
      claim: () => true,
    }))
    const realRename = fsPromises.rename
    let bodyWrites = 0
    let restore = (): void => {}
    const messages: LLMMessage[] = []
    try {
      await runAgentLoop({
        messages,
        tools: [],
        signal: controller.signal,
        provider: {
          async *stream(): AsyncGenerator<ProviderStreamChunk> {
            yield assert.fail('No provider after Stop')
          },
        },
        executeTool: async () => assert.fail(),
        onChunk: () => {},
        beforeStep: () =>
          session.drain(
            messages,
            async () => assert.fail('No stopped checkpoint'),
            () => assert.fail(),
            async (text) => {
              const stub = mock.method(
                fsPromises,
                'rename',
                async (...args: Parameters<typeof realRename>): ReturnType<typeof realRename> => {
                  await realRename(...args)
                  if (
                    String(args[1]).startsWith(join(root, 'p', 't', 'messages') + '/') &&
                    bodyWrites++ === 0
                  )
                    controller.abort()
                },
              )
              restore = (): void => {
                stub.mock.restore()
              }
              return prepare(text)
            },
          ),
      })
      assert.deepEqual(await delivery, { state: 'held' })
    } finally {
      restore()
    }
    assert.ok(bodyWrites > 0, 'Stop after the real body-file rename')
    closeThreadStoreIndexes()
    const reloaded = await getProjectThread('p', 't')
    assert.deepEqual(
      {
        spine: readFileSync(events, 'utf8'),
        body: readFileSync(body, 'utf8'),
        loaded: reloaded !== null,
        content: reloaded?.messages.find((m) => m.id === 'body-stop')?.content,
      },
      { spine: originalSpine, body: originalBody, loaded: true, content: 'Note body-stop' },
    )
    assert.deepEqual(messages, [])
    assert.equal(reloaded?.pendingMessages?.[0]?.autoDispatch, false)
  })

  it('never turns a retired frozen identity into a fresh accepted ID', async () => {
    await queue('retired')
    const snapshot = await freezeQueuedUserMessage('p', 't', 'retired')
    await deleteQueuedMessage('p', 't', 'retired')
    assert.equal(
      await acceptReviewedQueuedUserMessage(
        'p',
        't',
        snapshot,
        'Late',
        () => true,
        () => assert.fail('No retired claim'),
      ),
      false,
    )
    assert.deepEqual((await getProjectThread('p', 't'))?.messages, [])
  })

  it('bounds admissions independently of step and continuation allowances', async () => {
    const pending: Promise<{ state: 'applied' | 'held' }>[] = []
    for (let i = 0; i < 16; i++) {
      const id = String(i)
      await queue(id)
      pending.push(session.enqueue(id, review))
    }
    await queue('overflow')
    await assert.rejects(session.enqueue('overflow', review), /16-note steering limit/)
    await session.close()
    assert.ok((await Promise.all(pending)).every((result) => result.state === 'held'))
    assert.equal((await getThreadMeta('p', 't'))?.continuationUsed, 5)
  })
})
