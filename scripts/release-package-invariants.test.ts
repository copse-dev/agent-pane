import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { resolve } from 'node:path'
import { MAIN_EXTERNALS } from './main-externals.mts'

function record(value: unknown, name: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `${name} object`)
  return Object.fromEntries(Object.entries(value))
}

function dependencyNames(packageJson: Record<string, unknown>, field: string): string[] {
  return Object.keys(record(packageJson[field], `package.json ${field}`)).sort()
}

describe('release package invariants', () => {
  const parsed: unknown = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const packageJson = record(parsed, 'package.json')

  it('ships only main-process externals as ordinary production dependencies', () => {
    const expected = MAIN_EXTERNALS.filter((name) => name !== 'electron').sort()
    assert.deepEqual(dependencyNames(packageJson, 'dependencies'), expected)
  })

  it('keeps the optional runtime surface small and architecture-explicit', () => {
    assert.deepEqual(dependencyNames(packageJson, 'optionalDependencies'), [
      '@napi-rs/keyring-darwin-arm64',
      '@napi-rs/keyring-darwin-x64',
      '@nationaldesignstudio/rampart',
    ])
    assert.ok(
      !dependencyNames(packageJson, 'optionalDependencies').includes('@huggingface/transformers'),
      'the default-off contextual PII model must not inflate every base install',
    )
  })

  it('does not put release source maps into the application archive', () => {
    const build = record(packageJson['build'], 'package.json build')
    const files = build['files']
    assert.ok(Array.isArray(files))
    assert.ok(files.includes('!**/*.map'))
  })

  it('uses the generated Copse icon for both the app and mounted DMG', () => {
    const build = record(packageJson['build'], 'package.json build')
    const mac = record(build['mac'], 'package.json build.mac')
    const dmg = record(build['dmg'], 'package.json build.dmg')
    assert.equal(mac['icon'], 'assets/icons/app.icns')
    assert.equal(dmg['icon'], mac['icon'])

    const scripts = record(packageJson['scripts'], 'package.json scripts')
    assert.match(String(scripts['dist:mac']), /pnpm run generate:icon/)
    assert.match(String(scripts['release:dry']), /pnpm run generate:icon/)

    const workflow = readFileSync(resolve('.github/workflows/release-mac.yml'), 'utf8')
    assert.match(workflow, /pnpm run generate:icon/)
    assert.match(workflow, /\.VolumeIcon\.icns/)
    assert.match(workflow, /custom-volume-icon flag/)

    const generator = readFileSync(resolve('scripts/generate-icon.mts'), 'utf8')
    assert.match(generator, /SRGB_PNG_CHUNK/)
    assert.doesNotMatch(generator, /iconutil failed/)
  })

  it('removes the unused native keyring architecture before signing', () => {
    const afterPack = readFileSync(resolve('scripts/after-pack.cjs'), 'utf8')
    assert.match(afterPack, /unusedKeyringPackageArch/)
    assert.match(afterPack, /rmSync\([\s\S]*keyring-darwin-/)
  })
})
