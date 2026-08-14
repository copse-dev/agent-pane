import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  discoverPluginToolSource,
  PluginToolSourceError,
  registeredPluginToolSource,
  samePluginToolSource,
} from './plugin-tool-source.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function pluginRoot(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'copse-plugin-tool-source-'))
  roots.push(root)
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'dist', 'index.mjs'), 'export default {}\n')
  await writeFile(join(root, 'copse-plugin.json'), JSON.stringify(manifest, null, 2))
  return root
}

function validManifest(): Record<string, unknown> {
  return {
    name: 'personal.review-tools',
    version: '0.1.0',
    description: 'A personal review tool plugin.',
    tools: {
      provides: ['personal_judge'],
    },
    runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
  }
}

describe('selected plugin tool discovery', () => {
  it('validates, canonicalizes, hashes, and registers the declared tool behavior', async () => {
    const candidate = await discoverPluginToolSource(await pluginRoot(validManifest()))

    assert.match(candidate.contentHash, /^sha256:[a-f0-9]{64}$/)
    assert.equal(candidate.manifest.name, 'personal.review-tools')
    assert.equal(candidate.manifest.trust, 'user')
    assert.deepEqual(candidate.manifest.tools?.provides, ['personal_judge'])
    assert.deepEqual(candidate.runtime, {
      entrypoint: 'dist/index.mjs',
      apiVersion: 1,
    })

    const registered = registeredPluginToolSource(candidate)
    assert.equal(registered.trust, 'user')
    assert.deepEqual(registered.contributions.toolNames, ['personal_judge'])
  })

  it('uses content hashes for execution consistency when source bytes change', async () => {
    const root = await pluginRoot(validManifest())
    const before = await discoverPluginToolSource(root)
    await writeFile(join(root, 'dist', 'index.mjs'), 'export default { changed: true }\n')
    const after = await discoverPluginToolSource(root)
    assert.notEqual(after.contentHash, before.contentHash)
    assert.equal(samePluginToolSource(before, after), false)
  })

  it('accepts a model-only behavior and registers its manifest-owned metadata', async () => {
    const candidate = await discoverPluginToolSource(
      await pluginRoot({
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
        browser: { origins: ['https://example.test'] },
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
    assert.deepEqual(registeredPluginToolSource(candidate).contributions.modelRoutes, [
      {
        id: 'judge',
        label: 'Reference judge',
        group: 'Personal models',
        supportsImages: true,
      },
    ])
    assert.deepEqual(candidate.manifest.browser?.origins, ['https://example.test'])
    assert.deepEqual(registeredPluginToolSource(candidate).contributions.browserOrigins, [
      'https://example.test',
    ])
  })

  it('accepts exact HTTPS and loopback HTTP origins, canonicalized and deduplicated', async () => {
    const candidate = await discoverPluginToolSource(
      await pluginRoot({
        name: 'personal.browser-model',
        models: { provides: [{ id: 'browser', label: 'Browser model' }] },
        browser: {
          origins: [
            'https://two.example:8443',
            'http://127.0.0.1:4173',
            'https://two.example:8443',
          ],
        },
        runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
      }),
    )

    assert.deepEqual(candidate.manifest.browser?.origins, [
      'http://127.0.0.1:4173',
      'https://two.example:8443',
    ])
  })

  it('rejects broad, credentialed, path-bearing, and browser-without-model declarations', async () => {
    for (const origin of [
      'http://example.test',
      'https://user@example.test',
      'https://example.test/path',
      'https://*.example.test',
    ]) {
      await assert.rejects(
        discoverPluginToolSource(
          await pluginRoot({
            name: 'personal.bad-browser',
            models: { provides: [{ id: 'browser', label: 'Browser model' }] },
            browser: { origins: [origin] },
            runtime: { entrypoint: 'dist/index.mjs', apiVersion: 1 },
          }),
        ),
        /browser origin/i,
      )
    }

    await assert.rejects(
      discoverPluginToolSource(
        await pluginRoot({
          ...validManifest(),
          browser: { origins: ['https://example.test'] },
        }),
      ),
      /supported executable behavior/i,
    )
  })

  it('rejects duplicate model route ids even when their labels differ', async () => {
    await assert.rejects(
      discoverPluginToolSource(
        await pluginRoot({
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

  it('rejects traversal, unknown future behaviors, and symbolic links', async () => {
    const traversal = validManifest()
    traversal['tools'] = {
      provides: ['personal_judge'],
    }
    traversal['runtime'] = { entrypoint: '../outside.mjs', apiVersion: 1 }
    await assert.rejects(
      discoverPluginToolSource(await pluginRoot(traversal)),
      PluginToolSourceError,
    )

    await assert.rejects(
      discoverPluginToolSource(
        await pluginRoot({ ...validManifest(), rendererSlots: ['sidebar'] }),
      ),
      /supported executable behavior/i,
    )

    const linkedRoot = await pluginRoot(validManifest())
    await symlink(join(linkedRoot, 'dist', 'index.mjs'), join(linkedRoot, 'linked.mjs'))
    await assert.rejects(discoverPluginToolSource(linkedRoot), /symbolic link/)
  })

  it('fails closed on malformed or unknown manifest fields', async () => {
    const root = await pluginRoot({ ...validManifest(), unexpected: true })
    await assert.rejects(discoverPluginToolSource(root), /supported executable behavior/i)
  })
})
