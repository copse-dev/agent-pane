import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  discoverPackToolSource,
  PackToolSourceError,
  registeredPackToolSource,
  samePackToolSource,
} from './pack-tool-source.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function packRoot(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copse-pack-tool-source-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export default {}\n')
  await writeFile(join(root, 'copse-pack.json'), JSON.stringify(manifest, null, 2))
  return root
}

function validManifest(): Record<string, unknown> {
  return {
    name: 'personal.review-tools',
    version: '0.1.0',
    description: 'A personal review tool pack.',
    tools: {
      provides: ['personal_judge'],
    },
    runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
  }
}

describe('selected pack tool discovery', () => {
  it('validates, canonicalizes, hashes, and registers the declared tool behavior', async () => {
    const candidate = await discoverPackToolSource(await packRoot(validManifest()))

    assert.match(candidate.contentHash, /^sha256:[a-f0-9]{64}$/)
    assert.equal(candidate.manifest.name, 'personal.review-tools')
    assert.equal(candidate.manifest.trust, 'user')
    assert.deepEqual(candidate.manifest.tools?.provides, ['personal_judge'])
    assert.deepEqual(candidate.runtime, {
      entrypoint: 'dist/index.mjs',
      apiVersion: 1,
    })

    const registered = registeredPackToolSource(candidate)
    assert.equal(registered.trust, 'user')
    assert.deepEqual(registered.contributions.toolNames, ['personal_judge'])
  })

  it('uses content hashes for execution consistency when source bytes change', async () => {
    const root = await packRoot(validManifest())
    const before = await discoverPackToolSource(root)
    await writeFile(join(root, 'dist', 'index.mjs'), 'export default { changed: true }\n')
    const after = await discoverPackToolSource(root)
    assert.notEqual(after.contentHash, before.contentHash)
    assert.equal(samePackToolSource(before, after), false)
  })

  it('accepts a model-only behavior and registers its manifest-owned metadata', async () => {
    const candidate = await discoverPackToolSource(
      await packRoot({
        name: 'personal.reference-model',
        models: {
          provides: [
            {
              id: 'judge',
              label: 'Reference judge',
              group: 'Personal models',
              supportsImages: true,
            },
          ],
        },
        runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
      }),
    )

    assert.deepEqual(candidate.manifest.models?.provides, [
      {
        id: 'judge',
        label: 'Reference judge',
        group: 'Personal models',
        supportsImages: true,
      },
    ])
    assert.deepEqual(registeredPackToolSource(candidate).contributions.modelRoutes, [
      {
        id: 'judge',
        label: 'Reference judge',
        group: 'Personal models',
        supportsImages: true,
      },
    ])
  })

  it('rejects duplicate model route ids even when their labels differ', async () => {
    await assert.rejects(
      discoverPackToolSource(
        await packRoot({
          name: 'personal.duplicate-models',
          models: {
            provides: [
              { id: 'judge', label: 'Judge one' },
              { id: 'judge', label: 'Judge two' },
            ],
          },
          runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
        }),
      ),
      /model route ids must be unique/i,
    )
  })

  it('rejects traversal, undeclared future behaviors, and symbolic links', async () => {
    const traversal = validManifest()
    traversal['tools'] = {
      provides: ['personal_judge'],
    }
    traversal['runtime'] = { entrypoint: '../outside.mjs', apiVersion: 1 }
    await assert.rejects(discoverPackToolSource(await packRoot(traversal)), PackToolSourceError)

    await assert.rejects(
      discoverPackToolSource(
        await packRoot({ ...validManifest(), browser: { origins: ['https://example.test'] } }),
      ),
      /supported executable behavior/i,
    )

    const linkedRoot = await packRoot(validManifest())
    await symlink(join(linkedRoot, 'dist', 'index.mjs'), join(linkedRoot, 'linked.mjs'))
    await assert.rejects(discoverPackToolSource(linkedRoot), /symbolic link/)
  })

  it('fails closed on malformed or unknown manifest fields', async () => {
    const root = await packRoot({ ...validManifest(), unexpected: true })
    await assert.rejects(discoverPackToolSource(root), /supported executable behavior/i)
  })
})
