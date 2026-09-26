import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { createStore, type AppStore } from '@shared/store/store.ts'
import type {
  AppleProjectSuggestion,
  AppleSuggestionAnswer,
} from '@shared/types/apple-development.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountAppleProjectSuggestions } from './apple-project-suggestion.ts'

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

interface Harness {
  store: AppStore
  host: HTMLElement
  probes: string[]
  enabled: Array<[string, boolean]>
  enrolled: Array<[string, string, boolean]>
  answers: Array<[string, AppleSuggestionAnswer]>
  allowed: () => number
}

function mount(suggestion: AppleProjectSuggestion): Harness {
  const base = createFakeApi()
  const probes: string[] = []
  const enabled: Array<[string, boolean]> = []
  const enrolled: Array<[string, string, boolean]> = []
  const answers: Array<[string, AppleSuggestionAnswer]> = []
  let allowedCount = 0
  const api: ApiClient = {
    ...base,
    plugins: {
      ...base.plugins,
      setEnabled: (id, on) => {
        enabled.push([id, on])
        return Promise.resolve({ plugins: [] })
      },
    },
    appleDevelopment: {
      ...base.appleDevelopment,
      suggestion: (projectId) => {
        probes.push(projectId)
        return Promise.resolve(suggestion)
      },
      answerSuggestion: (projectId, answer) => {
        answers.push([projectId, answer])
        return Promise.resolve()
      },
      setEnrolled: (projectId, threadId, on) => {
        enrolled.push([projectId, threadId, on])
        return base.appleDevelopment.state(projectId, threadId)
      },
    },
  }
  const store = createStore({
    projects: [
      { id: 'myapp', name: 'MyApp', path: '/work/MyApp' },
      { id: 'site', name: 'site', path: '/work/site' },
    ],
    activeProjectId: 'myapp',
    activeThreadId: 'thread-1',
  })
  const host = mountAppleProjectSuggestions(store, api, () => {
    allowedCount += 1
  })
  document.body.append(host)
  return { store, host, probes, enabled, enrolled, answers, allowed: () => allowedCount }
}

function dialog(): HTMLDialogElement | null {
  return document.querySelector<HTMLDialogElement>('#apple-suggestion-dialog')
}

function clickDialogButton(label: string): void {
  const button = Array.from(dialog()?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent === label,
  )
  assert.ok(button, `dialog button "${label}"`)
  button.click()
}

describe('Apple project suggestion', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('turns the plugin on and allows it in the project from the first-open dialog', async () => {
    const harness = mount({ offer: 'dialog', pluginEnabled: false })
    await tick()

    assert.equal(dialog()?.querySelector('h2')?.textContent, 'Turn on Apple development?')
    assert.match(dialog()?.textContent ?? '', /MyApp looks like an Apple project/)
    clickDialogButton('Turn on')
    await tick()
    await tick()

    assert.deepEqual(harness.enabled, [[APPLE_DEVELOPMENT_PLUGIN_ID, true]])
    assert.deepEqual(harness.enrolled, [['myapp', 'thread-1', true]])
    assert.deepEqual(harness.answers, [])
    assert.equal(harness.allowed(), 1)
    assert.equal(dialog(), null)
  })

  it('only asks to allow the project once the plugin is already on', async () => {
    const harness = mount({ offer: 'dialog', pluginEnabled: true })
    await tick()

    assert.equal(dialog()?.querySelector('h2')?.textContent, 'Use Apple development in MyApp?')
    clickDialogButton('Allow')
    await tick()
    await tick()

    assert.deepEqual(harness.enabled, [])
    assert.deepEqual(harness.enrolled, [['myapp', 'thread-1', true]])
  })

  it('records "Not now" and "Don\'t ask" as the matching answers', async () => {
    const snoozed = mount({ offer: 'dialog', pluginEnabled: false })
    await tick()
    clickDialogButton('Not now')
    await tick()
    assert.deepEqual(snoozed.answers, [['myapp', 'snoozed']])
    assert.deepEqual(snoozed.enrolled, [])
    document.body.replaceChildren()

    const dismissed = mount({ offer: 'dialog', pluginEnabled: false })
    await tick()
    clickDialogButton("Don't ask for this project")
    await tick()
    assert.deepEqual(dismissed.answers, [['myapp', 'dismissed']])
  })

  it('shows the reminder line only in the snoozed project and ends it on dismiss', async () => {
    const harness = mount({ offer: 'reminder', pluginEnabled: false })
    await tick()

    assert.equal(dialog(), null)
    assert.equal(harness.host.hidden, false)
    assert.match(harness.host.textContent, /Apple development is off for MyApp\./)

    harness.store.setState({ activeProjectId: 'site', activeThreadId: 'thread-2' })
    harness.store.emit('workspace_changed')
    assert.equal(harness.host.hidden, true)

    harness.store.setState({ activeProjectId: 'myapp', activeThreadId: 'thread-1' })
    harness.store.emit('workspace_changed')
    assert.equal(harness.host.hidden, false)

    const dismiss = harness.host.querySelector<HTMLButtonElement>(
      '.apple-suggestion-notice-dismiss',
    )
    dismiss?.click()
    await tick()
    assert.equal(harness.host.hidden, true)
    assert.deepEqual(harness.answers, [['myapp', 'dismissed']])
  })

  it('asks each project at most once per session', async () => {
    const harness = mount({ offer: 'none', pluginEnabled: false })
    await tick()
    harness.store.emit('workspace_changed')
    await tick()
    harness.store.setState({ activeProjectId: 'site', activeThreadId: 'thread-2' })
    harness.store.emit('workspace_changed')
    await tick()

    assert.deepEqual(harness.probes, ['myapp', 'site'])
  })
})
