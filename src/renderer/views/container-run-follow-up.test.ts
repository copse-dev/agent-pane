import '../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ApiClient } from '../../preload/api.d.ts'
import type { ContainerRunProgress, ContainerRunRequest } from '@shared/types/container-run.ts'
import { createStore } from '@shared/store/store.ts'
import { containerRunToolCall } from '@shared/store/container-run-card.ts'
import { createFakeApi } from '../fake-api.test-support.ts'
import { mountContainerRunControl } from './container-run-control.ts'

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(condition(), 'the container form did not settle')
}

describe('container follow-up consent', () => {
  it('preserves settings and asks for fresh sign-in consent before starting', async () => {
    const previous: ContainerRunProgress = {
      threadId: 'thread',
      runtimeId: 'run-previous',
      phase: 'finished',
      startedAt: 1,
      finishedAt: 2,
      prompt: 'Previous task',
      model: 'acp:codex-acp',
      credential: 'login',
      settings: {
        budgets: { wallClockMs: 180_000, tokenCeiling: 20_000 },
        installDependencies: false,
      },
      egressAllowlist: [],
      log: [],
      warnings: [],
      checkout: null,
      record: null,
      error: null,
      continuedFrom: null,
    }
    const store = createStore({
      activeProjectId: 'project',
      activeThreadId: 'thread',
      threads: [
        {
          id: 'thread',
          title: 'Container work',
          status: 'idle',
          messages: [
            {
              id: 'previous',
              role: 'assistant',
              content: '',
              toolCalls: [containerRunToolCall(previous)],
              createdAt: 1,
            },
          ],
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
        getRun: () => Promise.resolve(previous),
        modelAvailability: (models) =>
          Promise.resolve(
            Object.fromEntries(
              models.map((model) => [
                model,
                { reason: null, loginOffered: { agentTitle: 'Codex' } },
              ]),
            ),
          ),
        runThread: (request) => {
          requests.push(request)
          return Promise.resolve({ ...previous, phase: 'running', runtimeId: 'run-next' })
        },
      },
    }
    let draft = 'Follow-up task'
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
      await control.followUp(draft)
      await waitFor(
        () =>
          document.querySelector('.container-run-agent-login-field')?.hasAttribute('hidden') ===
          false,
      )
      const login = document.querySelector<HTMLInputElement>('.container-run-agent-login')
      const install = document.querySelector<HTMLInputElement>('.container-run-install')
      const start = document.querySelector<HTMLButtonElement>('.container-run-start')
      assert.ok(login && install && start)
      assert.equal(login.checked, false)
      assert.equal(install.checked, false)
      assert.equal(start.disabled, true)
      assert.equal(document.querySelector<HTMLInputElement>('.container-run-minutes')?.value, '3')
      assert.equal(
        document.querySelector<HTMLInputElement>('.container-run-tokens')?.value,
        '20000',
      )
      assert.equal(requests.length, 0)
      assert.equal(draft, 'Follow-up task')

      // Cancelling retains the draft and grants nothing; reopening still needs consent.
      document.querySelector<HTMLButtonElement>('.container-run-cancel')?.click()
      assert.equal(requests.length, 0)
      await control.followUp(draft)
      await waitFor(
        () =>
          document.querySelector('.container-run-agent-login-field')?.hasAttribute('hidden') ===
          false,
      )
      const freshLogin = document.querySelector<HTMLInputElement>('.container-run-agent-login')
      const freshStart = document.querySelector<HTMLButtonElement>('.container-run-start')
      assert.ok(freshLogin && freshStart)
      assert.equal(freshLogin.checked, false)
      freshLogin.checked = true
      freshLogin.dispatchEvent(new Event('change', { bubbles: true }))
      assert.equal(freshStart.disabled, false)
      freshStart.click()
      await waitFor(() => requests.length === 1)
      assert.deepEqual(requests[0], {
        projectId: 'project',
        threadId: 'thread',
        prompt: 'Follow-up task',
        model: 'acp:codex-acp',
        budgets: { wallClockMs: 180_000, tokenCeiling: 20_000 },
        useAgentLogin: true,
        installDependencies: false,
        continueFrom: 'run-previous',
        continueContext: { prompt: 'Previous task', report: '', ref: null },
      })
      assert.equal(draft, '')
    } finally {
      control.destroy()
      document.body.replaceChildren()
    }
  })
})
