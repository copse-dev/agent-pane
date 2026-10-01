import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { aggregatePluginCatalog, renderPluginCatalogModule } from './plugin-catalog-sync.mts'
import type { PluginCatalogFeed } from '../src/shared/plugin-catalog.mts'

const firstFeed: PluginCatalogFeed = {
  id: 'first',
  repository: 'https://github.com/example/plugins',
  revision: 'a'.repeat(40),
  format: 'claude',
  manifestPath: '.claude-plugin/marketplace.json',
}

const secondFeed: PluginCatalogFeed = {
  id: 'second',
  repository: 'https://github.com/example/plugins',
  revision: 'a'.repeat(40),
  format: 'cursor',
  manifestPath: '.cursor-plugin/marketplace.json',
}

function response(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), init)
}

describe('plugin catalogue sync', () => {
  it('normalizes, sorts, and deduplicates pinned feeds deterministically', async () => {
    const urls: string[] = []
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      return response({ plugins: [{ name: 'review', source: './plugins/review' }] })
    }
    const snapshot = await aggregatePluginCatalog([secondFeed, firstFeed], fetcher)
    assert.equal(snapshot.entries.length, 1)
    assert.deepEqual(
      snapshot.entries[0]?.listings.map((listing) => listing.id),
      ['first', 'second'],
    )
    assert.deepEqual(
      snapshot.sources.map((source) => source.id),
      ['first', 'second'],
    )
    assert.match(urls[0] ?? '', /raw\.githubusercontent\.com\/example\/plugins\/a{40}/)
    const rendered = renderPluginCatalogModule(snapshot)
    assert.equal(rendered, renderPluginCatalogModule(snapshot))
    assert.doesNotMatch(rendered, /['"][a-f0-9]{40}['"]/, 'must not resemble a token')
    assert.match(rendered, /"a{20}" \+ "a{20}"/)
  })

  it('keeps healthy sources and records a failed neighbour', async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.includes('.claude-plugin')
        ? new Response('', { status: 503 })
        : response({ plugins: [{ name: 'healthy', source: './healthy' }] })
    }
    const snapshot = await aggregatePluginCatalog([firstFeed, secondFeed], fetcher)
    assert.deepEqual(
      snapshot.entries.flatMap((entry) => entry.names),
      ['healthy'],
    )
    assert.deepEqual(snapshot.diagnostics, [
      {
        sourceId: 'first',
        entry: null,
        message: 'Index request failed (503)',
      },
    ])
  })

  it('bounds downloaded indexes even when the server omits content-length', async () => {
    const fetcher: typeof fetch = async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))
    const snapshot = await aggregatePluginCatalog([firstFeed], fetcher)
    assert.equal(snapshot.entries.length, 0)
    assert.match(snapshot.diagnostics[0]?.message ?? '', /exceeds 4 MiB/)
  })

  it('rejects duplicate source ids before fetching', async () => {
    await assert.rejects(
      aggregatePluginCatalog([firstFeed, { ...secondFeed, id: firstFeed.id }], async () =>
        response({ plugins: [] }),
      ),
      /unique ids/,
    )
  })
})
