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
})
