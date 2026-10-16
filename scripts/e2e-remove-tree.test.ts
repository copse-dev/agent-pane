import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { removeE2eTree } from '../tests/e2e/helpers/remove-tree.ts'

const tempPaths: string[] = []

function makeProfile(): { profile: string; threadDir: string } {
  const profile = mkdtempSync(join(tmpdir(), 'copse-e2e-remove-tree-'))
  tempPaths.push(profile)
  const threadDir = join(profile, 'workspace', 'project', 'thread')
  mkdirSync(threadDir, { recursive: true })
  for (let i = 0; i < 200; i++) writeFileSync(join(threadDir, `seed-${String(i)}.json`), '{}')
  return { profile, threadDir }
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * Stand in for an app that is still flushing a thread: write new entries into
 * `dir` for a bounded time, stopping as soon as the directory is gone. It never
 * recreates `dir`, so a removal that wins stays won.
 */
async function startThreadWriter(dir: string): Promise<Worker> {
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads')
      const { writeFileSync } = require('node:fs')
      const { join } = require('node:path')
      parentPort.postMessage('started')
      const end = Date.now() + 300
      for (let i = 0; Date.now() < end; i++) {
        try {
          writeFileSync(join(workerData.dir, 'flush-' + i + '.json'), '{}')
        } catch {
          break
        }
      }
    `,
    { eval: true, workerData: { dir } },
  )
  await new Promise((resolve) => worker.once('message', resolve))
  return worker
}

describe('removeE2eTree', () => {
  it('removes a whole profile tree', () => {
    const { profile } = makeProfile()

    removeE2eTree(profile)

    assert.equal(existsSync(profile), false)
  })

  it('treats a missing path as already removed', () => {
    const { profile } = makeProfile()

    assert.doesNotThrow(() => {
      removeE2eTree(join(profile, 'never-created'))
    })
  })

  it('outlasts a writer that is still adding thread files during the delete', async () => {
    // Without retries this interleaving fails the final rmdir with ENOTEMPTY
    // on a meaningful share of runs; the retries must absorb every one.
    for (let attempt = 0; attempt < 5; attempt++) {
      const { profile, threadDir } = makeProfile()
      const writer = await startThreadWriter(threadDir)
      try {
        removeE2eTree(profile)
      } finally {
        await new Promise((resolve) => writer.once('exit', resolve))
      }
      assert.equal(existsSync(profile), false)
    }
  })
})
