import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { AnthropicProvider } from '@copse/llm/anthropic-provider.ts'
import { DEFAULT_CLOUD_MODEL } from '@copse/llm/model-catalog.ts'
import type { LLMMessage, LLMProvider } from '@shared/types'
import { safeJsonParse, decodeWithSchema } from '@shared/safe-json.ts'
import { storageReadFile, storageWriteFile, storageRemoveFile } from '../storage/user-data-files.ts'
import {
  createAutomationBudget,
  withAutomationBudget,
  guardAutomationProvider,
  assertAutomationBudgetModel,
  rejectExternalAutomationBudget,
} from './automation-budget.ts'

const MODEL = 'claude-haiku-4-5'
const PROJECT = 'budget-tests'

function fixture(
  failFirst = false,
  opts: {
    model?: string
    maxOutputTokens?: number
    events?: readonly unknown[]
    beforeResponse?: () => Promise<void>
    afterEvents?: () => void
  } = {},
): {
  provider: LLMProvider
  calls: () => number
  retries: unknown[]
} {
  let calls = 0
  const retries: unknown[] = []
  const model = opts.model ?? MODEL
  const params = opts.maxOutputTokens === undefined ? {} : { maxOutputTokens: opts.maxOutputTokens }
  const inner = new AnthropicProvider(model, { apiKey: 'test', params })
  Object.defineProperty(inner, 'client', {
    value: {
      messages: {
        stream: (_body: unknown, options: { maxRetries?: number }): AsyncIterable<unknown> => {
          calls++
          retries.push(options.maxRetries)
          const fail = failFirst && calls === 1
          return (async function* (): AsyncGenerator {
            await opts.beforeResponse?.()
            if (fail)
              throw new Anthropic.InternalServerError(
                503,
                {},
                'unavailable',
                new Headers({ 'retry-after-ms': '0' }),
              )
            for (const event of opts.events ?? [{ type: 'message_stop' }]) yield event
            opts.afterEvents?.()
          })()
        },
      },
    },
  })
  const provider = guardAutomationProvider(inner, { kind: 'anthropic', model, params })
  return { provider, calls: (): number => calls, retries }
}

async function drain(
  provider: LLMProvider,
  signal?: AbortSignal,
  messages: LLMMessage[] = [{ role: 'user', content: 'hello' }],
): Promise<void> {
  for await (const _chunk of provider.stream(messages, [], signal)) {
    /* drain */
  }
}

function completedEvents(input = 100, output = 50): unknown[] {
  return [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: input,
          output_tokens: 0,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
        },
      },
    },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: output } },
    { type: 'message_stop' },
  ]
}

async function reserved(id: string): Promise<number> {
  const text = await storageReadFile(`automation-budgets/${PROJECT}/${id}.json`)
  assert.ok(text)
  const parsed = safeJsonParse(text, decodeWithSchema(z.object({ reservedMicroUsd: z.number() })))
  assert.ok(parsed)
  return parsed.reservedMicroUsd
}

describe('automation model allowance', () => {
  it('reserves before the first attempt and never sends an unaffordable request', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.01)
    const f = fixture()
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /allowance exhausted/,
    )
    assert.equal(f.calls(), 0)
  })

  it('reserves a small text request and remembers it in a fresh scope', async () => {
    const id = randomUUID()
    // Small text fits with 64K output reserved; a second incomplete attempt does not.
    await createAutomationBudget(PROJECT, id, 0.34)
    const f = fixture()
    await withAutomationBudget(PROJECT, id, () => drain(f.provider))
    assert.deepEqual(f.retries, [0], 'SDK retries must not bypass admission')
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /allowance exhausted/,
    )
    assert.equal(f.calls(), 1, 'missing usage must not refund the reservation')
    await assert.rejects(createAutomationBudget(PROJECT, id, 100), /already exists/)
  })

  it('serializes parallel helper reservations against one allowance', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.34)
    const f = fixture()
    const outcomes = await withAutomationBudget(PROJECT, id, () =>
      Promise.allSettled([drain(f.provider), drain(f.provider), drain(f.provider)]),
    )
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(f.calls(), 1)
  })

  it('charges retries separately and retains the failed attempt', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.34)
    const f = fixture(true)
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /allowance exhausted/,
    )
    assert.equal(f.calls(), 1)
    const enough = randomUUID()
    await createAutomationBudget(PROJECT, enough, 0.68)
    const retry = fixture(true)
    await withAutomationBudget(PROJECT, enough, () => drain(retry.provider))
    assert.equal(retry.calls(), 2)
    assert.deepEqual(retry.retries, [0, 0])
  })

  it('does not reserve or send an already cancelled request', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.34)
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider, controller.signal)),
      /abort/i,
    )
    await withAutomationBudget(PROJECT, id, () => drain(f.provider))
    assert.equal(f.calls(), 1)
  })

  it('supports twenty default-model requests under a modest allowance after completed usage settles', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 10)
    const f = fixture(false, { model: DEFAULT_CLOUD_MODEL, events: completedEvents(2500, 500) })
    const messages: LLMMessage[] = [
      { role: 'system', content: 'Project instructions. '.repeat(500) },
      { role: 'user', content: 'Inspect and improve this project.' },
    ]
    for (let turn = 0; turn < 20; turn++) {
      // Fresh ownership scopes also prove the settled total is durable.
      await withAutomationBudget(PROJECT, id, () => drain(f.provider, undefined, messages))
      messages.push(
        {
          role: 'assistant',
          content: [
            {
              id: `tool-${String(turn)}`,
              name: 'read_file',
              args: { path: `file-${String(turn)}.ts` },
            },
          ],
        },
        {
          role: 'tool',
          toolResults: [
            { toolCallId: `tool-${String(turn)}`, result: 'Source file output. '.repeat(100) },
          ],
        },
      )
    }
    assert.equal(f.calls(), 20)
    assert.ok(
      (await reserved(id)) < 1_000_000,
      'completed requests retain their small catalogue cost',
    )
  })

  it('settles cache usage exactly and uses the actual output cap', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.02)
    let admitted = 0
    const f = fixture(false, {
      maxOutputTokens: 1000,
      events: completedEvents(),
      beforeResponse: async () => {
        admitted = await reserved(id)
      },
    })
    await withAutomationBudget(PROJECT, id, () => drain(f.provider))
    assert.ok(admitted > 5000 && admitted < 20_000, 'reservation is durable before any response')
    // Haiku: 100 fresh + 200 cache-write * 1.25 + 300 cache-read * 0.1 + 50 output * 5.
    assert.equal(await reserved(id), 630)
  })

  it('settles parallel completed requests without releasing another attempt’s reservation', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 1)
    const f = fixture(false, { events: completedEvents() })
    await withAutomationBudget(PROJECT, id, () =>
      Promise.all([drain(f.provider), drain(f.provider)]),
    )
    assert.equal(await reserved(id), 1260)
  })

  for (const [name, events] of [
    ['missing final usage', completedEvents().filter((_, i) => i !== 1)],
    ['missing stop', completedEvents().slice(0, 2)],
    ['invalid usage', completedEvents(-1)],
  ] as const) {
    it(`retains the reservation for ${name}`, async () => {
      const id = randomUUID()
      await createAutomationBudget(PROJECT, id, 0.34)
      const f = fixture(false, { events })
      await withAutomationBudget(PROJECT, id, () => drain(f.provider))
      assert.ok((await reserved(id)) > 320_000)
      await assert.rejects(
        withAutomationBudget(PROJECT, id, () => drain(f.provider)),
        /allowance exhausted/,
      )
      assert.equal(f.calls(), 1)
    })
  }

  it('retains a completed-looking response when cancellation wins before settlement', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.34)
    const controller = new AbortController()
    const f = fixture(false, {
      events: completedEvents(),
      afterEvents: () => {
        controller.abort()
      },
    })
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider, controller.signal)),
      /abort/i,
    )
    assert.ok((await reserved(id)) > 320_000)
  })

  it('retains a failed attempt while settling the successful retry', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.68)
    const f = fixture(true, { events: completedEvents() })
    await withAutomationBudget(PROJECT, id, () => drain(f.provider))
    assert.equal(f.calls(), 2)
    assert.ok((await reserved(id)) > 320_000 && (await reserved(id)) < 340_000)
  })

  it('retains usage from a stream that fails after reporting final counts', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.34)
    const f = fixture(false, {
      events: completedEvents(),
      afterEvents: () => {
        throw new Error('Stream failed after usage')
      },
    })
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /Stream failed after usage/,
    )
    assert.ok((await reserved(id)) > 320_000)
  })

  it('closes the allowance if provider usage exceeds the reserved bound', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 10)
    const f = fixture(false, { events: completedEvents(1_000_000) })
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /exceeded its reservation/,
    )
    assert.equal(await reserved(id), 10_000_000)
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /allowance exhausted/,
    )
    assert.equal(f.calls(), 1)
  })

  it('does not reopen a closed allowance when another in-flight request completes', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 10)
    const waiting = Promise.withResolvers<undefined>()
    const admitted = Promise.withResolvers<undefined>()
    const ordinary = fixture(false, {
      events: completedEvents(),
      beforeResponse: async () => {
        admitted.resolve(undefined)
        await waiting.promise
      },
    })
    const excessive = fixture(false, { events: completedEvents(1_000_000) })
    const pending = withAutomationBudget(PROJECT, id, () => drain(ordinary.provider))
    await admitted.promise
    try {
      await assert.rejects(
        withAutomationBudget(PROJECT, id, () => drain(excessive.provider)),
        /exceeded its reservation/,
      )
    } finally {
      waiting.resolve(undefined)
    }
    await pending
    assert.equal(await reserved(id), 10_000_000)
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(ordinary.provider)),
      /allowance exhausted/,
    )
  })

  for (const messages of [
    [{ role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,AA==' }] }],
    [
      {
        role: 'tool',
        toolResults: [
          {
            toolCallId: 'image',
            result: 'image',
            images: [{ dataUrl: 'data:image/png;base64,AA==' }],
          },
        ],
      },
    ],
  ] satisfies LLMMessage[][]) {
    it('reserves the full window for opaque user and tool-result image content', async () => {
      const id = randomUUID()
      await createAutomationBudget(PROJECT, id, 0.34)
      const f = fixture()
      await assert.rejects(
        withAutomationBudget(PROJECT, id, () => drain(f.provider, undefined, messages)),
        /allowance exhausted/,
      )
      assert.equal(f.calls(), 0)
    })
  }

  it('fails closed for corrupt or disappearing durable records', async () => {
    const id = randomUUID()
    const path = `automation-budgets/${PROJECT}/${id}.json`
    await storageWriteFile(path, '{broken')
    const f = fixture()
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /unreadable/,
    )
    await storageRemoveFile(path)
    await createAutomationBudget(PROJECT, id, 1)
    await assert.rejects(
      withAutomationBudget(PROJECT, id, async () => {
        await storageRemoveFile(path)
        await drain(f.provider)
      }),
      /allowance is missing/,
    )
    assert.equal(f.calls(), 0)
  })

  it('refuses unknown pricing, other transports, detached threads and external runtimes', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 100)
    const f = fixture()
    await withAutomationBudget(PROJECT, id, async () => {
      for (const model of [
        'claude-unknown',
        'gpt-5',
        'acp:claude',
        'remote-agent:x',
        'plugin-model:x',
        'lmstudio:x',
      ]) {
        assert.throws(() => {
          assertAutomationBudgetModel(model)
        }, /not supported/)
      }
      const wrongTransport = guardAutomationProvider(f.provider, {
        kind: 'openai-compatible',
        model: MODEL,
        params: {},
      })
      await assert.rejects(drain(wrongTransport), /cannot enforce/)
      await assert.rejects(
        withAutomationBudget(PROJECT, 'child', async () => {}),
        /separate worker threads/,
      )
      await assert.rejects(rejectExternalAutomationBudget(PROJECT, 'child'), /native desktop/)
    })
    await assert.rejects(rejectExternalAutomationBudget(PROJECT, id), /native desktop/)
    assert.equal(f.calls(), 0)
  })

  it('keeps constructed providers bound after their async scope ends', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.01)
    const f = await withAutomationBudget(PROJECT, id, async () => fixture())
    await assert.rejects(drain(f.provider), /allowance exhausted/)
    assert.equal(f.calls(), 0)
  })

  it('leaves ordinary threads and their provider retries unchanged', async () => {
    const id = randomUUID()
    const f = fixture()
    await withAutomationBudget(PROJECT, id, () => drain(f.provider))
    assert.deepEqual(f.retries, [undefined])
    assert.equal(await storageReadFile(`automation-budgets/${PROJECT}/${id}.json`), null)
  })
})
