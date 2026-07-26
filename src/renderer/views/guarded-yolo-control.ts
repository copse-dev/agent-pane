import type { ApiClient } from '../../preload/api.d.ts'
import type { GuardedYoloState } from '@shared/types/guarded-yolo.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast } from './toast.ts'

const OFF_STATE = (threadId: string): GuardedYoloState => ({
  threadId,
  phase: 'off',
  containment: 'unsandboxed',
  expiresAt: null,
})

export function mountGuardedYoloControl(
  api: Pick<ApiClient, 'security'>,
  getActiveThreadId: () => string | null,
  onStateChanged: () => void,
): {
  element: HTMLElement
  menuLabel: () => string
  toggle: () => void
  refresh: () => void
  destroy: () => void
} {
  const text = el('span', { class: 'guarded-yolo-text' })
  const disable = el('button', { type: 'button', class: 'guarded-yolo-disable' }, 'Disable')
  const element = el(
    'div',
    {
      class: 'guarded-yolo-banner',
      role: 'alert',
      'aria-live': 'polite',
      hidden: '',
    },
    el('span', { class: 'guarded-yolo-icon', 'aria-hidden': 'true' }, '!'),
    text,
    disable,
  )
  const states = new Map<string, GuardedYoloState>()
  let refreshSequence = 0

  function activeState(): GuardedYoloState | null {
    const threadId = getActiveThreadId()
    if (!threadId) return null
    return states.get(threadId) ?? OFF_STATE(threadId)
  }

  function render(): void {
    const state = activeState()
    element.hidden = !state || state.phase === 'off'
    if (!state || state.phase === 'off') {
      text.textContent = ''
      delete element.dataset['phase']
      delete element.dataset['containment']
      onStateChanged()
      return
    }
    element.dataset['phase'] = state.phase
    element.dataset['containment'] = state.containment
    const phase = state.phase === 'active' ? 'active for this turn' : 'armed for the next turn'
    const containment =
      state.containment === 'project-sandbox'
        ? 'Project sandbox where possible; external commands may run unsandboxed.'
        : 'No OS sandbox; commands run with your full user permissions.'
    text.textContent = `Guarded YOLO ${phase}. ${containment}`
    onStateChanged()
  }

  function update(state: GuardedYoloState): void {
    states.set(state.threadId, state)
    if (state.threadId === getActiveThreadId()) render()
  }

  function refresh(): void {
    const threadId = getActiveThreadId()
    const sequence = ++refreshSequence
    if (!threadId) {
      render()
      return
    }
    void api.security
      .getGuardedYolo(threadId)
      .then((state) => {
        if (sequence === refreshSequence) update(state)
      })
      .catch((error: unknown) => {
        showErrorToast('Could not read Guarded YOLO state', error)
      })
  }

  function toggle(): void {
    const threadId = getActiveThreadId()
    if (!threadId) return
    const state = states.get(threadId) ?? OFF_STATE(threadId)
    const action =
      state.phase === 'off'
        ? api.security.enableGuardedYolo(threadId)
        : api.security.disableGuardedYolo(threadId)
    void action.then(update).catch((error: unknown) => {
      showErrorToast('Could not change Guarded YOLO mode', error)
    })
  }

  disable.addEventListener('click', toggle)
  const unsubscribe = api.security.onGuardedYoloChanged(update)
  refresh()

  return {
    element,
    menuLabel: () =>
      activeState()?.phase === 'off'
        ? 'Enable Guarded YOLO for next turn…'
        : 'Disable Guarded YOLO',
    toggle,
    refresh,
    destroy: (): void => {
      unsubscribe()
    },
  }
}
