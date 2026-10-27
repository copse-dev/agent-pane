import type { ApiClient } from '../../preload/api.d.ts'
import type { ClientActionOffer } from '@shared/client-actions.ts'

export interface OfferedClientAction {
  id: string
  label: string
  kind: 'next-step' | 'follow-up'
  run: () => void
}

/** Publish the actual desktop choices; invocation rechecks the live UI before acting. */
export function mountClientActionOffers(
  api: ApiClient,
  read: () => {
    projectId: string
    threadId: string
    turnKey: string
    actions: OfferedClientAction[]
  } | null,
  composerRoot: HTMLElement = document.body,
): { refresh: () => void; destroy: () => void } {
  let current: ClientActionOffer | null = null
  let fingerprint = ''
  let destroyed = false
  function refresh(): void {
    if (destroyed) return
    const next = read()
    const actions =
      next?.actions.slice(0, 8).map(({ id, label, kind }) => ({ id, label, kind })) ?? []
    const key = JSON.stringify(next && actions.length ? { ...next, actions } : null)
    if (key === fingerprint) return
    fingerprint = key
    current =
      next && actions.length
        ? {
            projectId: next.projectId,
            threadId: next.threadId,
            revision: crypto.randomUUID(),
            actions,
          }
        : null
    void api.clientActions.publish(current).catch(() => {})
  }
  const unsubscribe = api.clientActions.onInvoke((command) => {
    void (async (): Promise<void> => {
      let accepted = false
      try {
        if (await api.clientActions.claim(command.id)) {
          refresh()
          const next = read()
          const action = next?.actions.find((candidate) => candidate.id === command.actionId)
          if (
            action &&
            current &&
            command.expiresAt > Date.now() &&
            current.projectId === command.projectId &&
            current.threadId === command.threadId &&
            current.revision === command.revision
          ) {
            current = null
            fingerprint = ''
            void api.clientActions.publish(null).catch(() => {})
            action.run()
            accepted = true
            refresh()
          }
        }
      } finally {
        if (!accepted) {
          // The host consumes before dispatch. If delivery expires or the claim fails,
          // republish the current UI instead of leaving its unchanged choices stranded.
          fingerprint = ''
          refresh()
        }
        await api.clientActions.reply(command.id, accepted)
      }
    })().catch(() => {})
  })
  // Opening Settings or an approval withdraws the offer even without a thread event.
  const observer = new MutationObserver(refresh)
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open'] })
  const composerObserver = new MutationObserver(refresh)
  composerObserver.observe(composerRoot, { childList: true, subtree: true })
  refresh()
  return {
    refresh,
    destroy: (): void => {
      destroyed = true
      observer.disconnect()
      composerObserver.disconnect()
      unsubscribe()
      void api.clientActions.publish(null).catch(() => {})
    },
  }
}
