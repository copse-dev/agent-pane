import '../../../../tests/setup-dom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeApi } from '../../fake-api.test-support.ts'
import { createChatGptPlanSection } from './chatgpt-plan-section.ts'
import { mountConfirmDialog, clickActiveConfirmDialogConfirm } from '../confirm-dialog.ts'
import type { ChatGptPlanStatus } from '@shared/types/chatgpt-plan.ts'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('ChatGPT plan settings', () => {
  it('connects through the real API surface, explains plan billing, and warns when revocation is unconfirmed', async () => {
    const base = createFakeApi()
    let status: ChatGptPlanStatus = { accounts: [], activeClientId: null }
    let signIns = 0
    let welcomeSeen = false
    mountConfirmDialog()
    const api = {
      ...base,
      settings: {
        ...base.settings,
        get: async (): Promise<unknown> => welcomeSeen,
        set: async (_key: string, value: unknown): Promise<void> => {
          welcomeSeen = value === true
        },
      },
      chatGptPlan: {
        ...base.chatGptPlan,
        status: async (): Promise<ChatGptPlanStatus> => status,
        signIn: async (): Promise<ChatGptPlanStatus> => {
          signIns++
          status = {
            activeClientId: 'client',
            accounts: [
              {
                clientId: 'client',
                label: '<user@example.com>',
                connected: true,
                planEnabled: true,
              },
            ],
          }
          return status
        },
        signOut: async (): Promise<{ status: ChatGptPlanStatus; revoked: boolean }> => ({
          status: {
            ...status,
            accounts: status.accounts.map((account) => ({
              ...account,
              connected: false,
              planEnabled: false,
            })),
          },
          revoked: false,
        }),
      },
    }
    const section = createChatGptPlanSection(api, () => {})
    await section.refresh()
    section.root.querySelector<HTMLButtonElement>('[data-testid="chatgpt-plan-connect"]')?.click()
    await flush()
    assert.match(
      document.querySelector('#confirm-dialog')?.textContent ?? '',
      /You’re using your ChatGPT plan/,
    )
    clickActiveConfirmDialogConfirm()
    await flush()
    assert.equal(welcomeSeen, true)
    assert.equal(signIns, 1)
    assert.equal(section.configured(), true)
    assert.match(section.root.textContent, /Using ChatGPT plan/)
    assert.equal(section.root.querySelector('[data-testid="chatgpt-plan-connect"]'), null)
    assert.equal(section.root.querySelector('details')?.open, false)
    const usage = [...section.root.querySelectorAll('button')].find(
      (button) => button.textContent === 'Manage usage',
    )
    assert.ok(usage?.classList.contains('ui-btn-primary'))
    assert.equal(section.root.querySelector('user'), null)
    await section.refresh()
    assert.equal(document.querySelector<HTMLDialogElement>('#confirm-dialog')?.open, false)
    const signOut = [...section.root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Sign out',
    )
    assert.ok(signOut)
    signOut.click()
    await flush()
    assert.equal(section.configured(), false)
    assert.match(section.root.textContent, /Remote revocation was not confirmed/)
  })

  it('refreshes the selected account and shows a recoverable error without pretending it is sign-in', async () => {
    const base = createFakeApi()
    const section = createChatGptPlanSection(
      {
        ...base,
        settings: { ...base.settings, get: async (): Promise<unknown> => true },
        chatGptPlan: {
          ...base.chatGptPlan,
          status: async (): Promise<ChatGptPlanStatus> => ({
            activeClientId: 'selected',
            accounts: [{ clientId: 'selected', label: 'You', connected: true, planEnabled: true }],
          }),
          refreshAccount: async (clientId: string): Promise<ChatGptPlanStatus> => {
            assert.equal(clientId, 'selected')
            throw new Error('Try refreshing again')
          },
        },
      },
      () => {},
    )
    await section.refresh()
    const renew = [...section.root.querySelectorAll('button')].find(
      (button) => button.textContent === 'Refresh connection',
    )
    assert.ok(renew)
    renew.click()
    assert.match(section.root.textContent, /Updating connection/)
    assert.equal(section.root.textContent.includes('Cancel sign-in'), false)
    await flush()
    assert.match(section.root.textContent, /Try refreshing again/)
    assert.equal(section.configured(), true)
  })

  it('shows a connection error and keeps retry available', async () => {
    const base = createFakeApi()
    const section = createChatGptPlanSection(
      {
        ...base,
        chatGptPlan: {
          ...base.chatGptPlan,
          signIn: async () => {
            throw new Error('Consent declined')
          },
        },
      },
      () => {},
    )
    section.root.querySelector<HTMLButtonElement>('[data-testid="chatgpt-plan-connect"]')?.click()
    await flush()
    assert.match(section.root.textContent, /Consent declined/)
    assert.equal(
      section.root.querySelector<HTMLButtonElement>('[data-testid="chatgpt-plan-connect"]')
        ?.disabled,
      false,
    )
    assert.equal(section.configured(), false)
  })
})
