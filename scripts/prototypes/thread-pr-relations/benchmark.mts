import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir, cpus } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import {
  ThreadPrRelationshipIndex,
  type RelationshipThread,
} from '@copse/thread-store/thread-pr-relations.ts'
import {
  loadProjectThreadMetas,
  lookupPrThreadRelationships,
} from '@copse/thread-store/thread-store.ts'
import { SqlitePrRelationshipIndex, projectionSchema } from './sqlite-index.mts'

const statsSchema = z.object({ medianMs: z.number(), p95Ms: z.number() })
const resultSchema = z.object({
  threads: z.number(),
  backend: z.enum(['files', 'sqlite']),
  sourceMetadataLoadMs: z.number(),
  firstNativePrQueryMs: z.number(),
  cacheBuildMs: z.number(),
  recovery: statsSchema,
  warmPr: statsSchema,
  warmThread: statsSchema,
  warmCommit: statsSchema,
  incrementalUpdate: statsSchema,
  heapMiB: z.number(),
  rssMiB: z.number(),
  indexBytes: z.number(),
})
type Result = z.infer<typeof resultSchema>

function stats(samples: number[]): z.infer<typeof statsSchema> {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
  }
}
function sample(operation: () => unknown, count = 300, warmup = 50): z.infer<typeof statsSchema> {
  for (let i = 0; i < warmup; i++) operation()
  const times: number[] = []
  for (let i = 0; i < count; i++) {
    const start = performance.now()
    operation()
    times.push(performance.now() - start)
  }
  return stats(times)
}
function fixture(count: number): RelationshipThread[] {
  const prs = Math.max(1, Math.floor(count / 10))
  return Array.from({ length: count }, (_, i) => {
    const numbers = [...new Set([(i % prs) + 1, ((i + 1) % prs) + 1, ((i + 2) % prs) + 1])]
    const refs = numbers.map((number) => ({
      owner: 'acme',
      repo: 'widgets',
      number,
      url: `https://github.com/acme/widgets/pull/${String(number)}`,
    }))
    const first = refs[0]
    return {
      id: `thread-${String(i).padStart(6, '0')}`,
      title: `Thread ${String(i)} implementing and reviewing widget changes`,
      prRefs: refs,
      prProductions:
        first && i % 10 === 0
          ? [{ pr: first, eventId: `create-${String(i)}`, source: 'pr-create', createdAt: 1 }]
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

async function worker(count: number, backend: 'files' | 'sqlite'): Promise<Result> {
  const root = mkdtempSync(join(tmpdir(), 'copse-pr-index-bench-'))
  const previous = process.env['COPSE_WORKSPACE_DIR']
  process.env['COPSE_WORKSPACE_DIR'] = root
  let sql: SqlitePrRelationshipIndex | null = null
  try {
    const threads = fixture(count)
    const target = threads[0]
    const pr = target?.prRefs?.[0]
    const commit = target?.commitProductions?.[0]
    if (!target || !pr || !commit) throw new Error('Missing benchmark fixture')
    const snapshot = join(root, 'relationships.jsonl')
    const dbPath = join(root, 'relationships.sqlite')
    writeFileSync(snapshot, threads.map((thread) => JSON.stringify(thread)).join('\n'))
    for (const thread of threads) {
      const dir = join(root, 'bench', thread.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'meta.json'),
        JSON.stringify({
          ...thread,
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: 1,
          updatedAt: 1,
        }),
      )
    }
    // Seed in a separate process so SQLite's allocator does not pre-warm this
    // worker's RSS before measuring the cache's incremental memory.
    const seed = spawnSync(
      process.execPath,
      [import.meta.filename, '--seed', dbPath, String(count)],
      { encoding: 'utf8' },
    )
    if (seed.status !== 0) throw new Error(seed.stderr || 'SQLite seed failed')
    const sourceStart = performance.now()
    await loadProjectThreadMetas('bench', { includeArchived: false })
    const sourceMetadataLoadMs = performance.now() - sourceStart
    const firstStart = performance.now()
    await lookupPrThreadRelationships('bench', pr)
    const firstNativePrQueryMs = performance.now() - firstStart

    global.gc?.()
    const baseline = process.memoryUsage()
    const buildStart = performance.now()
    const index =
      backend === 'files'
        ? new ThreadPrRelationshipIndex(threads)
        : new SqlitePrRelationshipIndex(dbPath)
    if (index instanceof SqlitePrRelationshipIndex) sql = index
    const cacheBuildMs = performance.now() - buildStart
    global.gc?.()
    const indexed = process.memoryUsage()
    const reference = new ThreadPrRelationshipIndex(threads)
    assert.deepEqual(index.forPr(pr), reference.forPr(pr))
    assert.deepEqual(index.forThread(target.id), reference.forThread(target.id))
    assert.deepEqual(
      index.forCommit(commit.repository, commit.sha),
      reference.forCommit(commit.repository, commit.sha),
    )
    const warmPr = sample(() => index.forPr(pr))
    const warmThread = sample(() => index.forThread(target.id))
    const warmCommit = sample(() => index.forCommit(commit.repository, commit.sha))
    let update = 0
    const incrementalUpdate = sample(() => {
      index.upsert({ ...target, title: `Updated ${String(update++)}` })
    }, 100)
    const recovery = sample(
      () => {
        if (backend === 'files') {
          const decoded = readFileSync(snapshot, 'utf8')
            .split('\n')
            .map((line) => {
              const parsed = safeJsonParse(line, decodeWithSchema(projectionSchema))
              if (!parsed) throw new Error('Invalid snapshot')
              return parsed
            })
          return new ThreadPrRelationshipIndex(decoded).forPr(pr)
        }
        const reopened = new SqlitePrRelationshipIndex(dbPath)
        try {
          return reopened.forPr(pr)
        } finally {
          reopened.close()
        }
      },
      7,
      0,
    )
    return {
      threads: count,
      backend,
      sourceMetadataLoadMs,
      firstNativePrQueryMs,
      cacheBuildMs,
      recovery,
      warmPr,
      warmThread,
      warmCommit,
      incrementalUpdate,
      heapMiB: (indexed.heapUsed - baseline.heapUsed) / 1024 / 1024,
      rssMiB: (indexed.rss - baseline.rss) / 1024 / 1024,
      indexBytes: statSync(backend === 'files' ? snapshot : dbPath).size,
    }
  } finally {
    sql?.close()
    if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
    else process.env['COPSE_WORKSPACE_DIR'] = previous
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--seed') {
  const path = process.argv[3]
  if (!path) throw new Error('Missing SQLite path')
  const db = new SqlitePrRelationshipIndex(path)
  try {
    db.replaceAll(fixture(z.coerce.number().int().positive().parse(process.argv[4])))
  } finally {
    db.close()
  }
} else if (process.argv[2] === '--worker') {
  const count = z.coerce.number().int().positive().parse(process.argv[3])
  const backend = z.enum(['files', 'sqlite']).parse(process.argv[4])
  console.log(JSON.stringify(await worker(count, backend)))
} else {
  const sizes = [100, 1_000, 10_000]
  const results: Result[] = []
  for (const size of sizes)
    for (const backend of ['files', 'sqlite']) {
      const run = spawnSync(
        process.execPath,
        ['--expose-gc', import.meta.filename, '--worker', String(size), backend],
        { encoding: 'utf8' },
      )
      if (run.status !== 0) throw new Error(run.stderr || 'Benchmark worker failed')
      const result = safeJsonParse(run.stdout, decodeWithSchema(resultSchema))
      if (!result) throw new Error('Invalid benchmark result')
      results.push(result)
    }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        cpu: cpus()[0]?.model,
        design:
          'Synthetic 3 references and 1 commit per thread; 10% PR creation events; ~30 threads per PR. Separate workers, same payloads, semantic parity asserted. OS page cache is warm, not an evicted-disk benchmark.',
        budgets: {
          warmLookupP95Ms: 1,
          updateP95Ms: 16,
          cachedMetadataFirstQueryMs: 100,
          indexHeapMiBAt10000: 20,
        },
        notes:
          'Files: actual native metadata load/first lookup plus pure map cache. Recovery also evaluates an optional JSONL projection checkpoint; the app currently has no persisted relationship checkpoint. SQLite is a rebuildable projection candidate with cached prepared statements. Memory is the incremental cache after metadata/native index load, not total app memory; RSS deltas depend on allocator reuse. Source writes, provider latency, renderer paint and IPC are excluded from lookup metrics. Heap alone is not total SQLite memory.',
        results,
      },
      null,
      2,
    ),
  )
}
