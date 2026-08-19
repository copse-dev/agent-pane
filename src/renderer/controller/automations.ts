import type { AppStore } from '@shared/store/store.ts'
import type { AutomationTriggerEvent, Thread } from '@shared/types'
import {
  addMessage,
  applyPreparedThreadCheckout,
  getThreadById,
  setThreadDraftPrompt,
  sortThreadsNewestFirst,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { dispatchAgentRun, startAutomationTurnTree } from './message-queue.ts'
import { ensureThreadMessages } from './thread-hydration.ts'

export interface AutomationControllerApi {
  agent: Pick<ApiClient['agent'], 'prepareCheckout' | 'run'>
  automations: Pick<ApiClient['automations'], 'onTriggered'>
  threads: Pick<ApiClient['threads'], 'loadProject'>
}

function isPendingAutomation(thread: Thread): boolean {
  return (
    thread.automation !== undefined &&
    thread.status === 'idle' &&
    Boolean(thread.draftPrompt?.trim())
  )
}

/**
 * Starts cron-created prompts through the same checkout, transcript, and agent
 * dispatch path as an interactive first message. Permission gates remain in
 * force; the schedule authorizes the prompt, not any later tool escalation.
 */
export function attachAutomationController(
  store: AppStore,
  api: AutomationControllerApi,
): () => void {
  const starting = new Set<string>()

  async function startThread(threadId: string): Promise<void> {
    const initial = getThreadById(store, threadId)
    const projectId = store.getState().activeProjectId
    if (!projectId || !initial || !isPendingAutomation(initial) || starting.has(threadId)) return

    const prompt = initial.draftPrompt?.trim()
    if (!prompt) return
    starting.add(threadId)
    try {
      // Threads arrive as metadata only, so an automation can be the first thing
      // to touch a transcript that was never read — on a trigger, or on restart
      // via `startPendingForActiveProject`. Load it before the run streams into
      // it, or the thread renders as a conversation that began mid-sentence.
      // (The agent's own context is unaffected: main reads it from disk.)
      await ensureThreadMessages(projectId, threadId)
      if (store.getState().activeProjectId !== projectId) return
      if (!initial.worktreeChoice) {
        const prepared = await api.agent.prepareCheckout(
          projectId,
          threadId,
          prompt,
          'worktree',
          initial.model,
        )
        if (store.getState().activeProjectId !== projectId) return
        applyPreparedThreadCheckout(store, threadId, prepared)
      }

      const current = getThreadById(store, threadId)
      if (!current || !isPendingAutomation(current)) return
      addMessage(store, threadId, 'user', prompt)
      setThreadDraftPrompt(store, threadId, '')
      startAutomationTurnTree(store, threadId)
      dispatchAgentRun(store, api, threadId, { content: prompt })
    } catch (error) {
      // Checkout failures happen before the user bubble is added, so keep the
      // prompt as a draft rather than losing scheduled work. Agent-run failures
      // after dispatch follow the normal controller/error-chunk path.
      console.error('[automations] Failed to start scheduled task:', error)
    } finally {
      starting.delete(threadId)
    }
  }

  function startPendingForActiveProject(): void {
    for (const thread of store.getState().threads) {
      if (isPendingAutomation(thread)) void startThread(thread.id)
    }
  }

  async function receiveTrigger(event: AutomationTriggerEvent): Promise<void> {
    if (store.getState().activeProjectId !== event.projectId) return
    const loaded = await api.threads.loadProject(event.projectId)
    if (store.getState().activeProjectId !== event.projectId) return
    const created = loaded.find((thread) => thread.id === event.threadId)
    if (!created) return
    if (!store.getState().threads.some((thread) => thread.id === created.id)) {
      store.setState({
        threads: sortThreadsNewestFirst([created, ...store.getState().threads]),
      })
      store.emit('threads_changed')
    }
    await startThread(created.id)
  }

  const unsubscribeTrigger = api.automations.onTriggered((event) => {
    void receiveTrigger(event)
  })
  const unsubscribeWorkspace = store.on('workspace_changed', startPendingForActiveProject)
  startPendingForActiveProject()

  return () => {
    unsubscribeTrigger()
    unsubscribeWorkspace()
  }
}
