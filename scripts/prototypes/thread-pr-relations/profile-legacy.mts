import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import type { Thread } from '@copse/thread-store/thread-types.ts'
import {
  closeThreadStoreIndexes,
  loadProjectThreadMetas,
  lookupPrThreadRelationships,
  lookupThreadPrRelationships,
  saveProjectThreads,
} from '@copse/thread-store/thread-store.ts'

async function measure<T>(operation: () => Promise<T>): Promise<{
  value: T
  ms: number
  maxLoopDelayMs: number
  timerTicks: number
}> {
  await pause(0)
  let last = performance.now()
  let maxLoopDelayMs = 0
  let timerTicks = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxLoopDelayMs = Math.max(maxLoopDelayMs, now - last - 1)
    last = now
    timerTicks++
  }, 1)
  const started = performance.now()
  try {
    const value = await operation()
    const ms = performance.now() - started
    await pause(0)
    return { value, ms, maxLoopDelayMs, timerTicks }
  } finally {
    clearInterval(timer)
  }
}

const pr = {
  owner: 'acme',
  repo: 'widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
}
const root = mkdtempSync(join(tmpdir(), 'thread-pr-legacy-profile-'))
const counts = (process.env['COPSE_PROFILE_SIZES'] ?? '1000,5000').split(',').map(Number)
const results = []
try {
  configureThreadStore({ workspaceRoot: () => root })
  for (const count of counts) {
    assert.ok(Number.isSafeInteger(count) && count >= 1000)
    const projectId = `legacy-${String(count)}`
    const threads: Thread[] = Array.from({ length: count }, (_, i) => ({
      id: `thread-${String(i).padStart(6, '0')}`,
      title: `Legacy chat ${String(i)}`,
      status: 'idle',
      messages: [
        {
          id: `message-${String(i)}`,
          role: 'user',
          content:
            i % 10 === 0
              ? `Review ${pr.url} and https://github.com/acme/widgets/pull/55.\n${'Project context. '.repeat(64)}`
              : `Legacy discussion without a pull request.\n${'Project context. '.repeat(64)}`,
          toolCalls: [],
          createdAt: i + 1,
        },
      ],
      usage: { inputTokens: 0, outputTokens: 0 },
      createdAt: i + 1,
      updatedAt: i + 1,
    }))
    // Bulk persistence preserves legacy metadata without a prRefs scan marker.
    await saveProjectThreads(projectId, threads)
    closeThreadStoreIndexes()
    const opening = await measure(() => loadProjectThreadMetas(projectId))
    assert.equal(opening.value.filter((thread) => thread.prRefs === undefined).length, count)
    const first = await measure(() => lookupPrThreadRelationships(projectId, pr))
    assert.equal(first.value.length, Math.ceil(count / 10))
    assert.ok(first.value.every((row) => row.kinds.length === 1 && row.kinds[0] === 'referenced'))
    assert.ok(
      first.value.some((row) => row.threadId === `thread-${String(count - 10).padStart(6, '0')}`),
    )
    const reverse = await lookupThreadPrRelationships(projectId, 'thread-000000')
    assert.deepEqual(
      reverse.map((row) => row.pr.number).sort((a, b) => a - b),
      [42, 55],
    )
    const scanned = await loadProjectThreadMetas(projectId)
    assert.ok(scanned.every((thread) => thread.prRefs !== undefined))
    const warm = []
    for (let sample = 0; sample < 30; sample++) {
      const timing = await measure(() => lookupPrThreadRelationships(projectId, pr))
      assert.deepEqual(timing.value, first.value)
      warm.push(timing.ms)
    }
    warm.sort((a, b) => a - b)
    closeThreadStoreIndexes()
    const reopened = await measure(() => lookupPrThreadRelationships(projectId, pr))
    assert.deepEqual(reopened.value, first.value)
    results.push({
      threads: count,
      transcriptBytesPerChat: threads[0]?.messages[0]?.content.length,
      references: first.value.length,
      openingMs: opening.ms,
      firstLookupMs: first.ms,
      firstLookupMaxLoopDelayMs: first.maxLoopDelayMs,
      firstLookupTimerTicks: first.timerTicks,
      warmMedianMs: warm[15],
      warmP95Ms: warm[28],
      reopenedLookupMs: reopened.ms,
      reopenedMaxLoopDelayMs: reopened.maxLoopDelayMs,
    })
    console.error(JSON.stringify(results.at(-1)))
  }
  const output = process.argv[2] ?? 'docs/spikes/thread-pr-legacy-benchmark.json'
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        node: process.versions.node,
        platform: process.platform,
        cpu: cpus()[0]?.model,
        methodology:
          'Real native store APIs; unscanned transcript files, including empty references and offscreen matches. One first lookup and 30 warm samples per size; reopened handles in the same process and warm OS cache. A 1ms timer measures main-module event-loop delay; IPC, renderer, networking and full process restart are excluded. Fixture persistence is excluded.',
        results,
      },
      null,
      2,
    )}\n`,
  )
  console.log(output)
} finally {
  closeThreadStoreIndexes()
  configureThreadStore()
  rmSync(root, { recursive: true, force: true })
}
