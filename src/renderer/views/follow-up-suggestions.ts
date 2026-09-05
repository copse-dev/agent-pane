import { el, clear } from '../dom/helpers.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { FollowUpSuggestion } from '@shared/follow-ups/types.ts'
import { reconcileChangesSuggestion } from '@shared/follow-ups/changes-stat.ts'
import { openCreatePrDialog } from './create-pr-dialog.ts'
import {
  addMessage,
  addToolCall,
  setMessageContent,
  switchThread,
  updateToolCall,
} from '@shared/store/thread-helpers.ts'
import { lastExchange } from './last-exchange.ts'
import { openComparisonModelDialog } from './comparison-model-dialog.ts'
import { comparisonModelsPayload, startComparison } from '../controller/retry-review-comparison.ts'
import { showErrorToast, showToast } from './toast.ts'

/** Open the changeset reviewer pane (mirrors the diff-conflict banner path). */
function openChangesReviewer(store: AppStore): void {
  store.setState({ rightPanelMode: 'changes', filesPaneOpen: true })
  store.emit('right_panel_mode_changed')
  store.emit('files_pane_changed')
}

/**
 * The "Compare models" bubble: pick the three models, then run the comparison
 * against the working diff. The picker opens on the pack's configured selections
 * resolved to concrete ids — a comparison priced in three inferences should name
 * what it is about to spend, and "most capable" names nothing.
 *
 * No approval prompt follows: the dialog the user just answered *is* the spend
 * decision, and the run is marked quiet so its completion does not chime either.
 */
async function runComparisonFromBubble(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  onStarted: () => void,
): Promise<void> {
  let defaults
  try {
    defaults = await api.agent.comparisonModels(comparisonModelsPayload(store, threadId))
  } catch (err) {
    showErrorToast('Could not load comparison models', err)
    return
  }
  const picked = await openComparisonModelDialog(api, defaults)
  // Backing out of the picker leaves the bubbles up: nothing happened, so the
  // offer should still be there.
  if (!picked) return
  onStarted()
  startComparison(store, api, threadId, picked)
}

/**
 * The "Create PR" bubble, in the two halves the old single agent turn split
 * into: ask a model for a description *while* the dialog is open, then — once
 * the user has settled the title, body and draft flag — run the same
 * `createPrForThread` the `gh_pr_create` tool runs, with no model in the loop.
 *
 * Backing out of the dialog leaves the bubbles up: nothing happened, so the
 * offer should still be there. Confirming records the attempt in the transcript
 * either way, because a PR is the kind of thing you go looking for later.
 */
async function createPrFromBubble(
  store: AppStore,
  api: ApiClient,
  threadId: string,
  onConfirmed: () => void,
): Promise<void> {
  const { activeProjectId } = store.getState()
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!activeProjectId) return

  // Fired before the dialog is awaited so the description is being written
  // while the user reads the form, not after they have committed to it.
  const exchange = lastExchange(store, threadId)
  const bodyPromise = exchange
    ? api.agent
        .suggestPrBody(activeProjectId, threadId, JSON.stringify(exchange.context))
        .catch(() => null)
    : undefined

  const picked = await openCreatePrDialog({
    suggestedTitle: thread?.title ?? '',
    branch: thread?.gitBranch ?? null,
    ...(bodyPromise ? { bodyPromise } : {}),
  })
  if (!picked) return
  onConfirmed()

  const request = { title: picked.title, body: picked.body, draft: picked.draft }
  const card = openPrCardInTranscript(store, threadId, request)
  try {
    const result = await api.gh.createPrForThread(activeProjectId, threadId, request)
    settlePrCard(store, card, result.ok ? 'done' : 'error', result.message)
    if (!result.ok)
      showToast(`Could not open the pull request: ${result.message}`, { variant: 'error' })
  } catch (err) {
    settlePrCard(store, card, 'error', err instanceof Error ? err.message : String(err))
    showErrorToast('Could not open the pull request', err)
  }
}

/**
 * Put the create in the transcript as a `gh_pr_create` card, the same shape the
 * agent's own call leaves behind.
 *
 * Not decoration: without it the chat says the user asked for a PR and then
 * nothing, while a PR exists on GitHub. Reusing the tool's name means the
 * existing tool-card rendering (and the turn rollup) picks it up for free, and
 * the transcript reads the same whether the model or the dialog opened it.
 */
function openPrCardInTranscript(
  store: AppStore,
  threadId: string,
  request: { title: string; body: string; draft: boolean },
): { messageId: string; toolCallId: string } {
  const messageId = addMessage(store, threadId, 'assistant')
  const toolCallId = `create-pr-${messageId}`
  addToolCall(store, messageId, {
    id: toolCallId,
    name: 'gh_pr_create',
    args: { title: request.title, draft: request.draft },
    status: 'running',
    result: null,
  })
  return { messageId, toolCallId }
}

/**
 * Close the card out with what `gh` said, and mirror it as the message's prose.
 *
 * Content first, then the tool call: `tool_call_updated` on a settled call is
 * what persists this synthetic message (persistence.ts), and nothing else
 * does — the message is never finalized by a turn. Settling the card before
 * the prose was written persisted a message with empty content, so a reload
 * showed a bare card with the "Opened PR #N" line missing.
 */
function settlePrCard(
  store: AppStore,
  card: { messageId: string; toolCallId: string },
  status: 'done' | 'error',
  message: string,
): void {
  setMessageContent(store, card.messageId, message)
  updateToolCall(store, card.messageId, card.toolCallId, { status, result: message })
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

  // Per-thread fetch tokens: a shared counter let a completion in thread B
  // invalidate an in-flight fetch for thread A (they interleave when several
  // threads go idle), so A's suggestions were silently dropped and never cached.
  const fetchTokens = new Map<string, number>()
  const nextFetchToken = (threadId: string): number => {
    const token = (fetchTokens.get(threadId) ?? 0) + 1
    fetchTokens.set(threadId, token)
    return token
  }
  let changesRefreshTimer: ReturnType<typeof setTimeout> | null = null
  let displayedThreadId: string | null = null
  const suggestionsByThread = new Map<string, CachedSuggestions>()
  const consumedThreads = new Set<string>()

  function consumeSuggestions(threadId: string): void {
    // Creating a PR appends a synthetic assistant card, not a new user turn.
    // Its store events must not re-fetch the offer we just accepted. Invalidate
    // pending fetches too, and allow suggestions again when a real run starts.
    consumedThreads.add(threadId)
    suggestionsByThread.delete(threadId)
    nextFetchToken(threadId)
    if (store.getState().activeThreadId === threadId) clearSuggestions()
  }

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

      // The one bubble in the row that publishes something outside this
      // machine, so it reads as the accented offer rather than another chip.
      if (suggestion.action === 'create-pr') btn.classList.add('follow-up-bubble-create-pr')

      btn.addEventListener('click', () => {
        // The changeset chip is a shortcut into the reviewer pane, not a prompt:
        // dropping a canned "review my changes" message into the chat was
        // surprising, and the reviewer is where accept/reject actions live.
        if (suggestion.action === 'open-changes') {
          openChangesReviewer(store)
          return
        }

        const sourceThreadId = displayedThreadId ?? threadId
        if (store.getState().activeThreadId !== sourceThreadId) {
          switchThread(store, sourceThreadId)
        }

        // An action bubble does the thing itself; only a prompt bubble routes
        // through the composer. Either way the bubbles clear when the action
        // commits, not merely when it is offered.
        if (suggestion.action === 'model-compare') {
          void runComparisonFromBubble(store, api, sourceThreadId, clearSuggestions)
          return
        }
        if (suggestion.action === 'create-pr') {
          void createPrFromBubble(store, api, sourceThreadId, () => {
            consumeSuggestions(sourceThreadId)
          })
          return
        }
        clearSuggestions()
        if (suggestion.prompt) onSelect(suggestion.prompt)
      })
      root.append(btn)
    }
    root.hidden = false
    displayedThreadId = threadId
  }

  async function maybeFetchSuggestions(threadId: string): Promise<void> {
    if (consumedThreads.has(threadId)) return
    const exchange = lastExchange(store, threadId)
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

    const { activeProjectId } = store.getState()
    if (!activeProjectId) return

    const token = nextFetchToken(threadId)
    try {
      const suggestions = await api.agent.suggestFollowUps(
        activeProjectId,
        threadId,
        JSON.stringify(exchange.context),
      )
      if (token !== fetchTokens.get(threadId)) return
      suggestionsByThread.set(threadId, { turnKey: exchange.turnKey, suggestions })
      if (store.getState().activeThreadId === threadId) {
        renderSuggestions(threadId, suggestions)
        // Reconcile the Changes chip against the thread checkout immediately —
        // suggestFollowUps already scopes to the worktree, but a concurrent
        // filesystem update can still race the snapshot.
        void refreshChangesStat()
      }
    } catch {
      if (token !== fetchTokens.get(threadId)) return
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
    const { activeProjectId, activeThreadId: activeId } = store.getState()
    if (!activeProjectId || !activeId) return
    const cached = suggestionsByThread.get(activeId)
    // The bubbles only appear after a turn produces a set; nothing to maintain
    // mid-run (the reviewer pane covers live changes during a run).
    if (!cached) return
    let stats: { additions: number; deletions: number } | null
    try {
      stats = await api.git.changeStats(activeProjectId, activeId)
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
    if (consumedThreads.has(activeId)) {
      clearSuggestions()
      return
    }
    if (displayedThreadId === activeId) return

    const exchange = lastExchange(store, activeId)
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
        consumedThreads.delete(tid)
        suggestionsByThread.delete(tid)
        if (tid === store.getState().activeThreadId) {
          nextFetchToken(tid)
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
    api.git.onWorkingTreeChanged(() => {
      scheduleChangesRefresh()
    }),
  ]

  return {
    root,
    clearSuggestions,
    destroy: (): void => {
      // Invalidate every in-flight fetch: after clear(), get() returns undefined
      // so any pending `token !== fetchTokens.get(threadId)` check bails.
      fetchTokens.clear()
      if (changesRefreshTimer) clearTimeout(changesRefreshTimer)
      unsubs.forEach((u) => {
        u()
      })
      suggestionsByThread.clear()
      clearSuggestions()
    },
  }
}
