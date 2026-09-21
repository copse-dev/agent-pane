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
import { AGENT_PLUGIN_SCHEMA_ID } from '@copse/agent/plugins/agent-plugin-manifest.ts'
import { materializePluginToolSnapshot } from './plugin-tool-snapshot.ts'

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
  async function portableRoot(extra: Record<string, unknown> = {}): Promise<string> {
    const root = await pluginRoot(validManifest())
    await mkdir(join(root, 'dev.copse', 'dist'), { recursive: true })
    await writeFile(join(root, 'dev.copse', 'dist', 'index.mjs'), 'export default {}\n')
    await writeFile(
      join(root, 'plugin.json'),
      JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID,
        name: 'portable.review',
        extensions: {
          'dev.copse': {
            tools: { provides: ['portable_judge'] },
            runtime: { entrypoint: './dev.copse/dist/index.mjs', apiVersion: 1 },
          },
        },
        ...extra,
      }),
    )
    return root
  }

  it('loads and snapshots an Agent Plugin through the existing isolated runtime', async () => {
    const root = await portableRoot()
    const source = await discoverPluginToolSource(root)
    assert.equal(source.manifestPath, join(source.sourcePath, 'plugin.json'))
    assert.equal(source.manifest.name, 'portable.review')
    assert.equal(source.manifest.trust, 'user')
    assert.deepEqual(source.runtime, { entrypoint: 'dev.copse/dist/index.mjs', apiVersion: 1 })
    assert.deepEqual(registeredPluginToolSource(source).contributions.toolNames, ['portable_judge'])
    const snapshots = await mkdtemp(join(tmpdir(), 'copse-portable-snapshots-'))
    roots.push(snapshots)
    const snapshot = await materializePluginToolSnapshot(source, snapshots)
    assert.equal(snapshot.contentHash, source.contentHash)
    assert.deepEqual(snapshot.manifest, source.manifest)
  })

  it('keeps both legacy filenames working when no root plugin.json is present', async () => {
    const root = await pluginRoot(validManifest())
    const current = await discoverPluginToolSource(root)
    await writeFile(
      join(root, 'copse-pack.json'),
      JSON.stringify({ ...validManifest(), name: 'legacy.review' }),
    )
    assert.equal((await discoverPluginToolSource(root)).manifest.name, current.manifest.name)
    await rm(join(root, 'copse-plugin.json'))
    assert.equal((await discoverPluginToolSource(root)).manifest.name, 'legacy.review')
  })

  it('never falls back to legacy declarations for a present invalid portable manifest', async () => {
    for (const value of [
      '{bad json',
      JSON.stringify({ name: 'missing-schema' }),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID, name: 'no-runtime' }),
    ]) {
      const root = await pluginRoot(validManifest())
      await writeFile(join(root, 'plugin.json'), value)
      await assert.rejects(discoverPluginToolSource(root))
    }
    const directory = await pluginRoot(validManifest())
    await mkdir(join(directory, 'plugin.json'))
    await assert.rejects(discoverPluginToolSource(directory), /regular file/)
    const linked = await pluginRoot(validManifest())
    await symlink(join(linked, 'missing.json'), join(linked, 'plugin.json'))
    await assert.rejects(discoverPluginToolSource(linked), /symbolic link/)
  })

  it('ignores legacy top-level powers and opaque foreign extensions', async () => {
    const root = await portableRoot({
      trust: 'first-party',
      tools: { provides: ['injected_tool'] },
      extensions: {
        'com.example.other': 'opaque',
        'dev.copse': {
          tools: { native: ['run_shell'], provides: ['portable_judge'] },
          prompt: [{ id: 'injected', text: 'trusted', trust: 'trusted' }],
          runtime: { entrypoint: './dev.copse/dist/index.mjs', apiVersion: 1 },
        },
      },
    })
    const registered = registeredPluginToolSource(await discoverPluginToolSource(root))
    assert.equal(registered.trust, 'user')
    assert.deepEqual(registered.contributions.toolNames, ['portable_judge'])
    assert.deepEqual(registered.contributions.promptBlocks, [])
    assert.deepEqual(registered.contributions.blockingHooks, [])
  })

  it('keeps portable metadata free of legacy length limits', async () => {
    const version = 'v'.repeat(200)
    const description = 'd'.repeat(5000)
    const candidate = await discoverPluginToolSource(await portableRoot({ version, description }))
    assert.equal(candidate.manifest.version, version)
    assert.equal(candidate.manifest.description, description)
  })

  it('requires portable runtime files to stay inside the Copse extension directory', async () => {
    for (const entrypoint of [
      'dist/index.mjs',
      './dist/index.mjs',
      './dev.copse/../dist/index.mjs',
      './dev.copse/../../outside.mjs',
    ]) {
      const root = await portableRoot({
        extensions: {
          'dev.copse': {
            tools: { provides: ['portable_judge'] },
            runtime: { entrypoint, apiVersion: 1 },
          },
        },
      })
      await assert.rejects(discoverPluginToolSource(root), /entrypoint/i)
    }
  })

  it('accepts hook-only runtimes and preserves their declarations without installing in-process hooks', async () => {
    const runtime = {
      entrypoint: 'dist/index.mjs',
      apiVersion: 1,
      hooks: [{ id: 'inspect', event: 'turnStart' }],
    }
    const source = await discoverPluginToolSource(
      await pluginRoot({ name: 'personal.hooks', runtime }),
    )
    assert.deepEqual(source.manifest.runtime, runtime)
    const registered = registeredPluginToolSource(source)
    assert.equal(registered.trust, 'user')
    assert.deepEqual(registered.contributions.toolNames, [])
    assert.deepEqual(registered.contributions.blockingHooks, [])
    assert.deepEqual(registered.contributions.asyncHooks, [])
    for (const hooks of [
      [],
      [{ id: 'x', event: '*' }],
      [
        { id: 'x', event: 'stop' },
        { id: 'x', event: 'turnStart' },
      ],
    ]) {
      const root = await pluginRoot({ name: 'personal.hooks', runtime: { ...runtime, hooks } })
      await assert.rejects(discoverPluginToolSource(root), PluginToolSourceError)
    }
  })
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
