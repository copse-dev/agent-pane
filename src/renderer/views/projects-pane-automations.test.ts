import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '@shared/store/store.ts'
import type { Thread } from '@shared/types'
import { createFakeApi } from '../fake-api.test-support.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { resetAttention, setAttentionThreads } from '../controller/attention.ts'
import { mountProjectsPane } from './projects-pane.ts'

function thread(id: string, title: string, scheduleId?: string, triggeredAt = 10): Thread {
  return {
    id,
    title,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    ...(scheduleId
      ? {
          automation: {
            scheduleId,
            scheduleName: title,
            triggeredAt,
          },
        }
      : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

function mount(threads: Thread[], activeThreadId: string): HTMLElement {
  const store = createStore({
    projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
    activeProjectId: 'a',
    expandedProjectId: 'a',
    workspaceRoot: '/a',
    threads,
    activeThreadId,
  })
  const host = document.createElement('div')
  document.body.append(host)
  mountProjectsPane(host, store, createFakeApi())
  return host
}

afterEach(() => {
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
  resetAttention()
})

describe('projects pane automation group', () => {
  it('keeps automation threads behind one collapsed disclosure', () => {
    const host = mount(
      [
        thread('chat', 'Regular conversation'),
        thread('docs-latest', 'Docs freshness', 'schedule-docs', 20),
        thread('docs-previous', 'Docs freshness', 'schedule-docs', 10),
        thread('issues', 'Issue triage', 'schedule-issues'),
      ],
      'chat',
    )

    const toggle = host.querySelector<HTMLButtonElement>('.automation-threads-toggle')
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(toggle.querySelector('.automation-threads-count')?.textContent, '2')
    assert.deepEqual(
      Array.from(host.querySelectorAll('.chat-title')).map((node) => node.textContent),
      ['Regular conversation'],
    )

    toggle.click()
    assert.equal(
      host.querySelector('.automation-threads-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.deepEqual(
      Array.from(host.querySelectorAll('.chat-title')).map((node) => node.textContent),
      ['Regular conversation', 'Issue triage'],
    )
    const scheduleToggle = host.querySelector<HTMLButtonElement>(
      '.automation-schedule-group[data-schedule-id="schedule-docs"] .automation-schedule-toggle',
    )
    assert.ok(scheduleToggle)
    assert.equal(scheduleToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(
      scheduleToggle.querySelector('.automation-schedule-title')?.textContent,
      'Docs freshness',
    )
    assert.equal(scheduleToggle.querySelector('.automation-schedule-count')?.textContent, '2 runs')

    scheduleToggle.click()
    const runRows = host.querySelectorAll(
      '.automation-schedule-group[data-schedule-id="schedule-docs"] .automation-schedule-runs .chat-row',
    )
    assert.equal(runRows.length, 2)
    assert.match(runRows[0]?.textContent ?? '', /^Latest · /)
  })

  it('reveals an automation thread when it is the current selection', () => {
    const host = mount(
      [thread('chat', 'Regular conversation'), thread('docs', 'Docs freshness', 'schedule-docs')],
      'docs',
    )

    assert.equal(
      host.querySelector('.automation-threads-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(
      host.querySelector('.chat-row.is-automation.selected .chat-title')?.textContent,
      'Docs freshness',
    )
  })

  it('reveals the owning schedule when a historical run is selected', () => {
    const host = mount(
      [
        thread('docs-latest', 'Docs freshness', 'schedule-docs', 20),
        thread('docs-previous', 'Docs freshness', 'schedule-docs', 10),
      ],
      'docs-previous',
    )

    assert.equal(
      host.querySelector('.automation-threads-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(
      host.querySelector('.automation-schedule-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(
      host
        .querySelector('.automation-schedule-runs .chat-row.selected')
        ?.getAttribute('data-thread-id'),
      'docs-previous',
    )
  })

  it('auto-reveals only runs needing attention beneath their schedule', () => {
    const store = createStore({
      projects: [{ id: 'a', path: '/a', name: 'Alpha' }],
      activeProjectId: 'a',
      expandedProjectId: 'a',
      workspaceRoot: '/a',
      threads: [
        thread('chat', 'Regular conversation'),
        thread('docs-latest', 'Docs freshness', 'schedule-docs', 30),
        thread('docs-waiting', 'Docs freshness', 'schedule-docs', 20),
        thread('docs-oldest', 'Docs freshness', 'schedule-docs', 10),
      ],
      activeThreadId: 'chat',
    })
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, createFakeApi())

    setAttentionThreads(store, 'approval', ['docs-waiting'])

    const automationToggle = host.querySelector('.automation-threads-toggle')
    const scheduleToggle = host.querySelector('.automation-schedule-toggle')
    assert.ok(automationToggle && scheduleToggle)
    assert.equal(automationToggle.getAttribute('aria-expanded'), 'true')
    assert.equal(scheduleToggle.getAttribute('aria-expanded'), 'false')
    assert.equal(automationToggle.querySelectorAll('.chat-attention-bell').length, 0)
    assert.equal(scheduleToggle.querySelectorAll('.chat-attention-bell').length, 0)
    const visibleRuns = host.querySelectorAll('.automation-schedule-runs .chat-row')
    assert.equal(visibleRuns.length, 1)
    const visibleRun = visibleRuns.item(0)
    assert.ok(visibleRun)
    assert.equal(visibleRun.getAttribute('data-thread-id'), 'docs-waiting')
    assert.equal(visibleRun.querySelectorAll('.chat-attention-bell').length, 1)

    scheduleToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(
      host.querySelector('.automation-schedule-toggle')?.getAttribute('aria-expanded'),
      'true',
    )
    assert.equal(host.querySelectorAll('.automation-schedule-runs .chat-row').length, 3)
  })
})
