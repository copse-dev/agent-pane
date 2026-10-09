import type { AppStore } from '@shared/store/store.ts'
import { ipcErrorMessage } from '../ipc-error-message.ts'
import { classifyAutomationFailureMessage } from '@shared/automation-failure.ts'
import type { AutomationFailureCode } from '@shared/types'
import type { AutomationTriggerEvent, Thread } from '@shared/types'
import {
  addMessage,
  applyPreparedThreadCheckout,
  getThreadById,
  markAutomationStartFailed,
  setThreadDraftPrompt,
  sortThreadsNewestFirst,
} from '@shared/store/thread-helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { dispatchAgentRun, startAutomationTurnTree } from './message-queue.ts'
import { ensureThreadMessages } from './thread-hydration.ts'

export interface AutomationControllerApi {
  agent: Pick<ApiClient['agent'], 'prepareCheckout' | 'run'>
  automations: Pick<ApiClient['automations'], 'onTriggered' | 'canStart' | 'reportStartFailure'>
  threads: Pick<ApiClient['threads'], 'loadProject'>
}

export const AUTOMATION_START_RETRY_MS = 15_000

function startFailureDetail(error: unknown): string {
  return ipcErrorMessage(error, 'the checkout could not be prepared')
}

function isPendingAutomation(thread: Thread): boolean {
  return (
    thread.automation !== undefined &&
    thread.status === 'idle' &&
    thread.automation.startFailedAt === undefined &&
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
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retrying = new Set<string>()
  const retryPending = (threadId: string): void => {
    startThread(threadId).catch((error: unknown) => {
      console.error('[automations] Failed to retry scheduled task:', error)
    })
  }

  function retryKey(projectId: string, threadId: string): string {
    return JSON.stringify([projectId, threadId])
  }

  function clearRetry(projectId: string, threadId: string): void {
    const key = retryKey(projectId, threadId)
    const timer = retryTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    retryTimers.delete(key)
    retrying.delete(key)
  }

  function scheduleRetry(projectId: string, threadId: string): boolean {
    const key = retryKey(projectId, threadId)
    const firstDenial = !retrying.has(key)
    retrying.add(key)
    if (!retryTimers.has(key)) {
      const timer = setTimeout(() => {
        retryTimers.delete(key)
        if (store.getState().activeProjectId === projectId) retryPending(threadId)
      }, AUTOMATION_START_RETRY_MS)
      retryTimers.set(key, timer)
    }
    return firstDenial
  }

  async function startThread(threadId: string): Promise<void> {
    const initial = getThreadById(store, threadId)
    const projectId = store.getState().activeProjectId
    if (!projectId) return
    if (!initial || !isPendingAutomation(initial)) {
      clearRetry(projectId, threadId)
      return
    }
    if (starting.has(threadId)) return

    const prompt = initial.draftPrompt?.trim()
    if (!prompt) return
    starting.add(threadId)
    // Whether the transcript is loaded. Appending to an unhydrated thread
    // would persist a truncated history, so the failure note below is written
    // only once this is true.
    let hydrated = false
    let checkoutStarted = false
    try {
      // Threads arrive as metadata only, so an automation can be the first thing
      // to touch a transcript that was never read — on a trigger, or on restart
      // via `startPendingForActiveProject`. Load it before the run streams into
      // it, or the thread renders as a conversation that began mid-sentence.
      // (The agent's own context is unaffected: main reads it from disk.)
      await ensureThreadMessages(projectId, threadId)
      hydrated = true
      if (store.getState().activeProjectId !== projectId) return
      const admission = await api.automations.canStart(projectId, threadId)
      if (!admission.allowed) {
        let shouldRecord = true
        if (admission.retryable) shouldRecord = scheduleRetry(projectId, threadId)
        else clearRetry(projectId, threadId)
        if (shouldRecord) {
          addMessage(
            store,
            threadId,
            'error',
            admission.reason ?? 'This automation run is no longer eligible.',
          )
        }
        if (!admission.retryable) setThreadDraftPrompt(store, threadId, '')
        return
      }
      if (!initial.worktreeChoice) {
        checkoutStarted = true
        const prepared = await api.agent.prepareCheckout(
          projectId,
          threadId,
          prompt,
          'worktree',
          initial.model,
        )
        if (store.getState().activeProjectId !== projectId) return
        applyPreparedThreadCheckout(store, threadId, prepared)
        checkoutStarted = false
      }

      const current = getThreadById(store, threadId)
      if (!current || !isPendingAutomation(current)) {
        clearRetry(projectId, threadId)
        return
      }
      const beforeDispatch = await api.automations.canStart(projectId, threadId)
      if (!beforeDispatch.allowed) {
        let shouldRecord = true
        if (beforeDispatch.retryable) shouldRecord = scheduleRetry(projectId, threadId)
        else clearRetry(projectId, threadId)
        if (shouldRecord) {
          addMessage(
            store,
            threadId,
            'error',
            beforeDispatch.reason ?? 'This automation run is no longer eligible.',
          )
        }
        if (!beforeDispatch.retryable) setThreadDraftPrompt(store, threadId, '')
        return
      }
      clearRetry(projectId, threadId)
      addMessage(store, threadId, 'user', prompt)
      setThreadDraftPrompt(store, threadId, '')
      startAutomationTurnTree(store, threadId)
      dispatchAgentRun(store, api, threadId, { content: prompt })
    } catch (error) {
      // Checkout failures happen before the user bubble is added, so keep the
      // prompt as a draft rather than losing scheduled work. Agent-run failures
      // after dispatch follow the normal controller/error-chunk path.
      console.error('[automations] Failed to start scheduled task:', error)
      // Say so in the thread as well. Without this the run is indistinguishable
      // from one that never fired: the thread sits idle holding its draft, with
      // no bell, no toast and nothing in the UI at all — a failure mode that
      // cost days to see from the outside. A schedule can fire while nobody is
      // watching, so the record has to outlive the moment, which a toast does
      // not.
      if (hydrated) {
        // Without this marker the kept draft counts as a run still waiting to
        // start, and every later trigger of the schedule is skipped behind it.
        const message = startFailureDetail(error)
        const code: AutomationFailureCode = checkoutStarted
          ? 'worktree-failed'
          : classifyAutomationFailureMessage(message)
        markAutomationStartFailed(store, threadId, { code, message })
        // Main keeps the schedule's last problem so the manager shows it with the project
        // closed. Best effort: the thread already carries the durable record.
        api.automations
          .reportStartFailure(projectId, threadId, { code, message })
          .catch((reportError: unknown) => {
            console.error('[automations] Could not report a start failure:', reportError)
          })
        addMessage(
          store,
          threadId,
          'error',
          `This scheduled run could not start: ${startFailureDetail(error)}\n\n` +
            'Its prompt is kept as a draft, so nothing is lost — send it once the ' +
            'cause is resolved. The schedule is not held up: its next run starts normally.',
        )
      }
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
    for (const timer of retryTimers.values()) clearTimeout(timer)
    retryTimers.clear()
    retrying.clear()
    unsubscribeTrigger()
    unsubscribeWorkspace()
  }
}
