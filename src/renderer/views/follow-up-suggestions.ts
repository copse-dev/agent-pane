import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { FollowUpSuggestion, FollowUpContext } from '@shared/follow-ups/types.ts'
import { switchThread, getThreadById } from '@shared/store/thread-helpers.ts'

export interface FollowUpSuggestionsMount {
  root: HTMLElement
  clearSuggestions: () => void
  destroy: () => void
}

interface CachedSuggestions {
  turnKey: string
  suggestions: FollowUpSuggestion[]
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
  let displayedThreadId: string | null = null
  const suggestionsByThread = new Map<string, CachedSuggestions>()

  function clearSuggestions(): void {
    clear(root)
    root.hidden = true
    displayedThreadId = null
  }

  function renderSuggestions(threadId: string, suggestions: FollowUpSuggestion[]): void {
    clear(root)
    if (suggestions.length === 0) {
      root.hidden = true
      displayedThreadId = null
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
        const sourceThreadId = displayedThreadId ?? threadId
        clearSuggestions()
        if (store.getState().activeThreadId !== sourceThreadId) {
          switchThread(store, sourceThreadId)
        }
        onSelect(suggestion.prompt)
      })
      root.append(btn)
    }
    root.hidden = false
    displayedThreadId = threadId
  }

  function lastExchange(threadId: string): { turnKey: string; context: FollowUpContext } | null {
    const thread = getThreadById(store, threadId)
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

  async function maybeFetchSuggestions(threadId: string): Promise<void> {
    const exchange = lastExchange(threadId)
    if (!exchange) {
      suggestionsByThread.delete(threadId)
      if (store.getState().activeThreadId === threadId) clearSuggestions()
      return
    }

    const cached = suggestionsByThread.get(threadId)
    if (cached?.turnKey === exchange.turnKey) {
      if (store.getState().activeThreadId === threadId) {
        renderSuggestions(threadId, cached.suggestions)
      }
      return
    }

    const token = ++fetchToken
    try {
      const suggestions = (await api.agent.suggestFollowUps(JSON.stringify(exchange.context))) ?? []
      if (token !== fetchToken) return
      suggestionsByThread.set(threadId, { turnKey: exchange.turnKey, suggestions })
      if (store.getState().activeThreadId === threadId) {
        renderSuggestions(threadId, suggestions)
      }
    } catch {
      if (token !== fetchToken) return
      suggestionsByThread.delete(threadId)
      if (store.getState().activeThreadId === threadId) clearSuggestions()
    }
  }

  function showForActiveThread(): void {
    const activeId = store.getState().activeThreadId
    if (!activeId) {
      clearSuggestions()
      return
    }
    if (displayedThreadId === activeId) return

    const exchange = lastExchange(activeId)
    if (!exchange) {
      clearSuggestions()
      return
    }

    const cached = suggestionsByThread.get(activeId)
    if (cached?.turnKey === exchange.turnKey) {
      renderSuggestions(activeId, cached.suggestions)
      return
    }

    void maybeFetchSuggestions(activeId)
  }

  const unsubs = [
    store.on('thread_status_changed', (tid, status) => {
      if (status === 'running') {
        suggestionsByThread.delete(tid)
        if (tid === store.getState().activeThreadId) {
          fetchToken++
          clearSuggestions()
        }
        return
      }
      if (status === 'idle') void maybeFetchSuggestions(tid)
    }),
    store.on('threads_changed', () => {
      showForActiveThread()
    }),
  ]

  return {
    root,
    clearSuggestions,
    destroy: (): void => {
      fetchToken++
      unsubs.forEach((u) => u())
      suggestionsByThread.clear()
      clearSuggestions()
    },
  }
}
