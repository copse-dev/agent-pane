import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveNodeToolchainAllowRead, workspaceSandboxOverlay } from './config.ts'

describe('resolveNodeToolchainAllowRead', () => {
  it('includes the active node binary and its install tree', () => {
    const allow = resolveNodeToolchainAllowRead(process.env)
    assert.ok(allow.length > 0, 'expected toolchain paths from process.env.PATH')

    let nodePath: string | null = null
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue
      const candidate = resolve(dir, 'node')
      try {
        accessSync(candidate)
        nodePath = candidate
        break
      } catch {
        // keep scanning PATH
      }
    }
    assert.ok(nodePath, 'node must be on PATH for this test environment')
    assert.ok(allow.includes(nodePath))

    const binDir = dirname(nodePath)
    assert.ok(allow.includes(binDir))
    assert.ok(allow.some((p) => p === `${binDir}/**`))
  })
})

describe('workspaceSandboxOverlay', () => {
  it('re-allows node toolchain paths alongside the workspace', () => {
    const overlay = workspaceSandboxOverlay('/tmp/project')
    const allowRead = overlay.filesystem?.allowRead ?? []
    assert.ok(allowRead.includes('/tmp/project'))
    assert.ok(allowRead.some((p) => p.includes('/tmp/project/**')))

    const toolchain = resolveNodeToolchainAllowRead(process.env)
    if (toolchain.length > 0) {
      assert.ok(toolchain.every((p) => allowRead.includes(p)))
    }
  })

  it('denies home reads but re-allows git config files', () => {
    const overlay = workspaceSandboxOverlay('/Users/me/project')
    const home = homedir()
    // Home is broadly denied so projects cannot read unrelated user files...
    assert.ok(overlay.filesystem?.denyRead?.includes(home))
    // ...but git's user-level config must stay readable or seatbelt EPERM makes
    // every git command fatal (exit 128).
    assert.ok(overlay.filesystem?.allowRead?.includes(join(home, '.gitconfig')))
    assert.ok(overlay.filesystem?.allowRead?.includes(join(home, '.config/git/**')))
    assert.equal(overlay.filesystem?.allowGitConfig, true)
  })

  it('includes workspace-scoped mandatory write deny paths', () => {
    const overlay = workspaceSandboxOverlay('/Users/me/project')
    const denyWrite = overlay.filesystem?.denyWrite ?? []
    assert.ok(denyWrite.includes('/Users/me/project/.git/hooks'))
    assert.ok(denyWrite.some((p) => p === '**/.git/hooks/**'))
  })
})
