import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'

export interface FollowUpSuggestionsMount {
  root: HTMLElement
  clearSuggestions: () => void
  destroy: () => void
}

export function mountFollowUpSuggestions(
  store: AppStore,
  api: ApiClient,
  onSelect: (prompt: string) => void,
): FollowUpSuggestionsMount {
  const root = el('div', {
    class: 'follow-up-suggestions',
    role: 'group',
    'aria-label': 'Suggested follow-ups',
    hidden: '',
  })

  let fetchToken = 0
  let lastTurnKey: string | null = null

  function clearSuggestions() {
    clear(root)
    root.hidden = true
  }

  function renderSuggestions(suggestions: FollowUpSuggestion[]) {
    clear(root)
    if (suggestions.length === 0) {
      root.hidden = true
      return
    }

    for (const suggestion of suggestions) {
      const btn = el('button', {
        type: 'button',
        class: 'follow-up-bubble',
        'data-id': suggestion.id,
      })

      if (suggestion.variant === 'changes') {
        btn.classList.add('follow-up-bubble-changes')
        btn.append(
          el('span', { class: 'follow-up-label' }, suggestion.label),
          el(
            'span',
            { class: 'follow-up-stat follow-up-stat-add' },
            `+${suggestion.additions ?? 0}`,
          ),
          el(
            'span',
            { class: 'follow-up-stat follow-up-stat-del' },
            `-${suggestion.deletions ?? 0}`,
          ),
        )
      } else {
        btn.textContent = suggestion.label
      }

      btn.addEventListener('click', () => {
        clearSuggestions()
        onSelect(suggestion.prompt)
      })
      root.append(btn)
    }
    root.hidden = false
  }

  function lastExchange(threadId: string) {
    const thread = store.getState().threads.find((t) => t.id === threadId)
    if (!thread) return null

    const userMessages = thread.messages.filter((m) => m.role === 'user')
    const assistantMessages = thread.messages.filter((m) => m.role === 'assistant')
    const lastUser = userMessages.at(-1)
    const lastAssistant = assistantMessages.at(-1)
    if (!lastUser?.content.trim() || !lastAssistant) return null

    const toolNames = lastAssistant.toolCalls?.map((tc) => tc.name) ?? []
    return {
      turnKey: `${threadId}:${lastUser.id}:${lastAssistant.id}`,
      context: {
        userMessage: lastUser.content,
        assistantMessage: lastAssistant.content,
        toolNames,
      },
    }
  }

  async function maybeFetchSuggestions(threadId: string) {
    const exchange = lastExchange(threadId)
    if (!exchange) {
      clearSuggestions()
      return
    }
    if (exchange.turnKey === lastTurnKey) return
    lastTurnKey = exchange.turnKey

    const token = ++fetchToken
    try {
      const suggestions = await api.agent.suggestFollowUps(JSON.stringify(exchange.context))
      if (token !== fetchToken) return
      renderSuggestions(suggestions)
    } catch {
      if (token !== fetchToken) return
      clearSuggestions()
    }
  }

  const unsubs = [
    store.on('thread_status_changed', (tid, status) => {
      if (tid !== store.getState().activeThreadId) return
      if (status === 'running') {
        fetchToken++
        clearSuggestions()
        return
      }
      if (status === 'idle') void maybeFetchSuggestions(tid)
    }),
  ]

  return {
    root,
    clearSuggestions,
    destroy: () => {
      fetchToken++
      unsubs.forEach((u) => u())
      clearSuggestions()
    },
  }
}
