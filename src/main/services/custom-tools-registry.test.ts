import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from './tool-registry.ts'
import { loadCustomToolsFromDir } from './custom-tools-registry.ts'

// Exercises the real fs + dynamic-import loader against on-disk fixture modules.
let dir: string

before(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'copse-custom-tools-'))
  await fs.writeFile(
    join(dir, 'echo.mjs'),
    `export default {
       name: 'echo',
       description: 'Echo',
       inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
       async execute({ msg }) { return 'got ' + msg },
     }`,
  )
  // A single file may export an array of tools.
  await fs.writeFile(
    join(dir, 'pair.mjs'),
    `export default [
       { name: 'one', execute: () => '1' },
       { name: 'two', execute: () => '2' },
     ]`,
  )
  // A factory (function) default export is invoked to produce the tool(s).
  await fs.writeFile(
    join(dir, 'factory.mjs'),
    `export default () => ({ name: 'made', execute: () => 'x' })`,
  )
  // Malformed: missing execute — reported, not registered, and isolated.
  await fs.writeFile(join(dir, 'broken.mjs'), `export default { name: 'nope' }`)
  // Non-loadable extension is ignored entirely.
  await fs.writeFile(join(dir, 'notes.txt'), `not a module`)
})

after(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('loadCustomToolsFromDir', () => {
  it('registers valid tools (object, array, factory) under the custom__ prefix', async () => {
    const registry = new ToolRegistry()
    const statuses = await loadCustomToolsFromDir(registry, dir)

    for (const name of ['custom__echo', 'custom__one', 'custom__two', 'custom__made']) {
      assert.ok(registry.has(name), `expected ${name} to be registered`)
    }

    const registered = statuses
      .filter((s) => s.registered)
      .map((s) => s.name)
      .sort()
    assert.deepEqual(registered, ['echo', 'made', 'one', 'two'])

    // Registered tools surface their JSON Schema verbatim to providers.
    const echo = registry.toLLMTools().find((t) => t.name === 'custom__echo')
    assert.equal((echo!.parameters as { type: string }).type, 'object')
  })

  it('isolates a malformed file: reports an error without registering it', async () => {
    const registry = new ToolRegistry()
    const statuses = await loadCustomToolsFromDir(registry, dir)

    assert.ok(!registry.has('custom__nope'))
    const broken = statuses.find((s) => s.source.endsWith('broken.mjs'))
    assert.ok(broken && !broken.registered)
    assert.match(broken.error!, /missing an "execute"/)
  })

  it('ignores non-loadable extensions', async () => {
    const registry = new ToolRegistry()
    const statuses = await loadCustomToolsFromDir(registry, dir)
    assert.ok(!statuses.some((s) => s.source.endsWith('notes.txt')))
  })

  it('returns empty for a missing directory', async () => {
    const registry = new ToolRegistry()
    const statuses = await loadCustomToolsFromDir(registry, join(dir, 'does-not-exist'))
    assert.deepEqual(statuses, [])
    assert.equal(registry.names().length, 0)
  })
})
