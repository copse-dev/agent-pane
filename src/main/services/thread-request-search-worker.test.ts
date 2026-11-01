import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { configureThreadStore } from '@copse/thread-store/environment.ts'
import { createThread } from '@copse/thread-store/thread-store.ts'
import {
  requestSearchReplySchema,
  type RequestSearchCommand,
  type RequestSearchReply,
} from '@shared/thread-request-search.ts'

describe('request search worker runtime', () => {
  it('indexes prompt-only data off-thread, reuses it on restart, and cancels obsolete backfills', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-search-worker-'))
    const outfile = join(root, 'worker.cjs')
    configureThreadStore({ workspaceRoot: () => join(root, 'workspace') })
    let worker: Worker | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      await build({
        entryPoints: [resolve('src/main/services/thread-request-search-worker.ts')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        alias: { '@shared': resolve('src/shared') },
        logLevel: 'silent',
      })
      for (let i = 0; i < 24; i++) {
        await createThread('p', {
          id: 't-' + String(i),
          title: 'Work',
          status: 'idle',
          createdAt: i,
          updatedAt: i,
          usage: { inputTokens: 0, outputTokens: 0 },
          messages: [
            {
              id: 'u',
              role: 'user',
              content: 'A Café needle request',
              createdAt: i,
              toolCalls: [],
            },
            {
              id: 'a',
              role: 'assistant',
              content: 'other text',
              createdAt: i,
              toolCalls: [
                {
                  id: 'tool',
                  name: 'read_file',
                  args: {},
                  status: 'done',
                  result: 'unrelated output '.repeat(20_000),
                },
              ],
            },
          ],
        })
      }
      const workspace = join(root, 'workspace')
      // Poison every assistant/tool body: the search must not read any of them.
      for (let i = 0; i < 24; i++) {
        const threadDir = join(workspace, 'p', 't-' + String(i))
        writeFileSync(join(threadDir, 'messages/a.md'), 'unreadable assistant format')
        for (const blob of readdirSync(join(threadDir, 'blobs')))
          writeFileSync(join(threadDir, 'blobs', blob), 'broken tool data')
      }
      const run = async (command: RequestSearchCommand): Promise<RequestSearchReply> => {
        assert.ok(worker)
        const reply = new Promise<unknown>((resolveReply, reject) => {
          worker?.once('error', reject)
          worker?.once('message', (value: unknown) => {
            resolveReply(value)
          })
        })
        worker.postMessage(command)
        return requestSearchReplySchema.parse(await reply)
      }
      worker = new Worker(outfile, { workerData: { root: workspace } })
      let ticks = 0
      let maxGap = 0
      let last = performance.now()
      heartbeat = setInterval(() => {
        const now = performance.now()
        maxGap = Math.max(maxGap, now - last)
        last = now
        ticks++
      }, 5)
      const start = performance.now()
      const result = await run({ kind: 'search', id: 1, projectId: 'p', query: 'CAFÉ' })
      clearInterval(heartbeat)
      assert.equal(result.incomplete, false)
      assert.equal(result.matches.length, 24)
      assert.ok(ticks > 0, 'main event loop must keep servicing timers')
      assert.ok(JSON.stringify(result).length < 512, 'only matching IDs cross the worker boundary')
      console.log(
        JSON.stringify({
          phase: 'cold-prompt-index',
          ms: performance.now() - start,
          heartbeatTicks: ticks,
          maxHeartbeatGapMs: maxGap,
        }),
      )
      await worker.terminate()

      // A fresh worker reuses the persistent cache with no prompt bodies available.
      const promptPaths = Array.from({ length: 24 }, (_, i) =>
        join(workspace, 'p', 't-' + String(i), 'messages/u.md'),
      )
      const bodies = promptPaths.map((path) => readFileSync(path))
      for (const path of promptPaths) rmSync(path)
      worker = new Worker(outfile, { workerData: { root: workspace } })
      const warm = await run({ kind: 'search', id: 2, projectId: 'p', query: 'needle' })
      assert.equal(warm.incomplete, false)
      assert.equal(warm.matches.length, 24)
      promptPaths.forEach((path, i) => {
        const body = bodies[i]
        assert.ok(body)
        writeFileSync(path, body)
      })

      // Back-to-back search/cancel must settle the abandoned request with no stale hits.
      const reply = new Promise<unknown>((resolveReply) =>
        worker?.once('message', (value: unknown) => {
          resolveReply(value)
        }),
      )
      worker.postMessage({
        kind: 'search',
        id: 3,
        projectId: 'p',
        query: 'needle',
      } satisfies RequestSearchCommand)
      worker.postMessage({ kind: 'cancel', id: 4 } satisfies RequestSearchCommand)
      assert.deepEqual(requestSearchReplySchema.parse(await reply).matches, [])
    } finally {
      clearInterval(heartbeat)
      await worker?.terminate()
      configureThreadStore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
