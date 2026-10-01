import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  canonicalPluginPath,
  canonicalPluginRepository,
  ingestPluginMarketplace,
  mergePluginCatalog,
  type PluginCatalogSource,
  type PluginCatalogResult,
} from './plugin-catalog.mts'

const source: PluginCatalogSource = {
  id: 'official',
  repository: 'https://github.com/Example/Plugins.git',
  revision: 'a'.repeat(40),
  format: 'claude',
}

function ingest(plugins: unknown[]): PluginCatalogResult {
  return ingestPluginMarketplace({ plugins }, source)
}

describe('plugin catalogue ingestion', () => {
  it('pins relative packages to the marketplace revision without asserting compatibility', () => {
    const result = ingest([
      {
        name: 'review',
        displayName: 'Code Review',
        source: './plugins/review',
        description: 'Review code',
        tags: ['quality'],
        category: 'development',
        homepage: 'https://example.com/review',
        license: 'MIT',
      },
    ])
    assert.deepEqual(result.diagnostics, [])
    const entry = result.entries[0]
    assert.ok(entry)
    assert.equal(entry.id, 'https://github.com/example/plugins#plugins/review')
    assert.equal(entry.revision, source.revision)
    assert.equal(entry.compatibility, 'untested')
    assert.equal(entry.adaptationRequired, true)
    assert.deepEqual(entry.names, ['Code Review', 'review'])
    assert.deepEqual(entry.keywords, ['development', 'quality'])
    assert.equal(entry.homepage, 'https://example.com/review')
    assert.equal(entry.license, 'MIT')
  })

  it('accepts Cursor indexes and remote pinned subdirectories', () => {
    const result = ingestPluginMarketplace(
      {
        plugins: [
          {
            name: 'tools',
            source: {
              source: 'git-subdir',
              url: 'https://github.com/Publisher/Tools',
              path: 'plugins/tools',
              sha: 'b'.repeat(40),
            },
          },
        ],
      },
      { ...source, format: 'cursor' },
    )
    const entry = result.entries[0]
    assert.ok(entry)
    assert.equal(entry.revision, 'b'.repeat(40))
    assert.equal(entry.repository, 'https://github.com/publisher/tools')
    assert.equal(entry.listings[0]?.format, 'cursor')
  })

  it('never uses an index revision to pin an external package', () => {
    const result = ingest([
      {
        name: 'tools',
        source: {
          source: 'url',
          url: 'https://github.com/publisher/tools',
          ref: 'main',
        },
      },
    ])
    assert.equal(result.entries[0]?.revision, null)
  })

  it('keeps valid neighbours and reports malformed entries', () => {
    const result = ingest([
      { name: 'good', source: './good' },
      { name: 'bad', source: '../escape' },
      { name: 'bad2', source: { source: 'url', url: 'https://user:secret@github.com/a/b' } },
      { name: 'bad3', source: { source: 'git-subdir', url: 'https://github.com/a/b' } },
      null,
    ])
    assert.equal(result.entries.length, 1)
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.entry),
      [1, 2, 3, 4],
    )
  })

  it('rejects invalid envelopes and unpinned marketplace contexts', () => {
    assert.equal(ingestPluginMarketplace({}, source).diagnostics.length, 1)
    assert.equal(
      ingestPluginMarketplace({ plugins: [] }, { ...source, revision: 'main' }).diagnostics.length,
      1,
    )
    assert.equal(
      ingestPluginMarketplace({ plugins: Array(5001).fill(null) }, source).diagnostics.length,
      1,
    )
  })

  it('accepts skill bundle metadata without claiming that its layout works', () => {
    const result = ingest([
      { name: 'bundle', source: './bundle', strict: false, skills: ['./nested/skill'] },
    ])
    const entry = result.entries[0]
    assert.ok(entry)
    assert.equal(entry.compatibility, 'untested')
    assert.equal(entry.adaptationRequired, true)
  })

  it('deduplicates listings but keeps different revision variants', () => {
    const first = ingest([{ name: 'tools', source: './tools' }]).entries
    const second = ingestPluginMarketplace(
      { plugins: [{ name: 'alias', source: './tools' }] },
      { ...source, id: 'other' },
    ).entries
    const newer = ingestPluginMarketplace(
      { plugins: [{ name: 'tools', source: './tools' }] },
      { ...source, revision: 'b'.repeat(40) },
    ).entries
    const merged = mergePluginCatalog([...first, ...second, ...newer, ...first])
    assert.equal(merged.length, 2)
    const mergedEntry = merged[0]
    assert.ok(mergedEntry)
    assert.deepEqual(mergedEntry.names, ['alias', 'tools'])
    assert.equal(mergedEntry.listings.length, 2)
    assert.deepEqual(mergePluginCatalog([...newer, ...second, ...first]), merged)
  })

  it('does not conflate identical names from different publishers', () => {
    const result = ingest([
      { name: 'tools', source: { source: 'url', url: 'https://github.com/a/tools' } },
      { name: 'tools', source: { source: 'url', url: 'https://github.com/b/tools' } },
    ])
    assert.equal(result.entries.length, 2)
  })
})

describe('plugin source containment', () => {
  it('rejects unsafe repository addresses and paths', () => {
    for (const url of [
      'http://github.com/a/b',
      'https://example.com/a/b',
      'https://github.com/a/b/tree/main',
      'https://github.com/a/b?token=secret',
      'https://github.com/a/%62',
      'https://github.com/a/../b/c',
      'https://github.com/a/b#fragment',
    ])
      assert.throws(() => canonicalPluginRepository(url), url)
    for (const path of ['../a', '/a', 'a/../../b', 'a\\b', '%2e%2e/a', 'a//b', 'a?b', 'a\u0000b']) {
      assert.throws(() => canonicalPluginPath(path), path)
    }
    assert.equal(canonicalPluginPath('./'), '')
    assert.equal(canonicalPluginRepository('https://github.com/A/B.git'), 'https://github.com/a/b')
  })
})
