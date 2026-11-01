import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import { createThread, getProjectThread } from '../thread-store.ts'
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

  for (const messageId of [undefined, 'msg-1']) {
    it(`persists an ACP link across tools with ${messageId ?? 'no message id'}`, async () => {
      const threadId = 'continued-link'
      await createThread(PROJECT_ID, thread(threadId))
      const run = createHeadlessAutomationRun(PROJECT_ID, threadId)
      const emitText = (text: string): void =>
        run.host.emit(threadId, {
          type: 'acp_content',
          channel: 'message',
          content: { type: 'text', text },
          ...(messageId === undefined ? {} : { messageId }),
        })
      emitText('[Review](https://')
      run.host.emit(threadId, {
        type: 'tool_call',
        toolCall: { id: 'read', name: 'read_file', args: {} },
      })
      run.host.emit(threadId, {
        type: 'tool_result',
        toolCallId: 'read',
        result: 'done',
        isError: false,
      })
      emitText('example.com)')
      emitText(' ')
      emitText('completed.')
      run.host.emit(threadId, { type: 'done' })
      await run.flush()
      const persisted = await getProjectThread(PROJECT_ID, threadId)
      assert.deepEqual(
        persisted?.messages.map((message) => message.content),
        ['[Review](https://example.com) completed.'],
      )
      assert.equal(persisted?.messages[0]?.toolCalls[0]?.status, 'done')
    })
  }

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
