import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { discoverLocalNativePack } from './local-native-pack.ts'
import { materializeLocalNativePackSnapshot } from './local-native-pack-snapshot.ts'

const roots: string[] = []

async function fixture(): Promise<{ source: string; snapshots: string }> {
  const root = await mkdtemp(join(tmpdir(), 'copse-local-native-snapshot-'))
  roots.push(root)
  const source = join(root, 'source')
  const snapshots = join(root, 'snapshots')
  await mkdir(join(source, 'dist'), { recursive: true })
  await mkdir(join(source, 'node_modules', 'unreviewed'), { recursive: true })
  await mkdir(join(source, '.git'), { recursive: true })
  await writeFile(join(source, 'dist', 'index.mjs'), 'export function activate() {}\n')
  await writeFile(join(source, 'node_modules', 'unreviewed', 'index.js'), 'throw new Error()\n')
  await writeFile(join(source, '.git', 'config'), 'ignored\n')
  await writeFile(join(source, '.DS_Store'), 'ignored\n')
  await writeFile(
    join(source, 'copse-pack.json'),
    JSON.stringify({
      name: 'personal.snapshot-test',
      localNative: {
        entrypoint: 'dist/index.mjs',
        sdkVersion: 1,
        capabilities: ['native-tools'],
      },
    }),
  )
  return { source, snapshots }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local native pack snapshots', () => {
  it('copies only reviewed bytes and reuses the content-addressed snapshot', async () => {
    const { source, snapshots } = await fixture()
    const candidate = await discoverLocalNativePack(source)
    const first = await materializeLocalNativePackSnapshot(candidate, snapshots)
    const second = await materializeLocalNativePackSnapshot(candidate, snapshots)

    assert.equal(first.sourcePath, second.sourcePath)
    assert.notEqual(first.sourcePath, candidate.sourcePath)
    assert.equal(first.contentHash, candidate.contentHash)
    assert.equal(
      await readFile(join(first.sourcePath, 'dist', 'index.mjs'), 'utf8'),
      'export function activate() {}\n',
    )
    await assert.rejects(stat(join(first.sourcePath, 'node_modules')))
    await assert.rejects(stat(join(first.sourcePath, '.git')))
    await assert.rejects(stat(join(first.sourcePath, '.DS_Store')))
  })

  it('rejects a previously materialized snapshot whose bytes were changed', async () => {
    const { source, snapshots } = await fixture()
    const candidate = await discoverLocalNativePack(source)
    const snapshot = await materializeLocalNativePackSnapshot(candidate, snapshots)
    await writeFile(join(snapshot.sourcePath, 'dist', 'index.mjs'), 'changed\n')

    await assert.rejects(
      materializeLocalNativePackSnapshot(candidate, snapshots),
      /does not match the reviewed source content/i,
    )
  })
})
