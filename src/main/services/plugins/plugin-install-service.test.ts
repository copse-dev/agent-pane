import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { AGENT_PLUGIN_SCHEMA_ID } from '@copse/agent/plugins/agent-plugin-manifest.ts'
import { createZipArchive } from '../storage/zip-archive.ts'
import { discoverUserPlugins } from './discover-user-plugins.ts'
import { createPluginInstallService } from './plugin-install-service.ts'

const CATALOG_ID = 'https://github.com/cursor/plugins#pstack'
const MODIFIED = new Date('2026-01-01T00:00:00.000Z')
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'))

function cursorArchive(skillText: string, pluginName = 'pstack'): Promise<Uint8Array> {
  return createZipArchive(
    Object.entries({
      'plugins-revision/pstack/.cursor-plugin/plugin.json': JSON.stringify({
        name: pluginName,
        version: '1.2.3',
        description: 'A review workflow.',
        skills: './skills/',
      }),
      'plugins-revision/pstack/skills/review/SKILL.md': skillText,
    }).map(([path, body]) => ({ path, data: utf8(body), modifiedAt: MODIFIED })),
  )
}

function claudeArchive(mcpServers: Record<string, unknown>): Promise<Uint8Array> {
  return createZipArchive(
    Object.entries({
      'plugins-revision/pstack/.claude-plugin/plugin.json': JSON.stringify({ name: 'pstack' }),
      'plugins-revision/pstack/.mcp.json': JSON.stringify({ mcpServers }),
      'plugins-revision/pstack/skills/review/SKILL.md': '# review',
    }).map(([path, body]) => ({ path, data: utf8(body), modifiedAt: MODIFIED })),
  )
}

function portableArchive(extension: unknown): Promise<Uint8Array> {
  return createZipArchive(
    Object.entries({
      'plugins-revision/pstack/plugin.json': JSON.stringify({
        $schema: AGENT_PLUGIN_SCHEMA_ID,
        name: 'pstack',
        extensions: { 'dev.copse': extension },
      }),
      'plugins-revision/pstack/skills/review/SKILL.md': '# review',
      'plugins-revision/pstack/dev.copse/index.mjs': 'export default {}\n',
    }).map(([path, body]) => ({ path, data: utf8(body), modifiedAt: MODIFIED })),
  )
}

describe('catalogue plugin installation lifecycle', () => {
  let root: string
  let ids: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copse-plugin-install-'))
    ids = 0
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function serviceWith(archives: Uint8Array[]): ReturnType<typeof createPluginInstallService> {
    let request = 0
    return createPluginInstallService({
      root,
      fetcher: async (input) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        assert.match(url, /codeload\.github\.com\/cursor\/plugins\/zip\//)
        const body = archives[Math.min(request, archives.length - 1)]
        request += 1
        assert.ok(body)
        return new Response(Uint8Array.from(body).buffer, {
          headers: { 'content-length': String(body.byteLength) },
        })
      },
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      randomId: () => `id-${String((ids += 1))}`,
    })
  }

  it('reviews before writing, then installs the exact pinned legacy package', async () => {
    const service = serviceWith([await cursorArchive('# review v1')])
    const review = await service.prepare(CATALOG_ID)
    assert.equal(review.pluginId, 'pstack')
    assert.equal(review.skillCount, 1)
    assert.equal(review.mcpServerCount, 0)
    assert.deepEqual(review.skills, ['skills/review/SKILL.md'])
    assert.deepEqual(review.mcpServers, [])
    assert.equal(review.provenance, 'unsigned')
    assert.equal(review.operation, 'install')
    assert.match(review.contentHash, /^sha256:[a-f0-9]{64}$/)
    // Adapting a Claude/Cursor manifest is routine plumbing, not something to warn about.
    assert.deepEqual(review.warnings, [])
    assert.equal(existsSync(join(root, 'pstack')), false)
    assert.deepEqual(await service.records(), [])

    const { record } = await service.commit(review.token)
    assert.equal(record.source.revision.length, 40)
    assert.equal((await fsp.lstat(join(root, 'pstack'))).isSymbolicLink(), true)
    const discovery = await discoverUserPlugins(root)
    assert.deepEqual(discovery.failures, [])
    assert.deepEqual(
      discovery.plugins.map((plugin) => plugin.manifest.name),
      ['pstack'],
    )
    assert.equal(
      readFileSync(join(root, 'pstack', 'skills', 'review', 'SKILL.md'), 'utf8'),
      '# review v1',
    )
  })

  it("adapts Claude Code's `http` MCP transport to Streamable HTTP", async () => {
    const service = serviceWith([
      await claudeArchive({
        figma: {
          type: 'http',
          url: 'https://mcp.figma.com/mcp',
          headers: { 'X-Figma-Plugin-Bundle': 'figma_prod@2_2_120' },
          _meta: { ideToolIconPath: './icon.svg' },
        },
        legacy: { type: 'sse', url: 'https://example.com/sse' },
        unknown: { type: 'websocket', url: 'wss://example.com' },
      }),
    ])
    const review = await service.prepare(CATALOG_ID)
    assert.deepEqual(review.mcpServers, [
      { name: 'figma', transport: 'streamable-http', target: 'https://mcp.figma.com/mcp' },
      { name: 'legacy', transport: 'sse', target: 'https://example.com/sse' },
    ])
    assert.deepEqual(review.warnings, [
      'Skipped MCP server "unknown": Copse runs local commands and HTTP URLs only.',
    ])
  })

  it('cancels staging without registering or recording the package', async () => {
    const service = serviceWith([await cursorArchive('# review')])
    const review = await service.prepare(CATALOG_ID)
    await service.cancel(review.token)
    await assert.rejects(service.commit(review.token), /expired/)
    assert.deepEqual(await service.records(), [])
    assert.equal(existsSync(join(root, 'pstack')), false)
  })

  it('rejects archive traversal and leaves no package behind', async () => {
    const archive = await createZipArchive([
      {
        path: 'plugins-revision/pstack/../escape.txt',
        data: utf8('escape'),
        modifiedAt: MODIFIED,
      },
      {
        path: 'plugins-revision/pstack/skills/review/SKILL.md',
        data: utf8('# review'),
        modifiedAt: MODIFIED,
      },
    ])
    const service = serviceWith([archive])
    await assert.rejects(service.prepare(CATALOG_ID), /unsafe entry/)
    assert.equal(existsSync(join(root, 'escape.txt')), false)
    assert.deepEqual(await service.records(), [])
  })

  it('rejects Copse executable behavior in a marketplace package', async () => {
    const service = serviceWith([
      await portableArchive({
        runtime: { entrypoint: 'dev.copse/index.mjs', apiVersion: 1 },
        tools: { provides: ['review_tool'] },
      }),
    ])
    await assert.rejects(service.prepare(CATALOG_ID), /skills and MCP packages only/)
    assert.equal(existsSync(join(root, 'pstack')), false)
  })

  it('fails managed discovery closed when an installed payload is edited', async () => {
    const service = serviceWith([await cursorArchive('# review v1')])
    const review = await service.prepare(CATALOG_ID)
    await service.commit(review.token)
    await fsp.writeFile(join(root, 'pstack', 'skills', 'review', 'SKILL.md'), '# tampered')

    const discovery = await discoverUserPlugins(root)
    assert.deepEqual(discovery.plugins, [])
    assert.equal(discovery.failures.length, 1)
    assert.match(discovery.failures[0]?.reason ?? '', /integrity check/)
  })

  it('rejects an update that changes the catalogue package plugin id', async () => {
    const service = serviceWith([
      await cursorArchive('# review v1'),
      await cursorArchive('# review v2', 'renamed-plugin'),
    ])
    const first = await service.prepare(CATALOG_ID)
    await service.commit(first.token)

    await assert.rejects(service.prepare(CATALOG_ID), /cannot change its plugin id/)
    assert.equal(existsSync(join(root, 'renamed-plugin')), false)
  })

  it('cleans staging when a local plugin owns the reviewed id before commit', async () => {
    const service = serviceWith([await cursorArchive('# review')])
    const review = await service.prepare(CATALOG_ID)
    await fsp.mkdir(join(root, 'pstack'))

    await assert.rejects(service.commit(review.token), /non-marketplace plugin/)
    assert.equal(existsSync(join(root, '.managed', 'staging', review.token)), false)
  })

  it('updates atomically, rolls back to the retained payload, then uninstalls', async () => {
    const service = serviceWith([
      await cursorArchive('# review v1'),
      await cursorArchive('# review v2'),
    ])
    const first = await service.prepare(CATALOG_ID)
    await service.commit(first.token)

    const second = await service.prepare(CATALOG_ID)
    assert.equal(second.operation, 'update')
    const updated = await service.commit(second.token)
    assert.equal(updated.record.previousPin?.contentHash, first.contentHash)
    assert.equal(
      readFileSync(join(root, 'pstack', 'skills', 'review', 'SKILL.md'), 'utf8'),
      '# review v2',
    )

    const rolledBack = await service.rollback('pstack')
    assert.equal(rolledBack.record.contentHash, first.contentHash)
    assert.equal(
      readFileSync(join(root, 'pstack', 'skills', 'review', 'SKILL.md'), 'utf8'),
      '# review v1',
    )

    const data = join(root, '.data', 'pstack')
    await fsp.mkdir(data, { recursive: true })
    await fsp.writeFile(join(data, 'state.json'), '{}')
    const removed = await service.uninstall('pstack', false)
    assert.deepEqual(removed, { pluginId: 'pstack', dataDeleted: false })
    assert.equal(existsSync(join(root, 'pstack')), false)
    assert.equal(existsSync(join(data, 'state.json')), true)
    assert.deepEqual(await service.records(), [])
  })
})
