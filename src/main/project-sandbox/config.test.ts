import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { accessSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  acpAgentSandboxOverlay,
  baseSandboxConfig,
  containedSandboxNetworkConfig,
  portBindingSandboxOverlay,
  electronRuntimeAllowReadPaths,
  ensureWorkspaceTmpDir,
  fsWorkerSandboxOverlay,
  resolveNodeToolchainAllowRead,
  sandboxNetworkConfig,
  workspaceMandatoryWriteDenyPaths,
  workspaceSandboxOverlay,
  workspaceTmpDir,
} from './config.ts'

describe('acpAgentSandboxOverlay', () => {
  const workspace = '/tmp/acp-sandbox-test-workspace'
  const sandbox = {
    allowedDomains: ['api.anthropic.com'],
    homeDirs: ['.claude', '.claude.json'],
  }

  it('allows only the agent-declared domains, no local binding', () => {
    const overlay = acpAgentSandboxOverlay(workspace, sandbox)
    assert.deepEqual(overlay.network, {
      allowedDomains: ['api.anthropic.com'],
      deniedDomains: [],
      allowLocalBinding: false,
    })
  })

  it('re-allows the agent home dirs for read and write on top of the workspace rules', () => {
    const overlay = acpAgentSandboxOverlay(workspace, sandbox)
    const base = workspaceSandboxOverlay(workspace)
    const claudeDir = join(homedir(), '.claude')
    for (const list of [overlay.filesystem?.allowRead, overlay.filesystem?.allowWrite]) {
      assert.ok(list, 'overlay must define allowRead/allowWrite')
      assert.ok(list.includes(claudeDir))
      assert.ok(list.includes(`${claudeDir}/**`))
      assert.ok(list.includes(join(homedir(), '.claude.json')))
    }
    // Base workspace rules survive: home still deny-read, workspace still writable.
    assert.deepEqual(overlay.filesystem?.denyRead, base.filesystem?.denyRead)
    for (const path of base.filesystem?.allowWrite ?? []) {
      assert.ok(overlay.filesystem?.allowWrite.includes(path))
    }
  })

  it('keeps the mandatory write-deny list (git hooks, rc files)', () => {
    const overlay = acpAgentSandboxOverlay(workspace, sandbox)
    const base = workspaceSandboxOverlay(workspace)
    assert.deepEqual(overlay.filesystem?.denyWrite, base.filesystem?.denyWrite)
  })

  it('allows hardcoded agent scratch paths with ${uid} expanded, in both /tmp spellings', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    const overlay = acpAgentSandboxOverlay(workspace, {
      ...sandbox,
      scratchPaths: ['/tmp/claude-${uid}'],
    })
    for (const list of [overlay.filesystem?.allowRead, overlay.filesystem?.allowWrite]) {
      assert.ok(list, 'overlay must define allowRead/allowWrite')
      assert.ok(list.includes(`/tmp/claude-${String(uid)}`))
      assert.ok(list.includes(`/tmp/claude-${String(uid)}/**`))
      // macOS: the kernel canonicalizes /tmp to /private/tmp — both must match.
      assert.ok(list.includes(`/private/tmp/claude-${String(uid)}`))
      assert.ok(list.includes(`/private/tmp/claude-${String(uid)}/**`))
    }
  })
})

describe('portBindingSandboxOverlay', () => {
  it('allows loopback binding on loopback-only domains', () => {
    const overlay = portBindingSandboxOverlay('/tmp/project')
    assert.deepEqual(overlay.network, {
      allowedDomains: ['localhost', '127.0.0.1', '::1'],
      deniedDomains: [],
      allowLocalBinding: true,
    })
  })

  it('keeps the workspace filesystem rules from the base overlay', () => {
    const base = workspaceSandboxOverlay('/tmp/project')
    const overlay = portBindingSandboxOverlay('/tmp/project')
    // Only the network is widened; filesystem confinement is unchanged.
    assert.deepEqual(overlay.filesystem, base.filesystem)
  })
})

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
    const { network } = overlay
    assert.ok(network)
    assert.deepEqual(network.allowedDomains, [])
    assert.deepEqual(network.deniedDomains, [])
    assert.equal(network.allowLocalBinding, false)
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
    const { filesystem } = overlay
    assert.ok(filesystem)
    // Home is broadly denied so projects cannot read unrelated user files...
    assert.ok(filesystem.denyRead.includes(home))
    // ...but git's user-level config must stay readable or seatbelt EPERM makes
    // every git command fatal (exit 128).
    assert.ok(filesystem.allowRead?.includes(join(home, '.gitconfig')))
    assert.ok(filesystem.allowRead?.includes(join(home, '.config/git/**')))
    assert.equal(filesystem.allowGitConfig, true)
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

  it('allows the workspace-owned tmp dir for read and write ($TMPDIR escape, #481)', () => {
    // Commands writing to the OS temp dir get blocked by the workspace seatbelt;
    // the overlay must also permit a workspace-owned scratch dir that spawn
    // points $TMPDIR at. It lives under the home dir, which is broadly denyRead,
    // so it must be re-allowed for read as well as write.
    const overlay = workspaceSandboxOverlay('/Users/me/project')
    const tmpDir = workspaceTmpDir()
    assert.ok(tmpDir.endsWith(join('.copse', 'workspace', 'tmp')))
    const allowWrite = overlay.filesystem?.allowWrite ?? []
    const allowRead = overlay.filesystem?.allowRead ?? []
    assert.ok(allowWrite.includes(tmpDir))
    assert.ok(allowWrite.some((p) => p === `${tmpDir}/**`))
    assert.ok(allowRead.includes(tmpDir))
    assert.ok(allowRead.some((p) => p === `${tmpDir}/**`))
  })

  it('falls back to resolve for a non-existent workspace root', () => {
    const ghost = join(tmpdir(), 'copse-nonexistent-workspace-xyz')
    const overlay = workspaceSandboxOverlay(ghost)
    const allowWrite = overlay.filesystem?.allowWrite ?? []
    assert.ok(allowWrite.includes(resolve(ghost)))
  })
})

describe('ensureWorkspaceTmpDir', () => {
  it('creates the workspace tmp dir and returns its path', () => {
    const dir = ensureWorkspaceTmpDir()
    assert.equal(dir, workspaceTmpDir())
    // Best-effort creation: the dir should exist after the call in a normal home.
    accessSync(dir)
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
