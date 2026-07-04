import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Message, Thread } from '@shared/types'
import { loadProjectThreads, saveProjectThreads } from '../src/main/services/thread-store.ts'

/**
 * Benchmark entry for the filesystem-native thread store (issue #644). Bundled +
 * run by `bench-thread-store.mts`. Seeds N threads x M messages and measures the
 * stable load path (`loadProjectThreads`, cold) plus the Phase-1 bulk-save path.
 *
 * Load is the number that matters: it is the tripwire for the deferred snapshot
 * cache (Phase 6). The save path is the throwaway whole-thread rewrite that
 * Phase 2 replaces with append-on-finalize, so treat its number as an upper
 * bound, not the design's steady state.
 */

interface Args {
  threads: number
  messages: number
  resultBytes: number
  iters: number
}

function parseArgs(argv: string[]): Args {
  const get = (name: string, fallback: number): number => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`))
    return hit ? Number(hit.slice(name.length + 3)) : fallback
  }
  return {
    threads: get('threads', 200),
    messages: get('messages', 100),
    resultBytes: get('result-bytes', 1500),
    iters: get('iters', 5),
  }
}

function makeMessages(threadId: string, count: number, resultBytes: number): Message[] {
  const result = 'x'.repeat(resultBytes)
  const messages: Message[] = []
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      messages.push({
        id: `${threadId}-u${String(i)}`,
        role: 'user',
        content: `question ${String(i)}`,
        toolCalls: [],
        createdAt: i,
      })
    } else {
      messages.push({
        id: `${threadId}-a${String(i)}`,
        role: 'assistant',
        content: `Here is a fairly typical assistant reply for turn ${String(i)}.`,
        toolCalls: [
          {
            id: `${threadId}-a${String(i)}-tc`,
            name: 'read_file',
            args: { path: `src/file${String(i)}.ts` },
            status: 'done',
            result,
          },
        ],
        createdAt: i,
      })
    }
  }
  return messages
}

function makeThreads(n: number, messages: number, resultBytes: number): Thread[] {
  const threads: Thread[] = []
  for (let i = 0; i < n; i++) {
    const id = `t${String(i)}`
    threads.push({
      id,
      title: `Thread ${String(i)}`,
      status: 'idle',
      messages: makeMessages(id, messages, resultBytes),
      usage: { inputTokens: 1000, outputTokens: 2000 },
      createdAt: i,
      updatedAt: i,
    })
  }
  return threads
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx] ?? 0
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const root = mkdtempSync(join(tmpdir(), 'copse-bench-'))
  process.env['COPSE_WORKSPACE_DIR'] = root

  try {
    const threads = makeThreads(args.threads, args.messages, args.resultBytes)
    const totalMessages = args.threads * args.messages

    const t0 = performance.now()
    await saveProjectThreads('bench', threads)
    const saveMs = performance.now() - t0

    const loads: number[] = []
    for (let i = 0; i < args.iters; i++) {
      const s = performance.now()
      const loaded = await loadProjectThreads('bench')
      const ms = performance.now() - s
      if (loaded.length !== args.threads) {
        throw new Error(
          `load returned ${String(loaded.length)} threads, expected ${String(args.threads)}`,
        )
      }
      loads.push(ms)
    }
    loads.sort((a, b) => a - b)

    const result = {
      params: args,
      totalMessages,
      bulkSaveMs: Math.round(saveMs),
      loadMs: {
        min: Math.round(loads[0] ?? 0),
        p50: Math.round(pct(loads, 50)),
        p95: Math.round(pct(loads, 95)),
        max: Math.round(loads[loads.length - 1] ?? 0),
      },
    }
    console.log(
      `threads=${String(args.threads)} messages/thread=${String(args.messages)} result-bytes=${String(args.resultBytes)} (${String(totalMessages)} messages total)`,
    )
    console.log(
      `  bulk save : ${String(result.bulkSaveMs)} ms (Phase-1 whole-thread rewrite; upper bound)`,
    )
    console.log(
      `  cold load : p50 ${String(result.loadMs.p50)} ms | p95 ${String(result.loadMs.p95)} ms | min ${String(result.loadMs.min)} | max ${String(result.loadMs.max)} (n=${String(args.iters)})`,
    )
    console.log(`BENCH_JSON ${JSON.stringify(result)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void main()
