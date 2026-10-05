// Spike measurement for the side_chats and links tables of the SQLite thread
// projection (docs/spikes/side-chats-and-links.md). Synthetic: every thread has five
// web links drawn from a pool of 2,000 URLs, and one in ten threads is a side chat.
//
//   node scripts/prototypes/side-chats-links/bench-links.mts [threads]
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { SqliteThreadIndex } from '@copse/thread-store/sqlite-thread-index.ts'
import type { Thread } from '@copse/thread-store/thread-types.ts'

const count = Number(process.argv[2] ?? 10_000)
const urlPool = 2_000

function synthetic(i: number): Thread {
  return {
    id: `t${String(i)}`,
    title: `Thread ${String(i)}`,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    prRefs: [],
    createdAt: i,
    updatedAt: i,
    ...(i % 10 === 9
      ? { sideChat: { parentThreadId: `t${String(i - 1)}`, anchorMessageId: 'm' } }
      : {}),
    links: [0, 1, 2, 3, 4].map((k) => ({
      kind: 'url' as const,
      target: `https://example.test/${String((i * 7 + k * 13) % urlPool)}`,
    })),
  }
}

function sample(fn: () => unknown, runs = 300): { median: number; p95: number } {
  const ms: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    fn()
    ms.push(performance.now() - start)
  }
  ms.sort((a, b) => a - b)
  return { median: ms[Math.floor(runs / 2)] ?? 0, p95: ms[Math.floor(runs * 0.95)] ?? 0 }
}

const dir = mkdtempSync(join(tmpdir(), 'bench-links-'))
const path = join(dir, '.thread-index.sqlite')
const index = new SqliteThreadIndex(path)
try {
  const threads = Array.from({ length: count }, (_, i) => synthetic(i))
  const start = performance.now()
  await index.replaceAll(threads)
  const buildMs = performance.now() - start
  const backlinks = sample(() =>
    index.backlinks('url', `https://example.test/${String(Math.floor(Math.random() * urlPool))}`),
  )
  const sideChats = sample(() =>
    index.sideChatsOf(`t${String(Math.floor((Math.random() * count) / 10) * 10 + 8)}`),
  )
  const links = sample(() => index.linksOf(`t${String(Math.floor(Math.random() * count))}`))
  console.log(
    JSON.stringify({
      threads: count,
      buildMs: Math.round(buildMs),
      indexMiB: Number((statSync(path).size / 1_048_576).toFixed(1)),
      backlinksMedianMs: Number(backlinks.median.toFixed(3)),
      backlinksP95Ms: Number(backlinks.p95.toFixed(3)),
      sideChatsMedianMs: Number(sideChats.median.toFixed(3)),
      linksOfMedianMs: Number(links.median.toFixed(3)),
    }),
  )
} finally {
  index.close()
  rmSync(dir, { recursive: true, force: true })
}
