import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import {
  addMessage,
  appendToken,
  addToolCall,
  updateToolCall,
  setThreadStatus,
  setThreadTitle,
  updateUsage,
} from '@shared/store/thread-helpers.ts'

export function startAgentController(store: AppStore, api: ApiClient): () => void {
  // Per-thread streaming state: the message currently accumulating text, and
  // whether a tool call has arrived since the last text chunk. When text
  // resumes after tool calls, we finalize the current message and start a new
  // one so the final answer renders BELOW the tool cards rather than above them.
  const state = new Map<string, { msgId: string | null; toolSinceText: boolean }>()
  const get = (tid: string) => {
    let st = state.get(tid)
    if (!st) {
      st = { msgId: null, toolSinceText: false }
      state.set(tid, st)
    }
    return st
  }

  const unsub = api.agent.onChunk((threadId, chunk) => {
    const st = get(threadId)
    switch (chunk.type) {
      case 'text': {
        if (!st.msgId || st.toolSinceText) {
          // Finalize the previous block (markdown render) before starting a new one.
          if (st.msgId) store.emit('message_done', st.msgId)
          st.msgId = addMessage(store, threadId, 'assistant')
          st.toolSinceText = false
        }
        appendToken(store, st.msgId, chunk.text)
        break
      }
      case 'tool_call': {
        if (!st.msgId) st.msgId = addMessage(store, threadId, 'assistant')
        addToolCall(store, st.msgId, {
          id: chunk.toolCall.id,
          name: chunk.toolCall.name,
          args: chunk.toolCall.args,
          status: 'running',
          result: null,
        })
        st.toolSinceText = true
        break
      }
      case 'tool_result': {
        if (st.msgId) {
          updateToolCall(store, st.msgId, chunk.toolCallId, {
            status: chunk.isError ? 'error' : 'done',
            result: chunk.result,
          })
          if (chunk.toolCallId && !chunk.isError) {
            tryOpenFileFromResult(store, chunk.result)
          }
        }
        break
      }
      case 'done': {
        if (st.msgId) store.emit('message_done', st.msgId)
        state.delete(threadId)
        setThreadStatus(store, threadId, 'idle')
        void maybeNameThread(store, api, threadId)
        break
      }
    }
  })

  // Accumulate token usage per thread so the input-bar footer can show cost.
  api.agent.onUsage((threadId, usage) => {
    const thread = store.getState().threads.find((t) => t.id === threadId)
    if (!thread) return
    updateUsage(store, threadId, {
      inputTokens: thread.usage.inputTokens + usage.inputTokens,
      outputTokens: thread.usage.outputTokens + usage.outputTokens,
    })
  })

  // When diff is queued from main, update staged diffs in store
  api.diff.onQueued((entries) => {
    store.setState({ stagedDiffs: entries, panelTab: 'diff' })
    store.emit('staged_diffs_changed')
    store.emit('panel_changed')
  })

  return unsub
}

// Threads we've already attempted to auto-name, to avoid repeat calls.
const namedThreads = new Set<string>()

function firstWords(text: string, n = 6): string {
  return text.split(/\s+/).slice(0, n).join(' ').slice(0, 60) || 'New Thread'
}

// After a thread's first exchange completes, derive a title from the first user
// message — preferring a local model (LM Studio) for this small task, with a
// plain word-slice fallback.
async function maybeNameThread(store: AppStore, api: ApiClient, threadId: string): Promise<void> {
  if (namedThreads.has(threadId)) return
  const thread = store.getState().threads.find((t) => t.id === threadId)
  if (!thread || thread.title !== 'New Thread') return
  const firstUser = thread.messages.find((m) => m.role === 'user')
  if (!firstUser || !firstUser.content.trim()) return
  namedThreads.add(threadId)

  let title: string | null = null
  try {
    title = await api.agent.suggestTitle(firstUser.content)
  } catch {
    title = null
  }
  setThreadTitle(store, threadId, title?.trim() || firstWords(firstUser.content))
}

function tryOpenFileFromResult(_store: AppStore, _result: string) {
  // If tool result is file content (read_file), open it in the panel
  // Convention: read_file returns the content directly; we use the store's pending openFile
  // The main process sends agent:show_diff for write_file — handled separately
}
