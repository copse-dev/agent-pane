import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { AnthropicProvider } from '@copse/llm/anthropic-provider.ts'
import type { LLMProvider } from '@shared/types'
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

function fixture(failFirst = false): {
  provider: LLMProvider
  calls: () => number
  retries: unknown[]
} {
  let calls = 0
  const retries: unknown[] = []
  const inner = new AnthropicProvider(MODEL, { apiKey: 'test' })
  Object.defineProperty(inner, 'client', {
    value: {
      messages: {
        stream: (
          _body: unknown,
          options: { maxRetries?: number },
        ): AsyncIterable<{ type: string }> => {
          calls++
          retries.push(options.maxRetries)
          const fail = failFirst && calls === 1
          return (async function* (): AsyncGenerator<{ type: string }> {
            if (fail)
              throw new Anthropic.InternalServerError(
                503,
                {},
                'unavailable',
                new Headers({ 'retry-after-ms': '0' }),
              )
            yield { type: 'message_stop' }
          })()
        },
      },
    },
  })
  const provider = guardAutomationProvider(inner, { kind: 'anthropic', model: MODEL, params: {} })
  return { provider, calls: (): number => calls, retries }
}

async function drain(provider: LLMProvider, signal?: AbortSignal): Promise<void> {
  for await (const _chunk of provider.stream([{ role: 'user', content: 'hello' }], [], signal)) {
    /* drain */
  }
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

  it('admits the exact maximum cost once and remembers it in a fresh scope', async () => {
    const id = randomUUID()
    // 200K input at a conservative $2/M + 64K output at $5/M.
    await createAutomationBudget(PROJECT, id, 0.72)
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
    await createAutomationBudget(PROJECT, id, 0.72)
    const f = fixture()
    const outcomes = await withAutomationBudget(PROJECT, id, () =>
      Promise.allSettled([drain(f.provider), drain(f.provider), drain(f.provider)]),
    )
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(f.calls(), 1)
  })

  it('charges retries separately and retains the failed attempt', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.72)
    const f = fixture(true)
    await assert.rejects(
      withAutomationBudget(PROJECT, id, () => drain(f.provider)),
      /allowance exhausted/,
    )
    assert.equal(f.calls(), 1)
    const enough = randomUUID()
    await createAutomationBudget(PROJECT, enough, 1.44)
    const retry = fixture(true)
    await withAutomationBudget(PROJECT, enough, () => drain(retry.provider))
    assert.equal(retry.calls(), 2)
    assert.deepEqual(retry.retries, [0, 0])
  })

  it('does not reserve or send an already cancelled request', async () => {
    const id = randomUUID()
    await createAutomationBudget(PROJECT, id, 0.72)
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
