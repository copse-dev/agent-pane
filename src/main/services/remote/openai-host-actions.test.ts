import { ghCreatePrTool } from '../../tools/gh-pr-action-tools.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  handleOpenAiHostCall,
  finishOpenAiHostActions,
  openAiHostActionsSchema,
} from './openai-host-actions.ts'
import type { OpenAiHostTools } from './openai-host-tools.ts'
import type { OpenAiFunctionCall, OpenAiFunctionResult } from './openai-agents-api.ts'
import type { StreamChunk } from '@shared/types'

function fixture(): {
  context: Parameters<typeof handleOpenAiHostCall>[1] & { tools: OpenAiHostTools }
  call: OpenAiFunctionCall & { arguments: { title: string; body: string; draft: boolean } }
  chunks: StreamChunk[]
  writes: string[]
  executions: () => number
} {
  const actions = openAiHostActionsSchema.parse([])
  const chunks: StreamChunk[] = []
  const writes: string[] = []
  let executions = 0
  const tools: OpenAiHostTools = {
    definitions: ['gh_pr_create', 'gh_pr_list', 'gh_push', 'gh_pr_mark_ready'].map((name) => ({
      type: 'function',
      name,
      description: name,
      parameters: {},
    })),
    validate(name, args) {
      if (name === 'gh_pr_create') ghCreatePrTool.parameters.parse(args)
    },
    async execute() {
      executions++
      return { success: true, output: 'Done: https://github.com/example/repo/pull/1' }
    },
  }
  const context = {
    actions,
    tools,
    signal: new AbortController().signal,
    onChunk: (chunk: StreamChunk): void => {
      chunks.push(chunk)
    },
    save: async (): Promise<void> => {
      writes.push(JSON.stringify(actions))
    },
  }
  const call = {
    type: 'function_call' as const,
    turn_id: 'turn',
    call_id: 'call',
    name: 'gh_pr_create',
    arguments: { title: 'Title', body: 'Body', draft: true },
  }
  return { context, call, chunks, writes, executions: (): number => executions }
}

describe('OpenAI host action queue', () => {
  it('durably queues without publishing, then persists write intent and result, and never repeats a completed write', async () => {
    const f = fixture()
    const result = await handleOpenAiHostCall(f.call, f.context)
    assert.match(result.output ?? '', /No remote write has occurred/)
    assert.equal(f.executions(), 0)
    assert.equal(f.writes.length, 1)
    await handleOpenAiHostCall(f.call, f.context)
    assert.equal(f.context.actions.length, 1)
    await finishOpenAiHostActions(f.context)
    assert.equal(f.executions(), 1)
    assert.match(f.writes[1] ?? '', /executing/)
    assert.match(f.writes[2] ?? '', /done/)
    await finishOpenAiHostActions({
      ...f.context,
      actions: openAiHostActionsSchema.parse(structuredClone(f.context.actions)),
    })
    assert.equal(f.executions(), 1)
    assert.ok(f.chunks.some((chunk) => chunk.type === 'tool_result' && !chunk.isError))
  })
  it('rejects arbitrary tools, invalid arguments, changed arguments, and additional PRs', async () => {
    const f = fixture()
    assert.equal(
      (await handleOpenAiHostCall({ ...f.call, name: 'run_shell' }, f.context)).success,
      false,
    )
    assert.equal(
      (
        await handleOpenAiHostCall(
          { ...f.call, arguments: { ...f.call.arguments, title: 123 } },
          f.context,
        )
      ).success,
      false,
    )
    await handleOpenAiHostCall(f.call, f.context)
    assert.equal(
      (
        await handleOpenAiHostCall(
          { ...f.call, arguments: { ...f.call.arguments, title: 'Other' } },
          f.context,
        )
      ).success,
      false,
    )
    assert.equal(
      (await handleOpenAiHostCall({ ...f.call, call_id: 'other' }, f.context)).success,
      false,
    )
    assert.equal(f.executions(), 0)
  })
  it('does not retry an ambiguous write after restart', async () => {
    const f = fixture()
    await handleOpenAiHostCall(f.call, f.context)
    f.context.tools.execute = async (): Promise<OpenAiFunctionResult> => {
      throw new Error('connection lost')
    }
    await assert.rejects(finishOpenAiHostActions(f.context), /connection lost/)
    const restored = openAiHostActionsSchema.parse(f.context.actions)
    const text = await finishOpenAiHostActions({ ...f.context, actions: restored })
    assert.match(text, /outcome is uncertain/)
    assert.equal(restored[0]?.phase, 'done')
  })
  it('records denial and stops before a cancelled publish', async () => {
    const f = fixture()
    await handleOpenAiHostCall(f.call, f.context)
    await assert.rejects(finishOpenAiHostActions({ ...f.context, signal: AbortSignal.abort() }))
    assert.equal(f.executions(), 0)
    f.context.tools.execute = async (): Promise<OpenAiFunctionResult> => ({
      success: false,
      error: 'User rejected the gh_pr_create tool call.',
    })
    assert.match(await finishOpenAiHostActions(f.context), /User rejected/)
    assert.equal(f.context.actions[0]?.result?.success, false)
  })
  it('queues all writes in order and stops dependent actions after denial', async () => {
    const f = fixture()
    for (const name of ['gh_push', 'gh_pr_mark_ready']) {
      assert.equal(
        (await handleOpenAiHostCall({ ...f.call, name, call_id: name, arguments: {} }, f.context))
          .success,
        true,
      )
    }
    assert.equal(f.executions(), 0)
    const executed: string[] = []
    f.context.tools.execute = async (name): Promise<OpenAiFunctionResult> => {
      executed.push(name)
      return { success: false, error: 'User rejected push.' }
    }
    await finishOpenAiHostActions(f.context)
    assert.deepEqual(executed, ['gh_push'])
    assert.equal(f.context.actions[1]?.result?.success, false)
  })
  it('restores legacy PR queues and accepts the regular PR arguments', async () => {
    const f = fixture()
    const restored = openAiHostActionsSchema.parse([
      { turnId: 'old', callId: 'old', request: f.call.arguments, phase: 'queued' },
    ])
    assert.equal(restored[0]?.name, 'gh_pr_create')
    assert.equal(
      (
        await handleOpenAiHostCall(
          { ...f.call, arguments: { title: 'Title', base: 'main', head: 'feature' } },
          f.context,
        )
      ).success,
      true,
    )
    await finishOpenAiHostActions(f.context)
    assert.equal(f.executions(), 1)
  })
})
