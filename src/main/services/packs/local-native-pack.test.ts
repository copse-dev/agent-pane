import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  createLocalNativePackTrustRecord,
  discoverLocalNativePack,
  LocalNativePackError,
  localNativePackTrustMatches,
  registeredLocalNativePack,
} from './local-native-pack.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function packRoot(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copse-local-native-pack-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export default {}\n')
  await writeFile(join(root, 'copse-pack.json'), JSON.stringify(manifest, null, 2))
  return root
}

function validManifest(): Record<string, unknown> {
  return {
    name: 'personal.native-tools',
    version: '0.1.0',
    description: 'A personal native tool pack.',
    trust: 'first-party',
    tools: { native: ['personal_judge'] },
    prompt: [{ id: 'steering', text: 'Use the local adapter.', trust: 'trusted' }],
    storage: { namespace: 'personal.native-tools' },
    localNative: {
      entrypoint: 'dist/index.mjs',
      sdkVersion: 1,
      capabilities: ['native-tools'],
    },
  }
}

describe('local-native pack discovery', () => {
  it('validates, canonicalizes, hashes, and prevents manifest trust self-promotion', async () => {
    const root = await packRoot(validManifest())
    const candidate = await discoverLocalNativePack(root)

    assert.equal(candidate.trustClass, 'local-native')
    assert.equal(
      candidate.sourcePath,
      await import('node:fs/promises').then((fs) => fs.realpath(root)),
    )
    assert.match(candidate.contentHash, /^sha256:[a-f0-9]{64}$/)
    assert.equal(candidate.manifest.name, 'personal.native-tools')
    assert.equal(candidate.manifest.trust, 'user')
    assert.deepEqual(candidate.manifest.prompt, [
      { id: 'steering', text: 'Use the local adapter.', trust: 'untrusted' },
    ])
    assert.equal(candidate.runtime.entrypoint, 'dist/index.mjs')
    assert.deepEqual(candidate.runtime.origins, [])
    assert.deepEqual(candidate.runtime.rendererSlots, [])
    assert.deepEqual(candidate.runtime.capabilities, ['native-tools'])

    const registered = registeredLocalNativePack(candidate)
    assert.equal(registered.trust, 'local-native')
    assert.deepEqual(registered.contributions.toolNames, ['personal_judge'])
    assert.deepEqual(registered.contributions.promptBlocks, [
      { id: 'steering', text: 'Use the local adapter.', trust: 'untrusted' },
    ])
  })

  it('changes the content hash when executable bytes change', async () => {
    const root = await packRoot(validManifest())
    const before = await discoverLocalNativePack(root)
    await writeFile(join(root, 'dist', 'index.mjs'), 'export default { changed: true }\n')
    const after = await discoverLocalNativePack(root)
    assert.notEqual(after.contentHash, before.contentHash)
  })

  it('rejects traversal, later-phase authority, and symbolic links', async () => {
    const traversal = validManifest()
    const traversalRuntime = traversal['localNative']
    assert.ok(typeof traversalRuntime === 'object' && traversalRuntime !== null)
    Object.assign(traversalRuntime, { entrypoint: '../outside.mjs' })
    await assert.rejects(discoverLocalNativePack(await packRoot(traversal)), LocalNativePackError)

    const futureCapability = validManifest()
    const futureRuntime = futureCapability['localNative']
    assert.ok(typeof futureRuntime === 'object' && futureRuntime !== null)
    Object.assign(futureRuntime, { capabilities: ['native-tools', 'model-routes'] })
    await assert.rejects(
      discoverLocalNativePack(await packRoot(futureCapability)),
      /not a valid local-native pack manifest/,
    )

    const origin = validManifest()
    const originRuntime = origin['localNative']
    assert.ok(typeof originRuntime === 'object' && originRuntime !== null)
    Object.assign(originRuntime, { origins: ['https://example.test'] })
    await assert.rejects(
      discoverLocalNativePack(await packRoot(origin)),
      /Network origins are not supported by the P1\/P2 runtime/,
    )

    const linkedRoot = await packRoot(validManifest())
    await symlink(join(linkedRoot, 'dist', 'index.mjs'), join(linkedRoot, 'linked.mjs'))
    await assert.rejects(discoverLocalNativePack(linkedRoot), /symbolic link/)
  })

  it('binds approval to source, content, and every requested authority', async () => {
    const root = await packRoot(validManifest())
    const candidate = await discoverLocalNativePack(root)
    const record = createLocalNativePackTrustRecord(candidate, 123)
    assert.equal(record.approvedAt, 123)
    assert.equal(localNativePackTrustMatches(candidate, record), true)
    assert.equal(
      localNativePackTrustMatches(candidate, { ...record, contentHash: 'sha256:changed' }),
      false,
    )
    assert.equal(
      localNativePackTrustMatches(candidate, {
        ...record,
        origins: ['https://example.test'],
      }),
      false,
    )
  })

  it('fails closed on malformed or unknown manifest fields', async () => {
    const root = await packRoot({ ...validManifest(), unexpected: true })
    await assert.rejects(discoverLocalNativePack(root), /not a valid local-native pack manifest/)
  })
})
