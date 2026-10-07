import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import type { Thread } from '@copse/thread-store/thread-types.ts'
import { ThreadPrRelationshipIndex } from '@copse/thread-store/thread-pr-relations.ts'
import { SqliteThreadIndex, THREAD_INDEX_FILE } from '@copse/thread-store/sqlite-thread-index.ts'
import {
  closeThreadStoreIndexes,
  loadProjectThreadMetas,
  loadProjectThreadMetasFromFiles,
  lookupPrThreadRelationships,
  lookupThreadPrRelationships,
  lookupCommitThreadProductions,
  updateMeta,
  loadProjectCatalog,
} from '@copse/thread-store/thread-store.ts'

const sampleSchema = z.object({ ms: z.number(), maxLoopDelayMs: z.number() })
const summarySchema = z.object({
  medianMs: z.number(),
  p95Ms: z.number(),
  maxLoopDelayMs: z.number(),
})
const resultSchema = z.object({
  threads: z.number(),
  backend: z.enum(['files', 'sqlite']),
  mode: z.enum(['main', 'restart']),
  opening: sampleSchema,
  build: sampleSchema.nullable(),
  reopened: sampleSchema,
  warmMetadata: summarySchema,
  warmPr: summarySchema,
  warmThread: summarySchema,
  warmCommit: summarySchema,
  firstWrite: sampleSchema,
  update: summarySchema,
  metadataAfterWrite: sampleSchema,
  pendingRecovery: sampleSchema.nullable(),
  missingRebuild: sampleSchema.nullable(),
  corruptRebuild: sampleSchema.nullable(),
  indexBytes: z.number(),
  heapMiB: z.number(),
  rssMiB: z.number(),
})
type Result = z.infer<typeof resultSchema>
const empty = { ms: 0, maxLoopDelayMs: 0 }

function fixture(count: number): Thread[] {
  const prs = Math.max(1, Math.floor(count / 10))
  return Array.from({ length: count }, (_, i) => {
    const refs = [i, i + 1, i + 2].map((n) => ({
      owner: 'acme',
      repo: 'widgets',
      number: (n % prs) + 1,
      url: `https://github.com/acme/widgets/pull/${String((n % prs) + 1)}`,
    }))
    const pr = refs[0]
    return {
      id: `thread-${String(i).padStart(6, '0')}`,
      title: `Thread ${String(i)} implementing and reviewing widget changes`,
      status: 'idle',
      messages: [],
      usage: { inputTokens: 3000, outputTokens: 2000 },
      createdAt: i + 1,
      updatedAt: i + 2,
      lastPromptAt: i + 1,
      prRefs: refs,
      prProductions:
        pr && i % 10 === 0
          ? [{ pr, eventId: `create-${String(i)}`, source: 'pr-create', createdAt: 1 }]
          : [],
      commitProductions: [
        {
          repository: 'github.com/acme/widgets',
          sha: createHash('sha1').update(String(i)).digest('hex'),
          eventId: `commit-${String(i)}`,
          source: 'git-commit',
          createdAt: 1,
        },
      ],
    }
  })
}

async function measure(operation: () => unknown): Promise<z.infer<typeof sampleSchema>> {
  await pause(0)
  let previous = performance.now()
  let maxLoopDelayMs = 0
  const tick = (): void => {
    const now = performance.now()
    maxLoopDelayMs = Math.max(maxLoopDelayMs, now - previous - 1)
    previous = now
  }
  const timer = setInterval(tick, 1)
  const start = performance.now()
  try {
    await operation()
    const ms = performance.now() - start
    await pause(0)
    return { ms, maxLoopDelayMs }
  } finally {
    clearInterval(timer)
  }
}

async function sample(
  operation: (i: number) => unknown,
  count = 50,
): Promise<z.infer<typeof summarySchema>> {
  for (let i = 0; i < 5; i++) await operation(i)
  const times: number[] = []
  const span = await measure(async () => {
    for (let i = 0; i < count; i++) {
      const start = performance.now()
      await operation(i)
      times.push(performance.now() - start)
    }
  })
  times.sort((a, b) => a - b)
  return {
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    p95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
    maxLoopDelayMs: span.maxLoopDelayMs,
  }
}

async function worker(
  root: string,
  count: number,
  backend: Result['backend'],
  mode: Result['mode'],
): Promise<Result> {
  configureThreadStore({ workspaceRoot: () => root })
  const first = fixture(count)[0]
  const pr = first?.prRefs?.[0]
  const commit = first?.commitProductions?.[0]
  assert.ok(first && pr && commit)
  const dbPath = join(root, 'p', THREAD_INDEX_FILE)
  if (mode === 'main' && backend === 'sqlite')
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
  let metas: Thread[] = []
  let relations = new ThreadPrRelationshipIndex()
  const open = async (): Promise<void> => {
    metas =
      backend === 'sqlite'
        ? await loadProjectThreadMetas('p')
        : await loadProjectThreadMetasFromFiles('p')
    if (backend === 'files') relations = new ThreadPrRelationshipIndex(metas)
    assert.equal(metas.length, count)
    const links =
      backend === 'sqlite' ? await lookupPrThreadRelationships('p', pr) : relations.forPr(pr)
    assert.equal(links.length, 30)
  }
  const opening = await measure(open)
  const build = backend === 'sqlite' && mode === 'main' ? opening : null
  closeThreadStoreIndexes()
  const reopened = await measure(open)
  const warmMetadata = await sample(() =>
    backend === 'sqlite' ? loadProjectThreadMetas('p') : metas,
  )
  const warmPr = await sample(() =>
    backend === 'sqlite' ? lookupPrThreadRelationships('p', pr) : relations.forPr(pr),
  )
  const warmThread = await sample(() =>
    backend === 'sqlite'
      ? lookupThreadPrRelationships('p', first.id)
      : relations.forThread(first.id),
  )
  const warmCommit = await sample(() =>
    backend === 'sqlite'
      ? lookupCommitThreadProductions('p', commit.repository, commit.sha)
      : relations.forCommit(commit.repository, commit.sha),
  )
  global.gc?.()
  const before = process.memoryUsage()
  if (mode === 'restart') {
    closeThreadStoreIndexes()
    return {
      threads: count,
      backend,
      mode,
      opening,
      build,
      reopened,
      warmMetadata,
      warmPr,
      warmThread,
      warmCommit,
      firstWrite: empty,
      update: { medianMs: 0, p95Ms: 0, maxLoopDelayMs: 0 },
      metadataAfterWrite: empty,
      pendingRecovery: null,
      missingRebuild: null,
      corruptRebuild: null,
      indexBytes: 0,
      heapMiB: before.heapUsed / 2 ** 20,
      rssMiB: before.rss / 2 ** 20,
    }
  }
  const change = async (i: number): Promise<void> => {
    await updateMeta('p', first.id, { title: `Profile updated ${String(i)}` })
    if (backend === 'files') {
      const changed = { ...first, title: `Profile updated ${String(i)}` }
      relations.upsert(changed)
    }
  }
  const firstWrite = await measure(() => change(0))
  const update = await sample(change, 20)
  const metadataAfterWrite = await measure(async () => {
    const rows =
      backend === 'sqlite'
        ? await loadProjectThreadMetas('p')
        : await loadProjectThreadMetasFromFiles('p')
    assert.equal(rows.find((row) => row.id === first.id)?.title, 'Profile updated 19')
  })
  let pendingRecovery: Result['pendingRecovery'] = null
  let missingRebuild: Result['missingRebuild'] = null
  let corruptRebuild: Result['corruptRebuild'] = null
  if (backend === 'sqlite') {
    closeThreadStoreIndexes()
    const index = new SqliteThreadIndex(dbPath)
    index.markPending(first.id)
    index.close()
    const { messages: _messages, ...meta } = { ...first, title: 'Interrupted update' }
    writeFileSync(join(root, 'p', first.id, 'meta.json'), JSON.stringify(meta))
    pendingRecovery = await measure(async () => {
      const rows = await lookupPrThreadRelationships('p', pr)
      assert.equal(rows.find((row) => row.threadId === first.id)?.title, 'Interrupted update')
    })
    closeThreadStoreIndexes()
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true })
    missingRebuild = await measure(open)
    closeThreadStoreIndexes()
    writeFileSync(dbPath, 'corrupt projection')
    corruptRebuild = await measure(open)
  }
  let indexBytes = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      indexBytes += statSync(`${dbPath}${suffix}`).size
    } catch {
      /* No SQL artifacts in the file baseline. */
    }
  }
  closeThreadStoreIndexes()
  return {
    threads: count,
    backend,
    mode,
    opening,
    build,
    reopened,
    warmMetadata,
    warmPr,
    warmThread,
    warmCommit,
    firstWrite,
    update,
    metadataAfterWrite,
    pendingRecovery,
    missingRebuild,
    corruptRebuild,
    indexBytes,
    heapMiB: before.heapUsed / 2 ** 20,
    rssMiB: before.rss / 2 ** 20,
  }
}

if (process.argv[2] === '--worker') {
  const root = process.argv[3]
  const count = Number(process.argv[4])
  const backend = process.argv[5]
  const mode = process.argv[6]
  assert.ok(root && Number.isSafeInteger(count) && count >= 100)
  assert.ok(backend === 'files' || backend === 'sqlite')
  assert.ok(mode === 'main' || mode === 'restart')
  console.log(JSON.stringify(await worker(root, count, backend, mode)))
} else {
  const root = mkdtempSync(join(tmpdir(), 'copse-integrated-index-profile-'))
  const sizes = (process.env['COPSE_PROFILE_SIZES'] ?? '100,1000,10000').split(',').map(Number)
  const results: Result[] = []
  try {
    for (const count of sizes)
      for (const backend of ['files', 'sqlite'] as const) {
        const store = join(root, `${backend}-${String(count)}`)
        const threads = fixture(count)
        for (const thread of threads) {
          const dir = join(store, 'p', thread.id)
          mkdirSync(dir, { recursive: true })
          const { messages: _messages, ...meta } = thread
          writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
          writeFileSync(join(dir, 'events.jsonl'), '{"type":"profile-fixture"}\n')
        }
        configureThreadStore({ workspaceRoot: () => store })
        await loadProjectCatalog('p')
        closeThreadStoreIndexes()
        for (const mode of ['main', 'restart', 'restart', 'restart'] as const) {
          const result = spawnSync(
            process.execPath,
            [
              '--expose-gc',
              fileURLToPath(import.meta.url),
              '--worker',
              store,
              String(count),
              backend,
              mode,
            ],
            { encoding: 'utf8', timeout: 120000 },
          )
          if (result.status !== 0)
            throw new Error(`Profile worker failed: ${result.stderr}\n${result.stdout}`)
          const parsed = safeJsonParse(result.stdout.trim(), decodeWithSchema(resultSchema))
          assert.ok(parsed, result.stdout)
          results.push(parsed)
          console.error(`${backend} ${String(count)} ${mode}: ${parsed.opening.ms.toFixed(1)}ms`)
        }
      }
    const report = {
      node: process.versions.node,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      methodology:
        'One initial build and three fresh-process restarts per backend/size; warm OS page cache. Actual native APIs; file baseline uses the same source reader plus the preceding Map index. File warm metadata uses its retained array. Loop delay is a 1ms timer; IPC/render/network excluded. Timings are local container measurements, not end-user guarantees.',
      results,
    }
    const output = process.argv[2] ?? 'docs/spikes/thread-sqlite-index-benchmark.json'
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(output)
  } finally {
    closeThreadStoreIndexes()
    configureThreadStore()
    rmSync(root, { recursive: true, force: true })
  }
}
