import { mkdtempSync, promises as fsPromises, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { mock } from 'node:test'
import type { Message, Thread } from '@shared/types'
import {
  appendMessage,
  loadProjectThreads,
  saveProjectThread,
  saveProjectThreads,
} from '../src/main/services/thread-store.ts'

/**
 * Benchmark entry for the filesystem-native thread store (issue #644). Bundled +
 * run by `bench-thread-store.mts`. Seeds N threads x M messages and measures the
 * stable load path (`loadProjectThreads`, cold) plus the Phase-1 bulk-save path.
 * It also measures a steady-state finalized-message append after the per-thread
 * ID cache is warm at small, medium, and large existing spine sizes, including
 * observed spine read/write operations and bytes.
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
  appendSizes: number[]
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
    appendSizes: (
      argv.find((a) => a.startsWith('--append-sizes=')) ?? '--append-sizes=100,1000,10000'
    )
      .slice('--append-sizes='.length)
      .split(',')
      .map(Number),
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

function dataBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (ArrayBuffer.isView(value)) return value.byteLength
  return 0
}

interface AppendMeasurement {
  historyMessages: number
  existingSpineBytes: number
  latencyMs: number
  spineReadOps: number
  spineReadBytes: number
  spineAppendOps: number
  spineAppendBytes: number
  spineRewriteOps: number
  spineRewriteBytes: number
  spineGrowthBytes: number
}

async function measureAppend(
  root: string,
  historyMessages: number,
  resultBytes: number,
): Promise<AppendMeasurement> {
  const projectId = `append-${String(historyMessages)}`
  const threadId = 'history'
  const seededThread = makeThreads(1, historyMessages, resultBytes)[0]
  if (!seededThread) throw new Error('append benchmark failed to create its seed thread')
  const benchmarkThread: Thread = { ...seededThread, id: threadId }
  await saveProjectThread(projectId, benchmarkThread)
  // First append pays the one-time ID-cache seed. Measure the ordinary steady
  // state after that cache is warm; a per-append full read here is the
  // quadratic regression this benchmark exists to expose.
  await appendMessage(projectId, threadId, {
    id: 'warm-cache',
    role: 'user',
    content: 'warm message-id cache',
    toolCalls: [],
    createdAt: historyMessages + 1,
  })
  const eventsPath = join(root, projectId, threadId, 'events.jsonl')
  const existingSpineBytes = statSync(eventsPath).size
  const readSpy = mock.method(fsPromises, 'readFile')
  const appendSpy = mock.method(fsPromises, 'appendFile')
  const writeSpy = mock.method(fsPromises, 'writeFile')
  const started = performance.now()
  await appendMessage(projectId, threadId, {
    id: 'measured-append',
    role: 'user',
    content: 'measured steady-state append',
    toolCalls: [],
    createdAt: historyMessages + 2,
  })
  const latencyMs = performance.now() - started
  mock.restoreAll()
  const finalSpineBytes = statSync(eventsPath).size
  const spineReads = readSpy.mock.calls.filter((call) => call.arguments[0] === eventsPath)
  const spineAppends = appendSpy.mock.calls.filter((call) => call.arguments[0] === eventsPath)
  const spineRewrites = writeSpy.mock.calls.filter((call) => call.arguments[0] === eventsPath)
  return {
    historyMessages,
    existingSpineBytes,
    latencyMs: Math.round(latencyMs * 100) / 100,
    spineReadOps: spineReads.length,
    spineReadBytes: spineReads.length * existingSpineBytes,
    spineAppendOps: spineAppends.length,
    spineAppendBytes: spineAppends.reduce((total, call) => total + dataBytes(call.arguments[1]), 0),
    spineRewriteOps: spineRewrites.length,
    spineRewriteBytes: spineRewrites.reduce(
      (total, call) => total + dataBytes(call.arguments[1]),
      0,
    ),
    spineGrowthBytes: finalSpineBytes - existingSpineBytes,
  }
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
    const appends: AppendMeasurement[] = []
    for (const historyMessages of args.appendSizes) {
      appends.push(await measureAppend(root, historyMessages, args.resultBytes))
    }

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
      appends,
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
    for (const append of appends) {
      console.log(
        `  append ${String(append.historyMessages).padStart(5)} msgs: ${String(append.latencyMs)} ms | existing ${String(append.existingSpineBytes)} B | read ${String(append.spineReadBytes)} B/${String(append.spineReadOps)} op | append ${String(append.spineAppendBytes)} B/${String(append.spineAppendOps)} op | rewrite ${String(append.spineRewriteBytes)} B/${String(append.spineRewriteOps)} op`,
      )
    }
    console.log(`BENCH_JSON ${JSON.stringify(result)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

void main()
