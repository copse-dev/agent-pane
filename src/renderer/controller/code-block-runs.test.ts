import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { CodeBlockRunResult } from '@shared/store/events.ts'
import { getThreadById } from '@shared/store/thread-helpers.ts'
import type { Thread } from '@shared/types'
import { sendCodeBlockRunResult, type CodeBlockRunSendApi } from './code-block-runs.ts'

function runThread(status: Thread['status']): Thread {
  return {
    id: 'thread-1',
    title: 'Tests',
    status,
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '```sh\npnpm test\n```',
        toolCalls: [],
        createdAt: 1,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

function result(threadId = 'thread-1'): CodeBlockRunResult {
  return {
    id: 'run-1',
    projectId: 'project-1',
    threadId,
    exitCode: 1,
    output: 'FAIL',
    shell: {
      tabId: 'terminal-1',
      label: 'Run · pnpm test · exit 1',
      content: 'Command:\npnpm test\n\nExit code: 1\n\nTerminal output:\nFAIL',
    },
  }
}

function sendApi(): { api: CodeBlockRunSendApi; runs: string[] } {
  const runs: string[] = []
  return {
    runs,
    api: {
      agent: {
        run: async (_projectId, threadId): Promise<void> => {
          runs.push(threadId)
        },
      },
      git: {
        currentBranch: async () => 'main',
        promptState: async () => ({ startingCommit: 'a'.repeat(40), dirty: true }),
      },
    },
  }
}

function storeWith(thread: Thread): ReturnType<typeof createStore> {
  return createStore({
    projects: [{ id: 'project-1', name: 'Project', path: '/repo' }],
    activeProjectId: 'project-1',
    activeThreadId: thread.id,
    threads: [thread],
  })
}

test('a result for a busy thread queues behind the running turn', async () => {
  const store = storeWith(runThread('running'))
  const { api, runs } = sendApi()

  assert.equal(await sendCodeBlockRunResult(store, api, result()), true)

  assert.deepEqual(runs, [], 'nothing interrupts the running turn')
  const thread = getThreadById(store, 'thread-1')
  const sent = thread?.messages.at(-1)
  assert.equal(sent?.role, 'user')
  assert.equal(sent.startingCommit, 'a'.repeat(40))
  assert.equal(sent.dirty, true)
  const queued = thread?.pendingMessages ?? []
  const [item, ...rest] = queued
  assert.ok(item)
  assert.equal(rest.length, 0)
  assert.equal(item.messageId, sent.id)
  assert.match(JSON.stringify(item.payload.content), /Shell: Run · pnpm test · exit 1/)
})

test('a result for a thread that no longer exists is not sent', async () => {
  const store = storeWith(runThread('idle'))
  const { api, runs } = sendApi()

  assert.equal(await sendCodeBlockRunResult(store, api, result('deleted-thread')), false)

  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, 'thread-1')?.messages.length, 1)
})

test('a result is not sent when the checkout branch cannot be read', async () => {
  const store = storeWith({ ...runThread('idle'), gitBranch: 'feature' })
  const { api, runs } = sendApi()
  api.git.currentBranch = async (): Promise<string | null> => {
    throw new Error('git unavailable')
  }

  assert.equal(await sendCodeBlockRunResult(store, api, result()), false)

  assert.deepEqual(runs, [])
  assert.equal(getThreadById(store, 'thread-1')?.messages.length, 1)
})
