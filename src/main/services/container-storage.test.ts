import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContainerStorage } from './container-storage.ts'

const hash = 'a'.repeat(64)
function image(name: string, created = '2020-01-01T00:00:00Z', owned = true): unknown {
  return {
    configuration: { name, creationDate: created },
    variants: [
      {
        digest: `sha256:${hash}`,
        size: 600,
        config: { config: { Labels: owned ? { 'dev.copse.worker-fingerprint': hash } : {} } },
      },
    ],
  }
}
const builder = {
  id: 'buildkit',
  configuration: { labels: { 'com.apple.container.resource.role': 'builder' } },
  status: { state: 'running' },
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'copse-container-storage-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function service(
  root: string,
  images: unknown[] = [],
  containers: unknown[] = [builder],
  lastUsed = 0,
): { storage: ContainerStorage; calls: string[][] } {
  const calls: string[][] = []
  const storage = new ContainerStorage({
    supported: true,
    root,
    lastUsed: async (): Promise<number> => lastUsed,
    exclusive: async <T>(run: () => Promise<T>): Promise<T> => run(),
    run: async (args): Promise<string> => {
      calls.push(args)
      if (args[0] === 'image' && args[1] === 'list') return JSON.stringify(images)
      if (args[0] === 'list') return JSON.stringify(containers)
      if (args.includes('du')) return '[]'
      return ''
    },
  })
  return { storage, calls }
}

test('inventory accounts for sparse allocation, aliases and snapshots without current images', async () =>
  fixture(async (root) => {
    await mkdir(join(root, 'snapshots', hash), { recursive: true })
    await writeFile(join(root, 'snapshots', hash, 'snapshot'), 'filesystem')
    await mkdir(join(root, 'snapshots', 'b'.repeat(64)))
    await writeFile(join(root, 'snapshots', 'b'.repeat(64), 'snapshot'), 'old filesystem')
    await mkdir(join(root, 'volumes'))
    await writeFile(join(root, 'volumes', 'disk'), 'workspace')
    const { storage } = service(root, [image('copse-worker:local'), image('copse-worker:e2e')])
    const summary = await storage.inspect()
    assert.equal(summary.available, true)
    assert.equal(summary.snapshotCount, 2)
    assert.equal(summary.unmatchedSnapshots, 1)
    assert.equal(summary.images[0]?.eligible, false)
    assert.equal(summary.images[1]?.eligible, true)
    assert.ok(summary.totalBytes >= summary.snapshotsBytes + summary.volumesBytes)
    assert.ok(
      summary.images[0].snapshotBytes >=
        (await lstat(join(root, 'snapshots', hash, 'snapshot'))).blocks * 512,
    )
  }))

test('automatic expiry preserves local, recent, recently used and unowned images', async () =>
  fixture(async (root) => {
    const { storage, calls } = service(root, [
      image('copse-worker:local'),
      image('docker.io/library/copse-worker:old'),
      image('copse-worker:recent', '2099-01-01T00:00:00Z'),
      image('copse-worker:foreign', undefined, false),
      image('other-app:old'),
    ])
    assert.equal((await storage.clean('worker-images', Date.parse('2025-01-01'))).removed, 1)
    assert.deepEqual(
      calls.filter((args) => args[1] === 'delete'),
      [['image', 'delete', 'docker.io/library/copse-worker:old']],
    )
    const recentUse = service(root, [image('copse-worker:old')], [builder], Date.now())
    assert.equal(
      (await recentUse.storage.clean('worker-images', Date.parse('2025-01-01'))).removed,
      0,
    )
    assert.ok(!recentUse.calls.some((args) => args[1] === 'delete'))
  }))

test('running and stopped containers both block every destructive command', async () =>
  fixture(async (root) => {
    for (const state of ['running', 'stopped']) {
      const { storage, calls } = service(
        root,
        [image('copse-worker:e2e')],
        [builder, { id: 'other', configuration: {}, status: { state } }],
      )
      for (const action of ['worker-images', 'apple-images', 'apple-builder'] as const)
        await assert.rejects(storage.clean(action), /in use/)
      assert.ok(
        !calls.some((args) => args[1] === 'delete' || args[1] === 'prune' || args[0] === 'exec'),
      )
    }
  }))

test('shared cleanup uses engine garbage collection and BuildKit pruning, never broad image removal', async () =>
  fixture(async (root) => {
    const { storage, calls } = service(root)
    await storage.clean('apple-images')
    await storage.clean('apple-builder')
    assert.ok(calls.some((args) => args.join(' ') === 'image prune'))
    assert.ok(calls.some((args) => args.join(' ') === 'exec buildkit buildctl prune'))
    assert.ok(
      !calls
        .filter((args) => args[1] !== 'list' && args[0] !== 'list')
        .some((args) => args.includes('--all') || args.includes('--force')),
    )
    await assert.rejects(service(root, [], []).storage.clean('apple-builder'), /must be running/)
  }))

test('malformed inventory fails closed and filesystem totals remain visible when service is unavailable', async () =>
  fixture(async (root) => {
    await writeFile(join(root, 'disk'), 'retained')
    const { storage, calls } = service(root, [{}])
    const summary = await storage.inspect()
    assert.equal(summary.available, false)
    assert.match(summary.error ?? '', /unsupported/)
    assert.ok(summary.totalBytes > 0)
    await assert.rejects(storage.clean('worker-images'), /unsupported/)
    assert.ok(!calls.some((args) => args[1] === 'delete'))
  }))
