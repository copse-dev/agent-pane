import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_PLUGIN_SCHEMA_ID,
  AgentPluginManifestError,
  COPSE_EXTENSION_NAMESPACE,
  isValidAgentPluginName,
  parseAgentPluginManifest,
} from './agent-plugin-manifest.ts'

/** A minimal conformant manifest; spread over it to vary one thing at a time. */
function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { $schema: AGENT_PLUGIN_SCHEMA_ID, name: 'acme.reviewer', ...extra }
}

/**
 * `assert.throws` returns undefined, so it cannot answer *which* boundary
 * rejected the plugin — and that distinction is the point of these tests.
 */
function rejection(run: () => unknown): AgentPluginManifestError {
  try {
    run()
  } catch (error) {
    assert.ok(
      error instanceof AgentPluginManifestError,
      `expected AgentPluginManifestError, got ${String(error)}`,
    )
    return error
  }
  throw new assert.AssertionError({ message: 'expected the manifest to be rejected' })
}

function copse(block: Record<string, unknown>): Record<string, unknown> {
  return { extensions: { [COPSE_EXTENSION_NAMESPACE]: block } }
}

describe('isValidAgentPluginName', () => {
  it('accepts the spec §5.5 examples', () => {
    for (const name of ['my-plugin', 'acme.tools', 'lint3r', 'a']) {
      assert.equal(isValidAgentPluginName(name), true, name)
    }
  })

  it('rejects the spec §5.5 counter-examples', () => {
    for (const name of ['My-Plugin', '-start', 'has--double', 'too.many..dots', '']) {
      assert.equal(isValidAgentPluginName(name), false, JSON.stringify(name))
    }
  })

  it('rejects a trailing separator and enforces the 64-character bound', () => {
    assert.equal(isValidAgentPluginName('trailing-'), false)
    assert.equal(isValidAgentPluginName('trailing.'), false)
    assert.equal(isValidAgentPluginName('a'.repeat(64)), true)
    assert.equal(isValidAgentPluginName('a'.repeat(65)), false)
  })
})

describe('parseAgentPluginManifest — envelope', () => {
  it('parses a minimal manifest as an experimental user plugin', () => {
    const { manifest: parsed } = parseAgentPluginManifest(manifest())
    assert.equal(parsed.name, 'acme.reviewer')
    // A disk manifest never claims first-party power, and never looks
    // production-ready by omission.
    assert.equal(parsed.trust, 'user')
    assert.equal(parsed.stability, 'experimental')
  })

  it('reports and ignores an unknown top-level field without rejecting (§5.2)', () => {
    const { manifest: parsed, warnings } = parseAgentPluginManifest(manifest({ mcpServers: './x' }))
    assert.equal(parsed.name, 'acme.reviewer')
    assert.ok(warnings.some((w) => w.includes('mcpServers')))
  })

  it('rejects an unsupported $schema rather than guessing compatibility', () => {
    const error = rejection(() =>
      parseAgentPluginManifest(
        manifest({ $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json' }),
      ),
    )
    assert.equal(error.kind, 'unsupported-version')
  })

  it('rejects a missing required field and a name violating §5.5', () => {
    assert.equal(rejection(() => parseAgentPluginManifest({ name: 'x' })).kind, 'envelope')
    const error = rejection(() => parseAgentPluginManifest(manifest({ name: 'Bad Name' })))
    assert.equal(error.kind, 'envelope')
  })

  it('carries publisher metadata the pack manifest never had', () => {
    const { metadata } = parseAgentPluginManifest(
      manifest({
        author: { name: 'Acme', url: 'https://acme.example' },
        repository: 'https://github.com/acme/reviewer',
        license: 'MIT',
        keywords: ['review'],
      }),
    )
    assert.equal(metadata.author?.name, 'Acme')
    assert.equal(metadata.repository, 'https://github.com/acme/reviewer')
    assert.equal(metadata.license, 'MIT')
    assert.deepEqual(metadata.keywords, ['review'])
  })

  it('does not reject metadata that is merely unconventional (§5.4)', () => {
    // Not SemVer, not a real URL, not an SPDX id — all fine; only JSON types
    // are validated.
    const { manifest: parsed } = parseAgentPluginManifest(
      manifest({ version: 'v-whenever', homepage: 'not-a-url', license: 'made-up' }),
    )
    assert.equal(parsed.version, 'v-whenever')
  })
})

describe('parseAgentPluginManifest — extensions (§8.1)', () => {
  it('reports and ignores a non-object extensions field', () => {
    const { warnings } = parseAgentPluginManifest(manifest({ extensions: 'nope' }))
    assert.ok(warnings.some((w) => w.includes('extensions')))
  })

  it('ignores another client namespace without validating its contents', () => {
    const { manifest: parsed, warnings } = parseAgentPluginManifest(
      manifest({ extensions: { 'com.example.client': { anything: [1, 2, 3] } } }),
    )
    assert.equal(parsed.name, 'acme.reviewer')
    assert.deepEqual(warnings, [])
  })

  it('rejects a malformed dev.copse block as a Copse-side failure, not an AP one', () => {
    const error = rejection(() =>
      parseAgentPluginManifest(manifest(copse({ stability: 'super-stable' }))),
    )
    assert.equal(error.kind, 'copse-extension')
  })

  it('reads the declarative slots out of the namespace', () => {
    const { manifest: parsed } = parseAgentPluginManifest(
      manifest(
        copse({
          stability: 'stable',
          hooks: [{ event: 'turn-start', command: './dev.copse/hooks/start.sh' }],
          settings: { strictness: { kind: 'number', title: 'Strictness', default: 2 } },
          storage: { namespace: 'acme' },
          capabilities: [{ name: 'acme-canvas', title: 'Canvas' }],
          permissions: [{ name: 'loopback-bind', title: 'Bind a local port', scope: 'project' }],
        }),
      ),
    )
    assert.equal(parsed.stability, 'stable')
    assert.equal(parsed.hooks?.length, 1)
    assert.equal(parsed.settings?.['strictness']?.kind, 'number')
    assert.equal(parsed.storage?.namespace, 'acme')
    assert.equal(parsed.capabilities?.[0]?.name, 'acme-canvas')
    assert.equal(parsed.permissions?.[0]?.scope, 'project')
  })
})

describe('parseAgentPluginManifest — user-plugin hardening', () => {
  it('forces prompt blocks to untrusted however the file frames them', () => {
    const { manifest: parsed, warnings } = parseAgentPluginManifest(
      manifest(copse({ prompt: [{ id: 'steer', text: 'do the thing', trust: 'trusted' }] })),
    )
    assert.equal(parsed.prompt?.[0]?.trust, 'untrusted')
    assert.ok(warnings.some((w) => w.includes('untrusted')))
  })

  it('strips native tools and ACP exposure, keeping runtime-provided tools', () => {
    const { manifest: parsed, warnings } = parseAgentPluginManifest(
      manifest(
        copse({
          tools: { native: ['read_file'], acpTools: ['read_file'], provides: ['acme_review'] },
        }),
      ),
    )
    assert.equal(parsed.tools?.native, undefined)
    assert.equal(parsed.tools?.acpTools, undefined)
    assert.deepEqual(parsed.tools?.provides, ['acme_review'])
    assert.equal(warnings.filter((w) => w.startsWith('Ignoring `tools.')).length, 2)
  })

  it('drops level-3 UI while keeping levels 1 and 2', () => {
    const { manifest: parsed, warnings } = parseAgentPluginManifest(
      manifest(
        copse({
          ui: [
            { id: 'card', level: 1 },
            { id: 'panel', level: 2, slot: 'side', panel: { kind: 'list' } },
            { id: 'view', level: 3, slot: 'settings-pack-detail' },
          ],
        }),
      ),
    )
    assert.deepEqual(
      parsed.ui?.map((contribution) => contribution.id),
      ['card', 'panel'],
    )
    assert.ok(warnings.some((w) => w.includes('level-3')))
  })

  it('cannot self-promote to first-party by declaring a trust field', () => {
    // `trust` is not a permitted top-level field, so it is reported and ignored
    // rather than honoured — the host assigns trust.
    const { manifest: parsed, warnings } = parseAgentPluginManifest(
      manifest({ trust: 'first-party' }),
    )
    assert.equal(parsed.trust, 'user')
    assert.ok(warnings.some((w) => w.includes('trust')))
  })
})
