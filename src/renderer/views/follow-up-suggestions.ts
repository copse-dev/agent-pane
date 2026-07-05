import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { FollowUpSuggestion, FollowUpContext } from '@shared/follow-ups/types.ts'
import { reconcileChangesSuggestion } from '@shared/follow-ups/changes-stat.ts'
import { switchThread, getThreadById } from '@shared/store/thread-helpers.ts'

/** Open the changeset reviewer pane (mirrors the diff-conflict banner path). */
function openChangesReviewer(store: AppStore): void {
  store.setState({ rightPanelMode: 'changes', filesPaneOpen: true })
  store.emit('right_panel_mode_changed')
  store.emit('files_pane_changed')
}

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
  let changesRefreshTimer: ReturnType<typeof setTimeout> | null = null
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
            `+${String(suggestion.additions ?? 0)}`,
          ),
          el(
            'span',
            { class: 'follow-up-stat follow-up-stat-del' },
            `-${String(suggestion.deletions ?? 0)}`,
          ),
        )
      } else {
        btn.textContent = suggestion.label
      }

      btn.addEventListener('click', () => {
        // The changeset chip is a shortcut into the reviewer pane, not a prompt:
        // dropping a canned "review my changes" message into the chat was
        // surprising, and the reviewer is where accept/reject actions live.
        if (suggestion.variant === 'changes') {
          openChangesReviewer(store)
          return
        }
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

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- persisted/legacy messages may predate the toolCalls field
    const toolNames = (lastAssistant.toolCalls ?? []).map((tc) => tc.name)
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
      // Result crosses the IPC boundary; the runtime value may be undefined despite the typed contract.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

  // Keep the deterministic "Changes" chip's +/- counts current. Suggestions are
  // otherwise computed once per turn, so the count would otherwise freeze on a
  // snapshot and go stale as the working tree moves (edits, commits, accept /
  // reject of proposed diffs). This refreshes just that chip — model picks are
  // left untouched, so no LLM call is made on filesystem churn.
  async function refreshChangesStat(): Promise<void> {
    const activeId = store.getState().activeThreadId
    if (!activeId) return
    const cached = suggestionsByThread.get(activeId)
    // The bubbles only appear after a turn produces a set; nothing to maintain
    // mid-run (the reviewer pane covers live changes during a run).
    if (!cached) return
    let stats: { additions: number; deletions: number } | null
    try {
      stats = await api.git.changeStats()
    } catch {
      return
    }
    const next = reconcileChangesSuggestion(cached.suggestions, stats)
    if (next === cached.suggestions) return
    suggestionsByThread.set(activeId, { turnKey: cached.turnKey, suggestions: next })
    if (store.getState().activeThreadId === activeId) renderSuggestions(activeId, next)
  }

  function scheduleChangesRefresh(): void {
    if (changesRefreshTimer) clearTimeout(changesRefreshTimer)
    changesRefreshTimer = setTimeout(() => void refreshChangesStat(), 400)
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
    api.fs.onChanged(() => {
      scheduleChangesRefresh()
    }),
  ]

  return {
    root,
    clearSuggestions,
    destroy: (): void => {
      fetchToken++
      if (changesRefreshTimer) clearTimeout(changesRefreshTimer)
      unsubs.forEach((u) => {
        u()
      })
      suggestionsByThread.clear()
      clearSuggestions()
    },
  }
}
