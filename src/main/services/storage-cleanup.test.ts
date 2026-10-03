import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, utimes, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StorageCleanup } from './storage-cleanup.ts'

async function fixture(
  run: (root: string, cleanup: StorageCleanup) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'copse-storage-cleanup-'))
  try {
    await run(root, new StorageCleanup(root, join(root, 'workspace/tmp')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
async function completed(root: string, name = 'run-abc-123abc'): Promise<string> {
  const path = join(root, 'runtimes', name)
  await mkdir(path, { recursive: true })
  await writeFile(
    join(path, 'record.json'),
    JSON.stringify({ finishedAt: 1, teardown: 'removed', cleanupError: null }),
  )
  await writeFile(join(path, 'carry-in.bundle'), 'snapshot')
  return path
}

test('cleans only completed run directories and matching archives; preserves chats and failed runs', async () =>
  fixture(async (root, cleanup) => {
    await completed(root)
    await writeFile(join(root, 'runtimes/run-abc-123abc.zip'), 'archive')
    await mkdir(join(root, 'runtimes/run-def-456def'), { recursive: true })
    await writeFile(
      join(root, 'runtimes/run-def-456def/record.json'),
      JSON.stringify({ finishedAt: 1, teardown: 'failed', cleanupError: 'still running' }),
    )
    await writeFile(join(root, 'runtimes/important.txt'), 'kept')
    await mkdir(join(root, 'workspace/project/thread'), { recursive: true })
    await writeFile(join(root, 'workspace/project/thread/meta.json'), 'chat')
    const result = await cleanup.clean('runs')
    assert.equal(result.removed, 2)
    assert.equal(result.skipped, 1)
    assert.equal(await readFile(join(root, 'workspace/project/thread/meta.json'), 'utf8'), 'chat')
    assert.equal(await readFile(join(root, 'runtimes/important.txt'), 'utf8'), 'kept')
  }))

test('retention uses newest descendant activity and keeps recent data', async () =>
  fixture(async (root, cleanup) => {
    const old = await completed(root)
    const recent = await completed(root, 'run-def-456def')
    const before = new Date(Date.now() - 40 * 86_400_000)
    for (const name of await readdir(old)) await utimes(join(old, name), before, before)
    await utimes(old, before, before)
    const result = await cleanup.clean('runs', Date.now() - 30 * 86_400_000)
    assert.equal(result.removed, 1)
    assert.equal(result.skipped, 1)
    assert.equal(await readFile(join(recent, 'carry-in.bundle'), 'utf8'), 'snapshot')
  }))

test('process leases protect both areas and release after failure', async () =>
  fixture(async (root, cleanup) => {
    await completed(root)
    await assert.rejects(
      cleanup.use('runs', async () => {
        assert.equal(
          (await new StorageCleanup(root, join(root, 'workspace/tmp')).inspect('runs')).busy,
          true,
        )
        assert.equal((await cleanup.clean('runs')).removed, 0)
        throw new Error('operation failed')
      }),
      /operation failed/,
    )
    assert.equal((await cleanup.clean('runs')).removed, 1)
    const build = join(root, 'workspace/tmp/apple-development/checkout')
    await mkdir(build, { recursive: true })
    await writeFile(join(build, 'cache'), 'cache')
    const release = await cleanup.hold('builds')
    assert.equal((await cleanup.clean('builds')).removed, 0)
    await release()
    assert.equal((await cleanup.clean('builds')).removed, 1)
  }))

test('build cleanup preserves arbitrary scratch, chat files and symlink targets', async () =>
  fixture(async (root, cleanup) => {
    const build = join(root, 'workspace/tmp/apple-development/checkout')
    await mkdir(build, { recursive: true })
    await writeFile(join(build, 'cache'), 'cache')
    await writeFile(join(root, 'workspace/tmp/user.txt'), 'user scratch')
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside/valuable'), 'keep')
    await symlink(join(root, 'outside'), join(root, 'workspace/tmp/apple-development/link'))
    const result = await cleanup.clean('builds')
    assert.equal(result.removed, 1)
    assert.equal(result.skipped, 1)
    assert.equal(await readFile(join(root, 'outside/valuable'), 'utf8'), 'keep')
    assert.equal(await readFile(join(root, 'workspace/tmp/user.txt'), 'utf8'), 'user scratch')
  }))

test('refuses redirected storage roots', async () =>
  fixture(async (root, cleanup) => {
    const outside = await mkdtemp(join(tmpdir(), 'copse-storage-external-'))
    try {
      await writeFile(join(outside, 'valuable'), 'keep')
      await symlink(outside, join(root, 'runtimes'))
      await assert.rejects(cleanup.clean('runs'), /redirected/)
      assert.equal(await readFile(join(outside, 'valuable'), 'utf8'), 'keep')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  }))

test('missing roots are empty and expired dead process leases are reaped', async () =>
  fixture(async (root, cleanup) => {
    assert.equal((await cleanup.inspect('runs')).bytes, 0)
    await writeFile(join(root, 'storage-maintenance/runs-2147483647-abc.lease'), '')
    assert.equal((await cleanup.inspect('runs')).busy, false)
  }))
