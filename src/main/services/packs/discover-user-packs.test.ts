// Host discovery tests for marketplace P1 — local user packs under a configured root.
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PackRegistry } from '@copse/agent/packs/pack-registry.ts'
import { definePack } from '@copse/agent/packs/pack-manifest.ts'
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import {
  discoverAndRegisterUserPacks,
  resolveUserPackManifestPath,
  userPacksRoot,
} from './discover-user-packs.ts'

const FIXTURES_ROOT = join(process.cwd(), 'tests/fixtures/user-packs')

describe('discoverAndRegisterUserPacks', () => {
  let previousPacksDir: string | undefined
  let tempRoot: string

  beforeEach(() => {
    previousPacksDir = process.env['COPSE_PACKS_DIR']
    tempRoot = mkdtempSync(join(tmpdir(), 'copse-user-packs-'))
    process.env['COPSE_PACKS_DIR'] = tempRoot
  })

  afterEach(() => {
    if (previousPacksDir === undefined) delete process.env['COPSE_PACKS_DIR']
    else process.env['COPSE_PACKS_DIR'] = previousPacksDir
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('resolves COPSE_PACKS_DIR for the packs root', () => {
    assert.equal(userPacksRoot(), tempRoot)
  })

  it('prefers copse-pack.json over plugin.json', () => {
    const packDir = join(tempRoot, 'prefer')
    mkdirSync(packDir)
    writeFileSync(join(packDir, 'plugin.json'), '{"name":"from.plugin"}')
    writeFileSync(join(packDir, 'copse-pack.json'), '{"name":"from.copse"}')
    assert.equal(resolveUserPackManifestPath(packDir), join(packDir, 'copse-pack.json'))
  })

  it('registers fixture user packs, forces untrusted prompts, strips native tools', () => {
    cpSync(FIXTURES_ROOT, tempRoot, { recursive: true })
    const registry = new PackRegistry()
    const result = discoverAndRegisterUserPacks(registry, tempRoot)

    assert.equal(result.root, tempRoot)
    const registered = result.entries.filter((e) => e.status === 'registered')
    assert.ok(registered.length >= 3)

    assert.equal(registry.has('fixture.demo-notes'), true)
    assert.equal(registry.has('fixture.sneaky-prompt'), true)
    assert.equal(registry.has('fixture.claims-native'), true)

    const sneaky = registry.get('fixture.sneaky-prompt')
    assert.ok(sneaky)
    assert.equal(sneaky.trust, 'user')
    assert.deepEqual(
      sneaky.contributions.promptBlocks.map((b) => b.trust),
      ['untrusted'],
    )

    const claimsNative = registry.get('fixture.claims-native')
    assert.ok(claimsNative)
    assert.equal(claimsNative.manifest.tools?.native, undefined)
    assert.equal(claimsNative.manifest.tools?.mcpServers, '.mcp.json')
    assert.deepEqual(claimsNative.contributions.toolNames, [])

    const nativeNotes =
      result.entries.find((e) => e.packId === 'fixture.claims-native')?.notes ?? []
    assert.ok(nativeNotes.some((n) => n.kind === 'stripped-native-tools'))

    // Atomic enable/disable for a discovered user pack.
    assert.equal(registry.isEnabled('fixture.demo-notes'), true)
    assert.ok(registry.activePromptBlocks().some((b) => b.id === 'notes-steering'))
    registry.disable('fixture.demo-notes')
    assert.equal(registry.isEnabled('fixture.demo-notes'), false)
    assert.equal(
      registry.activePromptBlocks().some((b) => b.id === 'notes-steering'),
      false,
    )
  })

  it('skips duplicate ids instead of crashing boot (first-party collision)', () => {
    const packDir = join(tempRoot, 'collide')
    mkdirSync(packDir)
    // Pick a real first-party id so discovery must lose to the shipped pack.
    writeFileSync(
      join(packDir, 'plugin.json'),
      JSON.stringify({ name: 'copse.todos', description: 'impersonation attempt' }),
    )
    const registry = createFirstPartyPackRegistry()
    const result = discoverAndRegisterUserPacks(registry, tempRoot)
    assert.equal(result.entries.length, 1)
    const entry = result.entries[0]
    assert.ok(entry)
    assert.equal(entry.status, 'skipped')
    assert.match(entry.reason ?? '', /duplicate pack id/)
    assert.equal(registry.get('copse.todos')?.trust, 'first-party')
  })

  it('is inert when the packs root is missing', () => {
    const missing = join(tempRoot, 'does-not-exist')
    const registry = new PackRegistry()
    registry.register(definePack({ name: 'keep.me', trust: 'first-party' }))
    const result = discoverAndRegisterUserPacks(registry, missing)
    assert.deepEqual(result.entries, [])
    assert.equal(registry.has('keep.me'), true)
  })

  it('skips invalid JSON without aborting the rest of the scan', () => {
    const bad = join(tempRoot, 'bad')
    const good = join(tempRoot, 'good')
    mkdirSync(bad)
    mkdirSync(good)
    writeFileSync(join(bad, 'plugin.json'), '{not-json')
    writeFileSync(join(good, 'plugin.json'), JSON.stringify({ name: 'fixture.good' }))
    const registry = new PackRegistry()
    const result = discoverAndRegisterUserPacks(registry, tempRoot)
    assert.equal(registry.has('fixture.good'), true)
    assert.equal(result.entries.find((e) => e.dirName === 'bad')?.status, 'skipped')
    assert.equal(result.entries.find((e) => e.dirName === 'good')?.status, 'registered')
  })
})
