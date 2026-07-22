import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Thread } from '@shared/types'
import type { ShareTraceResult } from '@shared/types/git.ts'
import { threadHasExportableContent } from '@shared/threads/export-jsonl.ts'
import { isMockGhEnabled } from './gh-pr-mock.ts'
import {
  buildShareTracePackage,
  SHARE_TRACE_MAX_TOTAL_BYTES,
  shareTraceTotalBytes,
  type ShareTraceStoreFiles,
} from './share-trace-files.ts'
import { createShareTracePullRequest } from './share-trace-github.ts'
import { getThreadStoreDir } from '../thread-store.ts'

export type ShareTracePublisher = typeof createShareTracePullRequest

let publisher: ShareTracePublisher = createShareTracePullRequest
let inflight = false

/** Test seam: swap the GitHub publisher (or restore with `undefined`). */
export function setShareTracePublisherForTest(next?: ShareTracePublisher): void {
  publisher = next ?? createShareTracePullRequest
}

function readOptionalUtf8(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Load on-disk spine files for a thread when the store directory exists. */
export function loadShareTraceStoreFiles(
  projectId: string,
  threadId: string,
): ShareTraceStoreFiles {
  const dir = getThreadStoreDir(projectId, threadId)
  const store: ShareTraceStoreFiles = {}
  const eventsJsonl = readOptionalUtf8(join(dir, 'events.jsonl'))
  if (eventsJsonl !== undefined) store.eventsJsonl = eventsJsonl
  const metaJson = readOptionalUtf8(join(dir, 'meta.json'))
  if (metaJson !== undefined) store.metaJson = metaJson
  return store
}

function mockShareResult(branch: string): ShareTraceResult {
  const result: ShareTraceResult = {
    ok: true,
    message: 'Opened mock share-trace PR #9001 (COPSE_PANEL_MOCK_GH=1).',
    prUrl: 'https://github.com/copse-dev/agent-pane/pull/9001',
    prNumber: 9001,
    branch,
  }
  return result
}

/**
 * Package the active thread as JSONL (+ optional on-disk spine files) and open a
 * draft PR against `copse-dev/agent-pane` under `debug-traces/`.
 */
export async function shareThreadTrace(
  projectId: string,
  thread: Thread,
): Promise<ShareTraceResult> {
  if (!threadHasExportableContent(thread)) {
    return { ok: false, message: 'Nothing to share — the thread has no messages yet.' }
  }
  if (inflight) {
    return { ok: false, message: 'A share-trace upload is already in progress.' }
  }

  inflight = true
  try {
    const store = loadShareTraceStoreFiles(projectId, thread.id)
    const pkg = buildShareTracePackage(thread, store)
    const totalBytes = shareTraceTotalBytes(pkg.files)
    if (totalBytes > SHARE_TRACE_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        message: `Share trace is too large (${String(Math.ceil(totalBytes / (1024 * 1024)))} MiB). Export JSONL locally instead.`,
      }
    }

    if (isMockGhEnabled()) {
      return mockShareResult(pkg.branch)
    }

    const created = await publisher({
      branch: pkg.branch,
      title: pkg.title,
      body: pkg.body,
      files: pkg.files,
    })
    const result: ShareTraceResult = {
      ok: true,
      message: `Opened share-trace PR #${String(created.prNumber)}.`,
      prUrl: created.prUrl,
      prNumber: created.prNumber,
      branch: created.branch,
    }
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message }
  } finally {
    inflight = false
  }
}
