import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { FOREIGN_PAYLOADS, pruneForeignMacosPayloads } from './prune-macos-foreign-payloads.mts'

function createNodeModules(): string {
  const root = mkdtempSync(join(tmpdir(), 'copse-foreign-payloads-'))
  for (const prebuild of ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']) {
    mkdirSync(join(root, 'node-pty', 'prebuilds', prebuild), { recursive: true })
    writeFileSync(join(root, 'node-pty', 'prebuilds', prebuild, 'pty.node'), 'native fixture')
  }
  for (const path of FOREIGN_PAYLOADS) {
    mkdirSync(join(root, ...path), { recursive: true })
    writeFileSync(join(root, ...path, 'binary'), 'native fixture')
  }
  mkdirSync(join(root, '@anthropic-ai', 'sandbox-runtime', 'vendor', 'java-proxy-agent'))
  return root
}

describe('pruneForeignMacosPayloads', () => {
  it('removes Windows and Linux payloads while keeping every macOS prebuild', () => {
    const root = createNodeModules()

    pruneForeignMacosPayloads(root, 'arm64')

    assert.deepEqual(readdirSync(join(root, 'node-pty', 'prebuilds')).sort(), [
      'darwin-arm64',
      'darwin-x64',
    ])
    for (const path of FOREIGN_PAYLOADS) assert.equal(existsSync(join(root, ...path)), false)
    assert.deepEqual(readdirSync(join(root, '@anthropic-ai', 'sandbox-runtime', 'vendor')), [
      'java-proxy-agent',
    ])
    assert.doesNotThrow(() => {
      pruneForeignMacosPayloads(root, 'x64')
    })
  })

  it('fails closed when the target architecture lacks its node-pty prebuild', () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-foreign-payloads-'))
    mkdirSync(join(root, 'node-pty', 'prebuilds', 'darwin-arm64'), { recursive: true })

    assert.throws(() => {
      pruneForeignMacosPayloads(root, 'x64')
    }, /lacks its node-pty prebuild/)
  })
})
