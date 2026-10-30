import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { CommandPhase, ToolCall } from '@copse/agent/wire-types.ts'
import {
  backgroundTaskCommandCall,
  createBackgroundTaskLogsSection,
  revealToolCard,
  setBackgroundTaskLogLoader,
  type BackgroundTaskLogs,
} from './command-task-links.ts'

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

function command(id: string, commandPhase?: CommandPhase): ToolCall {
  return {
    id,
    name: 'run_background',
    args: { action: 'start', command: 'pnpm test' },
    status: 'done',
    result: 'Started.',
    ...(commandPhase ? { commandPhase } : {}),
  }
}

const RUNNING: CommandPhase = {
  state: 'running',
  since: 1,
  launched: true,
  backgroundTaskId: 'bg-1',
}

describe('background task logs on a command card', () => {
  afterEach(() => {
    setBackgroundTaskLogLoader(null)
  })

  it('is absent until the command has a task id', () => {
    assert.equal(createBackgroundTaskLogsSection(command('a')), null)
    assert.equal(
      createBackgroundTaskLogsSection(
        command('a', { state: 'starting', since: 1, launched: false }),
      ),
      null,
    )
  })

  it('reads the task output only when asked, then offers a refresh', async () => {
    const requested: string[] = []
    let next: BackgroundTaskLogs | null = { logs: 'line one\n', running: true }
    setBackgroundTaskLogLoader((taskId) => {
      requested.push(taskId)
      return Promise.resolve(next)
    })
    const section = createBackgroundTaskLogsSection(command('a', RUNNING))
    assert.ok(section)
    assert.deepEqual(requested, [], 'rendering never reads logs')
    const button = section.querySelector('button')
    const output = section.querySelector<HTMLElement>('.tool-task-logs-output')
    assert.ok(button && output)
    assert.equal(output.hidden, true)

    button.click()
    await flush()
    assert.deepEqual(requested, ['bg-1'])
    assert.equal(output.hidden, false)
    assert.equal(output.querySelector('pre')?.textContent, 'line one')
    assert.equal(button.textContent, 'Refresh logs')

    next = null
    button.click()
    await flush()
    assert.match(output.textContent ?? '', /no longer available/)
  })

  it('says so when the task printed nothing', async () => {
    setBackgroundTaskLogLoader(() => Promise.resolve({ logs: '  \n', running: false }))
    const section = createBackgroundTaskLogsSection(command('a', RUNNING))
    section?.querySelector('button')?.click()
    await flush()
    assert.equal(section?.querySelector('.tool-task-logs-output')?.textContent, 'No output.')
  })
})

describe('finding the command a completion wake reports on', () => {
  it('matches the task id, newest command first', () => {
    const older = command('older', RUNNING)
    const newer = command('newer', { ...RUNNING, state: 'exited', exitCode: 0 })
    const messages = [
      { toolCalls: [older] },
      { toolCalls: [command('other')] },
      { toolCalls: [newer] },
    ]
    const thread = { messages }
    assert.equal(backgroundTaskCommandCall(thread, 'bg-1')?.id, 'newer')
    assert.equal(backgroundTaskCommandCall(thread, 'bg-2'), undefined)
    assert.equal(backgroundTaskCommandCall(undefined, 'bg-1'), undefined)
  })

  it('opens the disclosures around the card and marks it', () => {
    const root = document.createElement('div')
    const rollup = document.createElement('details')
    const card = document.createElement('details')
    card.setAttribute('data-tool-id', 'call "1"')
    card.scrollIntoView = (): void => undefined
    rollup.append(card)
    root.append(rollup)

    assert.equal(revealToolCard(root, 'call "1"'), true)
    assert.equal(rollup.open, true)
    assert.ok(card.classList.contains('tool-card-revealed'))
    assert.equal(revealToolCard(root, 'missing'), false)
  })
})
