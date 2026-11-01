import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { PromptSearchResult } from '@copse/thread-store/prompt-search.ts'
import {
  requestSearchReplySchema,
  type RequestSearchCommand,
} from '@shared/thread-request-search.ts'
import { copseWorkspaceDir } from './storage/copse-paths.ts'

let worker: Worker | undefined
let root: string | undefined
let sequence = 0
const pending = new Map<
  number,
  {
    resolve: (result: PromptSearchResult) => void
    reject: (error: Error) => void
  }
>()
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openedProjects = new Set<string>()

function getWorker(): Worker {
  const nextRoot = copseWorkspaceDir()
  if (worker && root === nextRoot) return worker
  if (worker) void worker.terminate()
  for (const request of pending.values()) request.reject(new Error('Search worker replaced'))
  pending.clear()
  const next = new Worker(join(__dirname, 'thread-request-search-worker.js'), {
    workerData: { root: nextRoot },
  })
  worker = next
  root = nextRoot
  const failed = (error: Error): void => {
    if (worker !== next) return
    worker = undefined
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  next.on('error', failed)
  next.on('exit', () => {
    failed(new Error('Search worker exited'))
  })
  next.on('message', (raw: unknown) => {
    if (worker !== next) return
    const parsed = requestSearchReplySchema.safeParse(raw)
    if (!parsed.success) {
      failed(new Error('Invalid search worker reply'))
      void next.terminate()
      return
    }
    const reply = parsed.data
    const request = pending.get(reply.id)
    pending.delete(reply.id)
    if (reply.error) request?.reject(new Error(reply.error))
    else request?.resolve({ matches: reply.matches, incomplete: reply.incomplete })
  })
  next.unref()
  return next
}

function post(command: RequestSearchCommand): void {
  getWorker().postMessage(command)
}

/** Start/reconcile ahead of typing. Coalesces streaming saves per project. */
export function warmThreadRequestSearch(projectId: string): void {
  openedProjects.add(projectId)
  clearTimeout(refreshTimers.get(projectId))
  const timer = setTimeout(() => {
    refreshTimers.delete(projectId)
    try {
      post({ kind: 'refresh', id: ++sequence, projectId })
    } catch (error) {
      console.warn('[request-search] background indexing failed', error)
    }
  }, 500)
  timer.unref()
  refreshTimers.set(projectId, timer)
}

/** Refresh already opened projects after a write; other projects warm on open. */
export function threadRequestSearchChanged(projectId: string): void {
  if (openedProjects.has(projectId)) warmThreadRequestSearch(projectId)
}

export function searchThreadRequests(
  projectId: string,
  query: string,
): Promise<PromptSearchResult> {
  const currentWorker = getWorker()
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    currentWorker.postMessage({
      kind: 'search',
      id,
      projectId,
      query,
    } satisfies RequestSearchCommand)
  })
}

export function cancelThreadRequestSearch(): void {
  if (worker) worker.postMessage({ kind: 'cancel', id: ++sequence } satisfies RequestSearchCommand)
}
