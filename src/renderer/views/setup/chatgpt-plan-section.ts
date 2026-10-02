import type { ApiClient } from '../../../preload/api.d.ts'
import type { ChatGptPlanStatus } from '@shared/types/chatgpt-plan.ts'
import { el, clear } from '../../dom/helpers.ts'

const USAGE_URL = 'https://chatgpt.com/settings/usage'

export function createChatGptPlanSection(
  api: ApiClient,
  onChanged: () => void,
): {
  root: HTMLElement
  refresh: () => Promise<void>
  configured: () => boolean
} {
  const root = el('div', { 'data-testid': 'chatgpt-plan-section' })
  let status: ChatGptPlanStatus = { accounts: [], activeClientId: null }
  let busy = false
  let message = ''

  async function act(work: () => Promise<void>): Promise<void> {
    busy = true
    message = ''
    render()
    try {
      await work()
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not connect ChatGPT.'
    } finally {
      busy = false
      render()
      onChanged()
    }
  }

  function render(): void {
    clear(root)
    const active = status.accounts.find((account) => account.clientId === status.activeClientId)
    if (status.accounts.length) {
      const picker = el('select', { 'aria-label': 'ChatGPT account', disabled: busy })
      picker.append(el('option', { value: '' }, 'Choose a ChatGPT account'))
      for (const [index, account] of status.accounts.entries()) {
        picker.append(
          el(
            'option',
            { value: account.clientId },
            `${account.label} · connection ${String(index + 1)}${account.connected ? '' : ' (signed out)'}`,
          ),
        )
      }
      picker.value = status.activeClientId ?? ''
      picker.addEventListener('change', () => {
        if (picker.value)
          void act(async () => {
            status = await api.chatGptPlan.selectAccount(picker.value)
          })
      })
      root.append(el('label', {}, 'ChatGPT account', picker))
    }
    if (active?.connected) {
      root.append(
        el(
          'p',
          { role: 'status', class: 'field-hint' },
          active.planEnabled
            ? 'Using ChatGPT plan. Select a model from the ChatGPT plan group to start.'
            : 'Signed in. ChatGPT plan permission was not granted; reconnect to enable it.',
        ),
      )
    }
    const actions = el('div', { class: 'provider-actions' })
    const connect = el(
      'button',
      {
        type: 'button',
        class: 'ui-btn ui-btn-secondary',
        disabled: busy,
        'data-testid': 'chatgpt-plan-connect',
      },
      'Continue with ChatGPT',
    )
    connect.addEventListener('click', () => {
      void act(async () => {
        const before = status.accounts.map((account) => account.clientId)
        status = await api.chatGptPlan.signIn(active?.clientId)
        const connected = status.accounts.find(
          (account) => account.clientId === status.activeClientId,
        )
        if (connected?.planEnabled && !before.includes(connected.clientId))
          message = 'You’re using your ChatGPT plan. Manage usage in ChatGPT settings.'
      })
    })
    if (!active?.connected || !active.planEnabled) actions.append(connect)
    const accountActions = el('div', { class: 'provider-actions' })
    if (busy) {
      root.append(
        el('p', { role: 'status', class: 'field-hint' }, 'Finish signing in in your browser.'),
      )
      const cancel = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary' },
        'Cancel sign-in',
      )
      cancel.addEventListener('click', () => {
        void api.chatGptPlan.cancelSignIn()
      })
      actions.append(cancel)
    }
    if (active?.connected) {
      const disconnect = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary', disabled: busy },
        'Sign out',
      )
      disconnect.addEventListener('click', () => {
        void act(async () => {
          const result = await api.chatGptPlan.signOut(active.clientId)
          status = result.status
          if (!result.revoked)
            message =
              'Signed out locally. Remote revocation was not confirmed; disconnect Copse in ChatGPT settings.'
        })
      })
      accountActions.append(disconnect)
    }
    const add = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary', disabled: busy },
      'Add another account',
    )
    add.addEventListener('click', () => {
      void act(async () => {
        status = await api.chatGptPlan.signIn()
      })
    })
    if (status.accounts.length) accountActions.append(add)
    const usage = el(
      'button',
      {
        type: 'button',
        class: active?.planEnabled ? 'ui-btn ui-btn-primary' : 'ui-btn ui-btn-secondary',
      },
      'Manage usage',
    )
    usage.addEventListener('click', () => {
      void api.shell.openExternal(USAGE_URL)
    })
    actions.append(usage)
    root.append(actions)
    if (status.accounts.length)
      root.append(el('details', {}, el('summary', {}, 'Account options'), accountActions))
    if (message)
      root.append(
        el(
          'p',
          { role: 'status', class: 'field-hint', 'data-testid': 'chatgpt-plan-message' },
          message,
        ),
      )
  }

  async function refresh(): Promise<void> {
    try {
      status = await api.chatGptPlan.status()
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not read the ChatGPT connection.'
    }
    render()
  }
  render()
  return {
    root,
    refresh,
    configured: () => status.accounts.some((account) => account.planEnabled && account.connected),
  }
}
