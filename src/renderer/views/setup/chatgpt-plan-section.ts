import type { ApiClient } from '../../../preload/api.d.ts'
import type { ChatGptPlanStatus } from '@shared/types/chatgpt-plan.ts'
import { showConfirmDialog } from '../confirm-dialog.ts'
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
  let signingIn = false
  let accountOptionsOpen = false
  let welcomeShowing = false

  async function act(work: () => Promise<void>, isSignIn = false): Promise<void> {
    signingIn = isSignIn
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
      if (isSignIn) await welcome()
    }
  }

  function render(): void {
    accountOptionsOpen = root.querySelector('details')?.open ?? accountOptionsOpen
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
        class: 'ui-btn chatgpt-sign-in',
        disabled: busy,
        'data-testid': 'chatgpt-plan-connect',
      },
      el('img', {
        src: './chatgpt-logo-white.svg',
        alt: '',
        width: '21',
        height: '21',
        'aria-hidden': 'true',
      }),
      'Continue with ChatGPT',
    )
    connect.addEventListener('click', () => {
      void act(async () => {
        status = await api.chatGptPlan.signIn(active?.clientId)
      }, true)
    })
    if (!active?.connected || !active.planEnabled) actions.append(connect)
    const accountActions = el('div', { class: 'provider-actions' })
    if (busy) {
      root.append(
        el(
          'p',
          { role: 'status', class: 'field-hint' },
          signingIn ? 'Finish signing in in your browser.' : 'Updating connection…',
        ),
      )
      const cancel = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary' },
        'Cancel sign-in',
      )
      cancel.addEventListener('click', () => {
        void api.chatGptPlan.cancelSignIn()
      })
      if (signingIn) actions.append(cancel)
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
      const renew = el(
        'button',
        { type: 'button', class: 'ui-btn ui-btn-secondary', disabled: busy },
        'Refresh connection',
      )
      renew.addEventListener('click', () => {
        void act(async () => {
          status = await api.chatGptPlan.refreshAccount(active.clientId)
          message = 'Connection refreshed.'
        })
      })
      accountActions.append(renew, disconnect)
    }
    const add = el(
      'button',
      { type: 'button', class: 'ui-btn ui-btn-secondary', disabled: busy },
      'Add another account',
    )
    add.addEventListener('click', () => {
      void act(async () => {
        status = await api.chatGptPlan.signIn()
      }, true)
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
    if (status.accounts.length) {
      const options = el('details', {}, el('summary', {}, 'Account options'), accountActions)
      options.open = accountOptionsOpen
      root.append(options)
    }
    if (message)
      root.append(
        el(
          'p',
          { role: 'status', class: 'field-hint', 'data-testid': 'chatgpt-plan-message' },
          message,
        ),
      )
  }

  async function welcome(): Promise<void> {
    if (
      welcomeShowing ||
      !status.accounts.some((account) => account.connected && account.planEnabled)
    )
      return
    welcomeShowing = true
    try {
      if ((await api.settings.get('chatGptPlanWelcomeSeen')) === true) return
      await showConfirmDialog({
        message: 'You’re using your ChatGPT plan',
        detail:
          'Copse uses your ChatGPT plan or available credits for ChatGPT plan models. Manage Copse’s allowance and credit usage in ChatGPT Settings → Usage.',
        confirmLabel: 'Got it',
        cancelLabel: 'Close',
      })
      await api.settings.set('chatGptPlanWelcomeSeen', true)
    } catch {
      // A failed preference write must not undo a successfully connected account.
    } finally {
      welcomeShowing = false
    }
  }

  async function refresh(): Promise<void> {
    try {
      status = await api.chatGptPlan.status()
    } catch (error) {
      message = error instanceof Error ? error.message : 'Could not read the ChatGPT connection.'
    }
    render()
    await welcome()
  }
  render()
  return {
    root,
    refresh,
    configured: () => status.accounts.some((account) => account.planEnabled && account.connected),
  }
}
