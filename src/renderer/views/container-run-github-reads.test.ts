import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ContainerRunRequest } from '@shared/types/container-run.ts'
import { createStore } from '@shared/store/store.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountContainerRunControl } from './container-run-control.ts'

/** Yields to pending callbacks until `condition` holds, without a wall-clock sleep. */
async function settle(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.ok(condition(), 'the container form did not settle')
}

function toggle(box: HTMLInputElement): void {
  box.checked = !box.checked
  box.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('container run GitHub reads (A24)', () => {
  it('starts off, previews the arming line, and sends the choice with the run', async () => {
    const store = createStore({
      activeProjectId: 'project',
      activeThreadId: 'thread',
      threads: [
        {
          id: 'thread',
          title: 'Container work',
          status: 'idle',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const requests: ContainerRunRequest[] = []
    const base = createFakeApi()
    const api: ApiClient = {
      ...base,
      container: {
        ...base.container,
        getRun: () => Promise.resolve(null),
        modelAvailability: (models) =>
          Promise.resolve(Object.fromEntries(models.map((model) => [model, { reason: null }]))),
        runThread: (request) => {
          requests.push(request)
          return base.container.runThread(request)
        },
      },
    }
    let draft = 'Read the failing check and fix it'
    const control = mountContainerRunControl(
      api,
      {
        store,
        getActiveThreadId: () => store.getState().activeThreadId,
        getActiveProjectId: () => store.getState().activeProjectId,
        getModel: () => 'claude-sonnet-4-6',
        getDraft: () => draft,
        clearDraft: () => {
          draft = ''
        },
      },
      () => {},
    )
    try {
      control.open()
      const github = document.querySelector<HTMLInputElement>('.container-run-github')
      const install = document.querySelector<HTMLInputElement>('.container-run-install')
      const arming = document.querySelector('.container-run-github-arming')
      const start = document.querySelector<HTMLButtonElement>('.container-run-start')
      assert.ok(github && install && arming && start)
      // Off by default, and the line the run would record says so.
      assert.equal(github.checked, false)
      assert.equal(arming.textContent, 'GitHub: off, not turned on for this run')

      // A fresh run installs by default, and an install keeps GitHub reads off.
      assert.equal(install.checked, true)
      toggle(github)
      assert.equal(arming.textContent, 'GitHub: off, because the run installs dependencies')

      // With no install, a model the desktop calls gets them.
      toggle(install)
      assert.equal(
        arming.textContent,
        'GitHub: read-only through your desktop GitHub sign-in, turned on for this run; writes refused',
      )

      await settle(() => !start.disabled)
      start.click()
      await settle(() => requests.length === 1)
      // The choice goes to the main process as the user left it.
      assert.deepEqual(
        requests.map((request) => ({
          githubReads: request.githubReads,
          installDependencies: request.installDependencies,
        })),
        [{ githubReads: true, installDependencies: false }],
      )
    } finally {
      control.destroy()
      document.body.replaceChildren()
    }
  })
})
