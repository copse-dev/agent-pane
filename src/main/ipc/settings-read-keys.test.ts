// Contract test for the `settings:get` registration gate.
//
// The handler refuses a key with no registered schema, because such a key cannot
// survive the read: `getSetting` falls back to a type-check against the fallback,
// and the handler's `null` fallback matches only `null`. Before that gate existed,
// three keys read back as `null` whatever was stored, so the Settings form showed
// defaults and then wrote them back over the saved values (#1804).
//
// Refusing loudly only helps if the refusal can't reach a user, so this scans the
// renderer for the keys it actually reads and pins every one of them to the
// registry. A key added to a form without a schema fails here rather than
// throwing in someone's Settings dialog.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isRegisteredSettingKey } from '../services/storage/settings-schema.ts'

const ROOTS = ['src/renderer', 'src/preload'].map((dir) => resolve(process.cwd(), dir))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

const sources = new Map(ROOTS.flatMap(sourceFiles).map((p) => [p, readFileSync(p, 'utf8')]))
const allSource = [...sources.values()].join('\n')

/** `export const FOO_SETTING = 'foo'` across the repo, so a constant read resolves. */
function settingConstants(): Map<string, string> {
  const shared = resolve(process.cwd(), 'src/shared')
  const out = new Map<string, string>()
  for (const file of [...sourceFiles(shared), ...sources.keys()]) {
    const text = sources.get(file) ?? readFileSync(file, 'utf8')
    for (const m of text.matchAll(/export const ([A-Z0-9_]+) = '([A-Za-z][\w.]*)'/g)) {
      out.set(m[1] ?? '', m[2] ?? '')
    }
  }
  return out
}

/** The names driving the generic `loadSimpleFields` loop, which reads `field.name`. */
function simpleFieldNames(constants: ReadonlyMap<string, string>): string[] {
  const dialog = sources.get(resolve(process.cwd(), 'src/renderer/views/settings-dialog.ts'))
  assert.ok(dialog, 'settings-dialog.ts moved — update this test')
  const start = dialog.indexOf('const SIMPLE_FIELDS')
  const end = dialog.indexOf('async function loadSimpleFields')
  assert.ok(start !== -1 && end > start, 'SIMPLE_FIELDS block moved — update this test')
  const block = dialog.slice(start, end)
  return [
    ...[...block.matchAll(/name:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1] ?? ''),
    ...[...block.matchAll(/name:\s*([A-Z0-9_]+),/g)].map((m) => constants.get(m[1] ?? '') ?? ''),
  ].filter(Boolean)
}

describe('settings:get registration gate', () => {
  const constants = settingConstants()

  it('registers every settings key the renderer reads by name', () => {
    const keys = new Set<string>()
    const unresolved: string[] = []
    for (const m of allSource.matchAll(/settings\.get\(\s*(?:'([^']+)'|([A-Z0-9_]+))/g)) {
      const [, literal, constant] = m
      if (literal) {
        keys.add(literal)
      } else if (constant) {
        const value = constants.get(constant)
        if (value) keys.add(value)
        else unresolved.push(constant)
      }
    }
    // A constant this test cannot follow is a blind spot, not a pass.
    assert.deepEqual(unresolved, [], 'unresolvable setting-name constants at a read site')
    assert.ok(
      keys.size > 20,
      `expected to find the renderer's setting reads, found ${String(keys.size)}`,
    )

    assert.deepEqual([...keys].filter((k) => !isRegisteredSettingKey(k)).sort(), [])
  })

  it('registers every field the generic Settings load loop reads', () => {
    const names = simpleFieldNames(constants)
    assert.ok(names.length > 10, `expected SIMPLE_FIELDS entries, found ${String(names.length)}`)
    assert.deepEqual(names.filter((n) => !isRegisteredSettingKey(n)).sort(), [])
  })
})
