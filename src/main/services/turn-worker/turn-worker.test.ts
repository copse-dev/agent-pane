import assert from 'node:assert/strict'
import { chatGptPlanModelValue } from '@copse/llm/chatgpt-plan.ts'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  acquireWriterLease,
  releaseWriterLease,
  WRITER_LEASE_FILE,
  type WriterLeaseEnvironment,
} from '@copse/thread-store/writer-lease.ts'
import type { Thread } from '@shared/types'
import { ToolRegistry } from '../tool-registry.ts'
import {
  loadProjectThreadMetas,
  loadThreadMessages,
  saveProjectThread,
  threadDirectoryPath,
} from '../thread-store.ts'
import { readdir } from 'node:fs/promises'
import { runTurnWorker, TurnControl } from './turn-worker.ts'

const RESTART_NOTE = 'Copse restarted during this turn. Continuing where it stopped.'

let root = ''
const savedDir = process.env['COPSE_DIR']
const savedMock = process.env['COPSE_PANEL_MOCK_LLM']
before(() => {
  root = mkdtempSync(join(tmpdir(), 'turn-worker-'))
  process.env['COPSE_DIR'] = root
  process.env['COPSE_PANEL_MOCK_LLM'] = '1'
})
after(() => {
  if (savedDir === undefined) delete process.env['COPSE_DIR']
  else process.env['COPSE_DIR'] = savedDir
  if (savedMock === undefined) delete process.env['COPSE_PANEL_MOCK_LLM']
  else process.env['COPSE_PANEL_MOCK_LLM'] = savedMock
  rmSync(root, { recursive: true, force: true })
})

function cutOff(id: string, overrides: Partial<Thread> = {}): Thread {
  const at = Date.now() - 60_000
  return {
    id,
    title: 'Summarise the plan',
    status: 'running',
    model: 'claude-sonnet-4-6',
    messages: [
      {
        id: `${id}-prompt`,
        role: 'user',
        content: 'Summarise PLAN.md',
        toolCalls: [],
        createdAt: at,
      },
      {
        id: `${id}-partial`,
        role: 'assistant',
        content: 'The plan has three steps. First',
        toolCalls: [],
        createdAt: at + 1,
      },
    ],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: at,
    updatedAt: at + 1,
    ...overrides,
  }
}

/** Another process on this machine that still holds the thread. */
function app(): WriterLeaseEnvironment {
  return {
    owner: { id: 'quitting-app', host: hostname(), pid: process.ppid },
    now: Date.now,
    isAlive: () => true,
  }
}

const silent = (): void => undefined

describe('runTurnWorker', () => {
  it('continues a cut-off turn into the thread and lets the thread go', async () => {
    await saveProjectThread('p1', cutOff('t1'))
    const outcome = await runTurnWorker(
      { projectId: 'p1', threadId: 't1' },
      { registry: new ToolRegistry(), log: silent },
    )
    assert.deepEqual(outcome, { status: 'continued', result: 'completed' })
    const messages = await loadThreadMessages('p1', 't1')
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'user', 'assistant'],
    )
    assert.equal(messages[2]?.content, RESTART_NOTE)
    const meta = (await loadProjectThreadMetas('p1')).find((thread) => thread.id === 't1')
    assert.equal(meta?.status, 'idle')
    assert.equal(existsSync(join(threadDirectoryPath('p1', 't1'), WRITER_LEASE_FILE)), false)
  })

  it('waits for the quitting app to release the thread', async () => {
    await saveProjectThread('p1', cutOff('t2'))
    const dir = threadDirectoryPath('p1', 't2')
    const held = await acquireWriterLease(dir, 't2', app())
    assert.ok(held.status === 'acquired')
    const worker = runTurnWorker(
      { projectId: 'p1', threadId: 't2' },
      { registry: new ToolRegistry(), log: silent, handOffWaitMs: 30_000 },
    )
    await releaseWriterLease(dir, held.lease, app())
    assert.deepEqual(await worker, { status: 'continued', result: 'completed' })
  })

  it('leaves a thread another process keeps holding', async () => {
    await saveProjectThread('p1', cutOff('t3'))
    const dir = threadDirectoryPath('p1', 't3')
    assert.equal((await acquireWriterLease(dir, 't3', app())).status, 'acquired')
    const outcome = await runTurnWorker(
      { projectId: 'p1', threadId: 't3' },
      { registry: new ToolRegistry(), log: silent, handOffWaitMs: 0 },
    )
    assert.deepEqual(outcome, { status: 'held', holder: { host: hostname(), pid: process.ppid } })
    assert.equal((await loadThreadMessages('p1', 't3')).length, 2)
  })

  it('leaves a ChatGPT plan turn for the next launch', async () => {
    await saveProjectThread('p1', cutOff('t5', { model: chatGptPlanModelValue('codex', 'gpt-5') }))
    const outcome = await runTurnWorker(
      { projectId: 'p1', threadId: 't5' },
      { registry: new ToolRegistry(), log: silent },
    )
    assert.deepEqual(outcome, { status: 'not-resumable' })
    assert.equal(
      (await loadProjectThreadMetas('p1')).find((meta) => meta.id === 't5')?.status,
      'running',
    )
  })

  it('leaves an external coding agent turn for the next launch', async () => {
    await saveProjectThread('p1', cutOff('t6', { model: 'acp:claude-acp' }))
    const outcome = await runTurnWorker(
      { projectId: 'p1', threadId: 't6' },
      { registry: new ToolRegistry(), log: silent },
    )
    assert.deepEqual(outcome, { status: 'not-resumable' })
    assert.equal(
      (await loadProjectThreadMetas('p1')).find((meta) => meta.id === 't6')?.status,
      'running',
    )
  })

  it('never takes a thread it then declines', async () => {
    await saveProjectThread('p1', cutOff('t7', { model: chatGptPlanModelValue('codex', 'gpt-5') }))
    const outcome = await runTurnWorker(
      { projectId: 'p1', threadId: 't7' },
      { registry: new ToolRegistry(), log: silent },
    )
    assert.deepEqual(outcome, { status: 'not-resumable' })
    const files = await readdir(threadDirectoryPath('p1', 't7'))
    assert.deepEqual(
      files.filter((name) => name.startsWith(WRITER_LEASE_FILE)),
      [],
      'a relaunched app must not see the thread held while the worker decides',
    )
  })

  it('does not start a turn whose Stop came while the worker was starting', async () => {
    await saveProjectThread('p1', cutOff('t8'))
    const control = new TurnControl()
    control.handleStop()
    const outcome = await runTurnWorker(
      { projectId: 'p1', threadId: 't8' },
      { registry: new ToolRegistry(), log: silent, control },
    )
    assert.deepEqual(outcome, { status: 'stopped' })
    const meta = (await loadProjectThreadMetas('p1')).find((m) => m.id === 't8')
    assert.equal(meta?.status, 'idle')
    assert.ok(meta.interruptedTurnAt !== undefined)
    assert.equal((await loadThreadMessages('p1', 't8')).length, 2, 'nothing was added')
  })

  it('does nothing for a thread that finished', async () => {
    await saveProjectThread('p1', cutOff('t4', { status: 'idle' }))
    const outcome = await runTurnWorker(
      { projectId: 'p1', threadId: 't4' },
      { registry: new ToolRegistry(), log: silent },
    )
    assert.deepEqual(outcome, { status: 'not-resumable' })
    assert.equal((await loadThreadMessages('p1', 't4')).length, 2)
  })
})
