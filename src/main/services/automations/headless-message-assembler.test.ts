import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamChunk, Thread } from '@shared/types'
import { createThread, getProjectThread } from '../thread-store.ts'
import { createAcpToolCallTracker } from '../acp/acp-turn-recovery.ts'
import { recoverAgentHistory } from '../history-recovery.ts'
import { createHeadlessAutomationRun } from './headless-message-assembler.ts'

const PROJECT_ID = 'project-a'

function thread(id: string): Thread {
  return {
    id,
    title: 'Scheduled run',
    status: 'running',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('createHeadlessAutomationRun', () => {
  let root: string
  let previousRoot: string | undefined

  beforeEach(() => {
    previousRoot = process.env['COPSE_WORKSPACE_DIR']
    root = mkdtempSync(join(tmpdir(), 'copse-headless-automation-run-'))
    process.env['COPSE_WORKSPACE_DIR'] = root
  })

  afterEach(() => {
    if (previousRoot === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('persists the prompt as a user message, resolving only once it has settled', async () => {
    const threadId = 'thread-1'
    await createThread(PROJECT_ID, thread(threadId))
    const run = createHeadlessAutomationRun(PROJECT_ID, threadId)

    await run.appendUserMessage('Check project health.')

    const persisted = await getProjectThread(PROJECT_ID, threadId)
    assert.equal(persisted?.messages.length, 1)
    assert.equal(persisted.messages[0]?.role, 'user')
    assert.equal(persisted.messages[0].content, 'Check project health.')
  })

  it('persists an assistant message once a text chunk is finalized by done', async () => {
    const threadId = 'thread-2'
    await createThread(PROJECT_ID, thread(threadId))
    const run = createHeadlessAutomationRun(PROJECT_ID, threadId)

    run.host.emit(threadId, { type: 'text', text: 'All healthy.' })
    run.host.emit(threadId, { type: 'done' })
    await run.flush()

    const persisted = await getProjectThread(PROJECT_ID, threadId)
    assert.equal(persisted?.messages.length, 1)
    assert.equal(persisted.messages[0]?.role, 'assistant')
    assert.equal(persisted.messages[0].content, 'All healthy.')
  })

  it('marks a tool call done with its result once the matching tool_result arrives', async () => {
    const threadId = 'thread-3'
    await createThread(PROJECT_ID, thread(threadId))
    const run = createHeadlessAutomationRun(PROJECT_ID, threadId)

    run.host.emit(threadId, {
      type: 'tool_call',
      toolCall: { id: 'call-1', name: 'run_shell', args: { command: 'pnpm test' } },
    })
    run.host.emit(threadId, {
      type: 'tool_result',
      toolCallId: 'call-1',
      result: 'all tests passed',
      isError: false,
    })
    run.host.emit(threadId, { type: 'done' })
    await run.flush()

    const persisted = await getProjectThread(PROJECT_ID, threadId)
    const toolCall = persisted?.messages[0]?.toolCalls[0]
    assert.ok(toolCall)
    assert.equal(toolCall.status, 'done')
    assert.equal(toolCall.result, 'all tests passed')
  })

  it('keeps unfinished background tools out of terminal history while preserving earlier messages', async () => {
    const id = 'pending-background'
    await createThread(PROJECT_ID, {
      ...thread(id),
      currentEpoch: 'original-human-turn',
      continuationUsed: 2,
    })
    const run = createHeadlessAutomationRun(PROJECT_ID, id)
    run.host.emit(id, { type: 'text', text: 'The initial check is complete.' })
    run.host.emit(id, { type: 'done' })
    await run.flush()
    const spine = join(root, PROJECT_ID, id, 'events.jsonl')
    const before = readFileSync(spine)

    run.host.emit(id, { type: 'text', text: 'Background verification is running.' })
    run.host.emit(id, {
      type: 'tool_call',
      toolCall: { id: 'background', name: 'verification', args: { scope: 'build' } },
    })
    await run.flush()

    const pending = await getProjectThread(PROJECT_ID, id)
    assert.deepEqual(
      readFileSync(spine).subarray(0, before.length),
      before,
      'pending work cannot rewrite earlier settled history',
    )
    assert.equal(pending?.messages.length, 2)
    assert.equal(pending.messages[0]?.content, 'The initial check is complete.')
    assert.equal(pending.messages[1]?.content, 'Background verification is running.')
    assert.equal(pending.messages[1].toolCalls.length, 0)
    assert.equal(pending.currentEpoch, 'original-human-turn')
    assert.equal(pending.continuationUsed, 2)

    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'background',
      result: 'Verification passed.',
      isError: false,
    })
    await run.flush()
    const completed = await getProjectThread(PROJECT_ID, id)
    const calls = completed?.messages.flatMap((message) => message.toolCalls)
    assert.equal(completed?.messages.length, 2)
    assert.deepEqual(
      calls?.map(({ id, status, result }) => ({ id, status, result })),
      [{ id: 'background', status: 'done', result: 'Verification passed.' }],
    )
  })

  it('saves settled siblings while keeping unfinished calls transient and preserves late updates', async () => {
    const id = 'mixed-pending'
    await createThread(PROJECT_ID, thread(id))
    const run = createHeadlessAutomationRun(PROJECT_ID, id)
    for (const callId of ['first', 'second']) {
      run.host.emit(id, {
        type: 'tool_call',
        toolCall: { id: callId, name: 'verification', args: {} },
      })
    }
    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'first',
      result: 'First check passed.',
      isError: false,
    })
    await run.flush()
    const partial = await getProjectThread(PROJECT_ID, id)
    assert.equal(partial?.messages.length, 1)
    assert.deepEqual(
      partial.messages[0]?.toolCalls.map(({ id, status, result }) => ({ id, status, result })),
      [{ id: 'first', status: 'done', result: 'First check passed.' }],
    )

    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'second',
      result: 'Second check failed.',
      isError: true,
    })
    run.host.emit(id, { type: 'done' })
    await run.flush()
    const settled = await getProjectThread(PROJECT_ID, id)
    const messageId = settled?.messages[0]?.id
    assert.ok(messageId)
    assert.equal(messageId, partial.messages[0].id)
    assert.deepEqual(
      settled.messages[0]?.toolCalls.map((call) => call.status),
      ['done', 'error'],
    )

    for (let delivery = 0; delivery < 2; delivery++) {
      run.host.emit(id, {
        type: 'tool_call_update',
        toolCallId: 'first',
        status: 'done',
        args: { scope: 'build', revision: 'verified' },
        result: 'Final verification output.',
      })
      await run.flush()
    }
    const updated = await getProjectThread(PROJECT_ID, id)
    assert.equal(updated?.messages.length, 1)
    assert.equal(updated.messages[0]?.id, messageId)
    assert.equal(updated.messages[0].toolCalls.length, 2)
    assert.deepEqual(updated.messages[0].toolCalls[0]?.args, {
      scope: 'build',
      revision: 'verified',
    })
    assert.equal(updated.messages[0].toolCalls[0].result, 'Final verification output.')
    assert.equal(updated.messages[0].toolCalls[1]?.result, 'Second check failed.')
  })

  it('does not turn an unfinished call into success at done and still records its late failure', async () => {
    const id = 'stopped-pending'
    await createThread(PROJECT_ID, thread(id))
    const run = createHeadlessAutomationRun(PROJECT_ID, id)
    run.host.emit(id, {
      type: 'tool_call',
      toolCall: { id: 'unfinished', name: 'verification', args: {} },
    })
    run.host.emit(id, { type: 'done' })
    await run.flush()
    const pending = await getProjectThread(PROJECT_ID, id)
    assert.equal(pending?.messages.length, 1)
    assert.equal(pending.messages[0]?.content, '')
    assert.equal(pending.messages[0].toolCalls.length, 0)
    assert.deepEqual(
      recoverAgentHistory(pending.messages),
      [],
      'empty ordering stubs are not provider context',
    )

    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'unfinished',
      result: 'Verification was interrupted.',
      isError: true,
    })
    await run.flush()
    const failed = await getProjectThread(PROJECT_ID, id)
    assert.equal(failed?.messages.length, 1)
    assert.equal(failed.messages[0]?.id, pending.messages[0].id)
    assert.equal(failed.messages[0].toolCalls[0]?.status, 'error')
    assert.equal(failed.messages[0].toolCalls[0].result, 'Verification was interrupted.')
  })

  for (const later of ['text', 'tool'] as const) {
    it(`retains transcript order when a later ${later} bubble finishes before an earlier tool`, async () => {
      const id = `ordered-${later}`
      await createThread(PROJECT_ID, thread(id))
      const run = createHeadlessAutomationRun(PROJECT_ID, id)
      run.host.emit(id, { type: 'text', text: 'First inspection.' })
      run.host.emit(id, {
        type: 'tool_call',
        toolCall: { id: 'first', name: 'verification', args: {} },
      })
      run.host.emit(id, { type: 'text', text: 'Second inspection.' })
      if (later === 'tool') {
        run.host.emit(id, {
          type: 'tool_call',
          toolCall: { id: 'second', name: 'verification', args: {} },
        })
        run.host.emit(id, {
          type: 'tool_result',
          toolCallId: 'second',
          result: 'Second check passed.',
          isError: false,
        })
      }
      if (later === 'text') run.host.emit(id, { type: 'done' })
      await run.flush()
      const partial = await getProjectThread(PROJECT_ID, id)
      assert.deepEqual(
        partial?.messages.map((message) => message.content),
        ['First inspection.', 'Second inspection.'],
      )
      assert.equal(partial.messages[0]?.toolCalls.length, 0)
      assert.deepEqual(
        partial.messages[1]?.toolCalls.map((call) => call.id),
        later === 'tool' ? ['second'] : [],
      )

      run.host.emit(id, {
        type: 'tool_result',
        toolCallId: 'first',
        result: 'First check failed.',
        isError: true,
      })
      if (later === 'tool') run.host.emit(id, { type: 'done' })
      await run.flush()
      const saved = await getProjectThread(PROJECT_ID, id)
      assert.deepEqual(
        saved?.messages.map((message) => message.content),
        ['First inspection.', 'Second inspection.'],
      )
      assert.deepEqual(
        saved.messages.map((message) => message.id),
        partial.messages.map((message) => message.id),
      )
      assert.equal(saved.messages[0]?.toolCalls[0]?.status, 'error')
      assert.equal(saved.messages[0].toolCalls[0].result, 'First check failed.')
      if (later === 'tool')
        assert.equal(saved.messages[1]?.toolCalls[0]?.result, 'Second check passed.')
    })
  }

  it('persists a settled prefix without fabricating completion for a later unfinished bubble', async () => {
    const id = 'settled-prefix'
    await createThread(PROJECT_ID, thread(id))
    const run = createHeadlessAutomationRun(PROJECT_ID, id)
    for (const callId of ['first', 'second']) {
      run.host.emit(id, { type: 'text', text: `${callId} inspection.` })
      run.host.emit(id, {
        type: 'tool_call',
        toolCall: { id: callId, name: 'verification', args: {} },
      })
    }
    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'first',
      result: 'First check passed.',
      isError: false,
    })
    await run.flush()
    const partial = await getProjectThread(PROJECT_ID, id)
    assert.equal(partial?.messages.length, 2)
    assert.equal(partial.messages[0]?.toolCalls[0]?.id, 'first')
    assert.equal(partial.messages[0].toolCalls[0].result, 'First check passed.')
    assert.equal(partial.messages[1]?.toolCalls.length, 0)

    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'second',
      result: 'Second check passed.',
      isError: false,
    })
    await run.flush()
    const complete = await getProjectThread(PROJECT_ID, id)
    assert.deepEqual(
      complete?.messages.map((message) => message.content),
      ['first inspection.', 'second inspection.'],
    )
  })

  it('saves the later completed sibling before the earlier call settles in the same message', async () => {
    const id = 'later-sibling-first'
    await createThread(PROJECT_ID, thread(id))
    const run = createHeadlessAutomationRun(PROJECT_ID, id)
    for (const callId of ['first', 'second']) {
      run.host.emit(id, {
        type: 'tool_call',
        toolCall: { id: callId, name: 'verification', args: {} },
      })
    }
    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'second',
      result: 'Second check passed.',
      isError: false,
    })
    await run.flush()
    const partial = await getProjectThread(PROJECT_ID, id)
    assert.equal(partial?.messages.length, 1)
    assert.deepEqual(
      partial.messages[0]?.toolCalls.map(({ id, status, result }) => ({ id, status, result })),
      [{ id: 'second', status: 'done', result: 'Second check passed.' }],
    )

    run.host.emit(id, {
      type: 'tool_result',
      toolCallId: 'first',
      result: 'First check failed.',
      isError: true,
    })
    await run.flush()
    const settled = await getProjectThread(PROJECT_ID, id)
    assert.equal(settled?.messages[0]?.id, partial.messages[0].id)
    assert.deepEqual(
      settled.messages[0].toolCalls.map(({ id, status, result }) => ({ id, status, result })),
      [
        { id: 'first', status: 'error', result: 'First check failed.' },
        { id: 'second', status: 'done', result: 'Second check passed.' },
      ],
    )
  })

  for (const ending of ['crash-cut', 'cancel', 'parked-approval-cancel'] as const) {
    it(`retains a later completed result when an earlier call is unresolved at ${ending}`, async () => {
      const id = `completed-before-${ending}`
      await createThread(PROJECT_ID, {
        ...thread(id),
        currentEpoch: 'original-human-turn',
        continuationUsed: 2,
      })
      const run = createHeadlessAutomationRun(PROJECT_ID, id)
      const tracker = createAcpToolCallTracker()
      const emit = (chunk: StreamChunk): void => {
        if (tracker.observe(chunk)) run.host.emit(id, chunk)
      }
      await run.appendUserMessage('Verify both checks.')
      // A tool-only first bubble reserves its ID without inventing a result.
      emit({ type: 'tool_call', toolCall: { id: 'first', name: 'verification', args: {} } })
      await run.flush()
      emit({ type: 'text', text: 'Second inspection.' })
      emit({ type: 'tool_call', toolCall: { id: 'second', name: 'verification', args: {} } })
      emit({
        type: 'tool_result',
        toolCallId: 'second',
        result: 'Second check passed.',
        isError: false,
      })
      if (ending !== 'crash-cut') {
        // This is the real host tracker boundary: a parked approval stays open.
        const parked = new Set(ending === 'parked-approval-cancel' ? ['first'] : [])
        for (const chunk of tracker.settle(parked)) run.host.emit(id, chunk)
        emit({
          type: 'turn_outcome',
          outcome: {
            status: 'cancelled',
            stopReason: 'cancelled',
            source: 'user',
            executor: 'acp',
            provider: 'fixture',
            model: 'fixture',
            endedAt: 1,
          },
        })
        emit({ type: 'done' })
      }
      await run.flush()
      // No terminal event exists for the first call at the crash cut.
      const cold = await getProjectThread(PROJECT_ID, id)
      assert.ok(cold)
      const calls = cold.messages.flatMap((message) => message.toolCalls)
      assert.equal(calls.find((call) => call.id === 'second')?.result, 'Second check passed.')
      assert.equal(
        calls.some((call) => call.id === 'first' && call.status === 'done'),
        false,
      )
      assert.equal(cold.currentEpoch, 'original-human-turn')
      assert.equal(cold.continuationUsed, 2)
      assert.equal(cold.messages[1]?.content, '')
      const rebuilt = recoverAgentHistory(cold.messages)
      assert.equal(
        rebuilt.some((message) => message.role === 'assistant' && message.content === ''),
        false,
        'empty ordering placeholders cannot become provider messages',
      )
      if (ending === 'cancel') {
        assert.equal(calls.find((call) => call.id === 'first')?.status, 'error')
      } else {
        assert.equal(cold.messages[1].toolCalls.length, 0)
        emit({
          type: 'tool_result',
          toolCallId: 'first',
          result: 'First check passed.',
          isError: false,
        })
        await run.flush()
        const settled = await getProjectThread(PROJECT_ID, id)
        assert.deepEqual(
          settled?.messages.map((message) => message.id),
          cold.messages.map((message) => message.id),
        )
        assert.deepEqual(
          settled.messages.flatMap((message) => message.toolCalls.map((call) => call.id)),
          ['first', 'second'],
        )
      }
      if (ending !== 'crash-cut')
        assert.equal(cold.messages.at(-1)?.turnOutcome?.status, 'cancelled')
    })
  }

  it('persists ACP agent content: thoughts, message text and non-text blocks', async () => {
    const threadId = 'thread-4'
    await createThread(PROJECT_ID, thread(threadId))
    const run = createHeadlessAutomationRun(PROJECT_ID, threadId)

    run.host.emit(threadId, {
      type: 'acp_content',
      channel: 'thought',
      content: { type: 'text', text: 'Checking the build.' },
      messageId: 'thought-1',
    })
    run.host.emit(threadId, {
      type: 'acp_content',
      channel: 'message',
      content: { type: 'text', text: 'Build is green.' },
      messageId: 'msg-1',
    })
    run.host.emit(threadId, {
      type: 'acp_content',
      channel: 'message',
      content: { type: 'resource_link', uri: 'file:///tmp/report.md', name: 'report.md' },
      messageId: 'msg-1',
    })
    run.host.emit(threadId, {
      type: 'acp_content_replace',
      channel: 'thought',
      messageId: 'thought-1',
      content: [{ type: 'text', text: 'Build checks complete.' }],
    })
    run.host.emit(threadId, {
      type: 'acp_content_replace',
      channel: 'message',
      messageId: 'msg-1',
      content: [
        { type: 'text', text: 'Build remains green.' },
        { type: 'resource_link', uri: 'file:///tmp/final.md', name: 'final.md' },
      ],
    })
    run.host.emit(threadId, { type: 'done' })
    await run.flush()

    const persisted = await getProjectThread(PROJECT_ID, threadId)
    assert.equal(persisted?.messages.length, 1)
    const message = persisted.messages[0]
    assert.equal(message?.role, 'assistant')
    assert.equal(message.reasoning, 'Build checks complete.')
    assert.equal(message.content, 'Build remains green.')
    assert.deepEqual(message.contentBlocks, [
      { type: 'resource_link', uri: 'file:///tmp/final.md', name: 'final.md' },
    ])
  })

  it('persists a failed turn outcome even when the turn produced no text', async () => {
    const threadId = 'thread-6'
    await createThread(PROJECT_ID, thread(threadId))
    const run = createHeadlessAutomationRun(PROJECT_ID, threadId)

    run.host.emit(threadId, {
      type: 'turn_outcome',
      outcome: {
        status: 'failed',
        stopReason: 'error',
        source: 'provider',
        executor: 'local',
        provider: 'openai',
        model: 'gpt-5.4',
        error: { message: 'Provider unavailable', code: 503 },
        endedAt: 1,
      },
    })
    run.host.emit(threadId, { type: 'done' })
    await run.flush()

    const persisted = await getProjectThread(PROJECT_ID, threadId)
    assert.equal(persisted?.messages.length, 1)
    assert.equal(persisted.messages[0]?.role, 'assistant')
    assert.equal(persisted.messages[0].turnOutcome?.status, 'failed')
    assert.equal(run.failure()?.message, 'Provider unavailable')
  })

  it('starts a new assistant message when the ACP message id changes', async () => {
    const threadId = 'thread-5'
    await createThread(PROJECT_ID, thread(threadId))
    const run = createHeadlessAutomationRun(PROJECT_ID, threadId)

    for (const { messageId, text } of [
      { messageId: 'msg-1', text: 'First answer.' },
      { messageId: 'msg-2', text: 'Second answer.' },
    ]) {
      run.host.emit(threadId, {
        type: 'acp_content',
        channel: 'message',
        content: { type: 'text', text },
        messageId,
      })
    }
    run.host.emit(threadId, { type: 'done' })
    await run.flush()

    const persisted = await getProjectThread(PROJECT_ID, threadId)
    assert.deepEqual(
      persisted?.messages.map((m) => m.content),
      ['First answer.', 'Second answer.'],
    )
  })
})
