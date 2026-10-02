import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentHost } from '@copse/agent/agent-host.ts'
import type { StreamChunk } from '@shared/types'
import type { CanvasArtefactReference } from '@shared/types/canvas.ts'

interface InlineCanvasRun {
  threadId: string
  pending: CanvasArtefactReference[]
  closed: boolean
}
const runs = new AsyncLocalStorage<InlineCanvasRun>()

/** Only the owning foreground run can put a card in its assistant reply. */
export function queueInlineCanvasReference(threadId: string, title: string): boolean {
  const run = runs.getStore()
  if (!run || run.closed || run.threadId !== threadId) return false
  run.pending.push({ title })
  return true
}

/**
 * Publish references immediately before completion, once the reply has stopped
 * streaming. Mounting a guest earlier races transcript replacement. Works for local
 * and ACP executors without a provider-specific text control frame.
 */
export function runWithInlineCanvas<T>(
  threadId: string,
  host: AgentHost<StreamChunk>,
  run: (host: AgentHost<StreamChunk>) => T,
): T {
  const context: InlineCanvasRun = { threadId, pending: [], closed: false }
  return runs.run(context, () =>
    run({
      emit(id, chunk) {
        if (id === threadId && chunk.type === 'done') {
          for (const artefact of context.pending.splice(0)) {
            host.emit(id, { type: 'canvas_artefact', artefact })
          }
        }
        if (id === threadId && chunk.type === 'done') context.closed = true
        host.emit(id, chunk)
      },
    }),
  )
}

/** Rebind just this run's card queue at an external ACP bridge request boundary. */
export function captureInlineCanvasScope(): <T>(action: () => T) => T {
  const context = runs.getStore()
  return (action) => (context ? runs.run(context, action) : action())
}
