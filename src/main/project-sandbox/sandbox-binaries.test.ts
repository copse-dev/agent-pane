import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { downloaderSandboxConfig } from '../services/remote/artifact-image/host.ts'
import { baseSandboxConfig } from './config.ts'
import {
  applySeccompBinaryPath,
  resolveSandboxBinary,
  unpackedAsarPath,
} from './sandbox-binaries.ts'

describe('resolveSandboxBinary', () => {
  it('probes the system directories, then only the absolute PATH entries, in order', () => {
    const probed: string[] = []
    const found = resolveSandboxBinary('bwrap', ':bin:/opt/a/bin:.:./x::/opt/b/bin:', (path) => {
      probed.push(path)
      return false
    })
    assert.deepEqual(probed, [
      '/usr/bin/bwrap',
      '/bin/bwrap',
      '/opt/a/bin/bwrap',
      '/opt/b/bin/bwrap',
    ])
    // Nothing found: the standard location, for ASRT's dependency check to reject.
    assert.equal(found, '/usr/bin/bwrap')
  })

  it('prefers a system copy over one in an earlier PATH entry', () => {
    const present = new Set(['/opt/a/bin/bwrap', '/bin/bwrap'])
    assert.equal(
      resolveSandboxBinary('bwrap', '/opt/a/bin:/usr/bin:/bin', (path) => present.has(path)),
      '/bin/bwrap',
    )
  })

  it('finds a copy that only an absolute PATH entry holds', () => {
    assert.equal(
      resolveSandboxBinary('socat', 'bin:/opt/a/bin', (path) => path === '/opt/a/bin/socat'),
      '/opt/a/bin/socat',
    )
  })
})

describe('apply-seccomp in a packaged app', () => {
  const packaged =
    '/opt/Copse/resources/app.asar/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp'

  it('execs the asarUnpack copy instead of the archive entry', () => {
    assert.equal(
      applySeccompBinaryPath(packaged),
      '/opt/Copse/resources/app.asar.unpacked/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp',
    )
  })

  it('leaves a development install and a missing helper alone', () => {
    const dev = '/repo/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp'
    assert.equal(applySeccompBinaryPath(dev), dev)
    assert.equal(applySeccompBinaryPath(null), null)
  })

  it('rewrites only a whole app.asar path segment', () => {
    assert.equal(unpackedAsarPath('/srv/my-app.asar/bin/x'), '/srv/my-app.asar/bin/x')
    assert.equal(unpackedAsarPath('/a/app.asar.unpacked/bin/x'), '/a/app.asar.unpacked/bin/x')
  })
})

describe('the configs Copse initializes ASRT with on Linux', () => {
  function onLinux<T>(run: () => T): T {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    assert.ok(platform)
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      return run()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  }

  const builders: Record<string, () => SandboxRuntimeConfig> = {
    project: baseSandboxConfig,
    downloader: () =>
      downloaderSandboxConfig({
        proxyPort: 1234,
        allowedHosts: ['example.com'],
        downloaderPath: '/tmp/downloader.cjs',
        runtimeReadPaths: [],
      }),
  }

  for (const [name, build] of Object.entries(builders)) {
    it(`names bubblewrap and socat by absolute path in the ${name} config`, () => {
      const config = onLinux(build)
      for (const path of [config.bwrapPath, config.socatPath]) {
        assert.ok(typeof path === 'string' && posix.isAbsolute(path), String(path))
      }
    })

    it(`names apply-seccomp explicitly in the ${name} config`, () => {
      const applyPath = onLinux(build).seccomp?.applyPath
      assert.ok(typeof applyPath === 'string' && posix.isAbsolute(applyPath), String(applyPath))
      assert.ok(!applyPath.includes('/app.asar/'), applyPath)
    })
  }
})
