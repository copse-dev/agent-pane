import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  baseSandboxConfig,
  containedSandboxNetworkConfig,
  electronRuntimeAllowReadPaths,
  fsWorkerSandboxOverlay,
  resolveNodeToolchainAllowRead,
  sandboxNetworkConfig,
  workspaceMandatoryWriteDenyPaths,
  workspaceSandboxOverlay,
} from './config.ts'

describe('resolveNodeToolchainAllowRead', () => {
  it('includes the active node binary and its install tree', () => {
    const allow = resolveNodeToolchainAllowRead(process.env)
    assert.ok(allow.length > 0, 'expected toolchain paths from process.env.PATH')

    let nodePath: string | null = null
    for (const dir of (process.env['PATH'] ?? '').split(':')) {
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
  it('denies all network for the auto-run, sandbox-contained path (M6)', () => {
    // Auto-run commands reach the seatbelt only through this overlay; the
    // classifier presents them as "Network: denied", so the contained policy
    // must allow no domains and no local socket binding. User-approved network
    // commands run fully unsandboxed, never through this overlay.
    const overlay = workspaceSandboxOverlay('/tmp/project')
    assert.deepEqual(overlay.network?.allowedDomains, [])
    assert.deepEqual(overlay.network?.deniedDomains, [])
    assert.equal(overlay.network?.allowLocalBinding, false)
  })

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

  it('canonicalizes the workspace root through symlinks (macOS /var vs /private/var)', () => {
    // macOS temp dirs live under /var/folders, where /var -> /private/var. The
    // seatbelt sandbox enforces against the canonical path, so allow/deny rules
    // built from the symlinked path would never match and git commit fails with
    // EPERM on .git. Reproduce cross-platform with an explicit symlink.
    const tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'copse-sandbox-')))
    try {
      const realWorkspace = join(tmpRoot, 'workspace')
      const linkedWorkspace = join(tmpRoot, 'linked')
      mkdirSync(realWorkspace)
      symlinkSync(realWorkspace, linkedWorkspace, 'dir')

      const overlay = workspaceSandboxOverlay(linkedWorkspace)
      const allowWrite = overlay.filesystem?.allowWrite ?? []
      // Rules must use the canonical target, never the symlink path.
      assert.ok(allowWrite.includes(realWorkspace))
      assert.ok(allowWrite.some((p) => p === `${realWorkspace}/**`))
      assert.ok(!allowWrite.includes(linkedWorkspace))

      const denyWrite = workspaceMandatoryWriteDenyPaths(linkedWorkspace)
      assert.ok(denyWrite.includes(join(realWorkspace, '.git/hooks')))
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('falls back to resolve for a non-existent workspace root', () => {
    const ghost = join(tmpdir(), 'copse-nonexistent-workspace-xyz')
    const overlay = workspaceSandboxOverlay(ghost)
    const allowWrite = overlay.filesystem?.allowWrite ?? []
    assert.ok(allowWrite.includes(resolve(ghost)))
  })
})

describe('sandboxNetworkConfig', () => {
  it('maps allowed origins to Claude-style sandbox domains', () => {
    const network = sandboxNetworkConfig([
      'https://example.com:8443',
      'https://*.example.com',
      'http://localhost:*',
    ])
    assert.deepEqual(network.allowedDomains, ['example.com', '*.example.com', 'localhost'])
    assert.deepEqual(network.deniedDomains, [])
    assert.equal(network.allowLocalBinding, true)
  })
})

describe('containedSandboxNetworkConfig', () => {
  it('allows no domains and no local binding', () => {
    const network = containedSandboxNetworkConfig()
    assert.deepEqual(network.allowedDomains, [])
    assert.deepEqual(network.deniedDomains, [])
    assert.equal(network.allowLocalBinding, false)
  })

  it('is the network policy the base sandbox config initializes with', () => {
    assert.deepEqual(baseSandboxConfig().network, containedSandboxNetworkConfig())
  })
})

describe('fsWorkerSandboxOverlay', () => {
  it('extends workspace allowRead with the worker script dir and Electron runtime', () => {
    const worker = join(
      '/Applications/Copse.app/Contents/Resources/app/dist/main',
      'sandbox-fs-worker.js',
    )
    const overlay = fsWorkerSandboxOverlay('/Users/me/project', worker)
    const allowRead = overlay.filesystem?.allowRead ?? []
    assert.ok(allowRead.includes('/Users/me/project'))
    assert.ok(allowRead.includes(dirname(resolve(worker))))
    for (const p of electronRuntimeAllowReadPaths()) {
      assert.ok(allowRead.includes(p))
    }
  })
})

describe('fsWorkerSandboxOverlay', () => {
  it('extends workspace allowRead with the worker script dir and Electron runtime', () => {
    const worker = join(
      '/Applications/Copse.app/Contents/Resources/app/dist/main',
      'sandbox-fs-worker.js',
    )
    const overlay = fsWorkerSandboxOverlay('/Users/me/project', worker)
    const allowRead = overlay.filesystem?.allowRead ?? []
    assert.ok(allowRead.includes('/Users/me/project'))
    assert.ok(allowRead.includes(dirname(resolve(worker))))
    for (const p of electronRuntimeAllowReadPaths()) {
      assert.ok(allowRead.includes(p))
    }
  })
})
