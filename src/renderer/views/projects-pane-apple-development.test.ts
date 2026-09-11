import '../../../tests/setup-dom.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createStore } from '@shared/store/store.ts'
import type { AppleProjectDetection } from '@shared/types/apple-development.ts'
import type { PluginsListResult } from '@shared/types/plugins.ts'
import { resetProjectSwitchStateForTest } from '../controller/projects.ts'
import { dismissContextMenu } from '../dom/context-menu.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountProjectsPane } from './projects-pane.ts'

afterEach(() => {
  dismissContextMenu()
  document.body.replaceChildren()
  resetProjectSwitchStateForTest()
})

describe('project row Apple Development menu', () => {
  it('offers setup only when the lightweight project probe finds Apple metadata', async () => {
    const store = createStore({
      projects: [{ id: 'apple', path: '/workspace', name: 'DemoApp' }],
      activeProjectId: 'apple',
      expandedProjectId: 'apple',
      workspaceRoot: '/workspace',
    })
    const api = createFakeApi()
    api.plugins.list = (): Promise<PluginsListResult> => Promise.resolve({ plugins: [] })
    api.appleDevelopment.detectProject = (): Promise<AppleProjectDetection> =>
      Promise.resolve({ detected: true, enrolled: false, supportedHost: true })
    const host = document.createElement('div')
    document.body.append(host)
    mountProjectsPane(host, store, api)

    host.querySelector<HTMLButtonElement>('.project-menu-btn')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const labels = Array.from(document.querySelectorAll('.context-menu-item')).map(
      (item) => item.textContent,
    )
    assert.ok(labels.includes('Apple Development…'))
    assert.ok(labels.includes('Remove from sidebar'))
  })
})
