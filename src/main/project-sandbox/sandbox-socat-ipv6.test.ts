import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'

/**
 * Guards `patches/@anthropic-ai__sandbox-runtime@0.0.74.patch` (#4409).
 *
 * Inside the sandbox's network namespace, socat bridges ports 3128 and 1080 to
 * the host proxy. Upstream starts them as unqualified `TCP-LISTEN`, which opens
 * an AF_INET6 socket and exits at once on a kernel booted with
 * `ipv6.disable=1`, leaving every proxied command without a network. The patch
 * uses `TCP4-LISTEN` when the kernel has no IPv6 stack (no
 * `/proc/net/if_inet6`) and keeps the dual-stack listener otherwise.
 *
 * Hosted CI has IPv6, so the real-bridge test
 * (`artifact-image/host-native.test.ts`) never sees the failing host. These
 * tests fake the kernel's answer and read the generated command instead.
 */
// The Linux bwrap backend only; other platforms never build this command.
describe(
  'sandbox-runtime in-namespace socat listeners (patched)',
  { skip: process.platform !== 'linux' },
  () => {
    afterEach(() => {
      mock.restoreAll()
      syncBuiltinESMExports()
    })

    async function wrapWithIpv6(available: boolean): Promise<string> {
      const realExistsSync = fs.existsSync
      mock.method(fs, 'existsSync', (path: fs.PathLike) =>
        path === '/proc/net/if_inet6' ? available : realExistsSync(path),
      )
      syncBuiltinESMExports()
      // The wrap only checks that the bridge sockets exist; plain files do.
      const dir = fs.mkdtempSync(join(tmpdir(), 'copse-socat-'))
      const httpSocketPath = join(dir, 'http.sock')
      const socksSocketPath = join(dir, 'socks.sock')
      fs.writeFileSync(httpSocketPath, '')
      fs.writeFileSync(socksSocketPath, '')
      try {
        return await wrapCommandWithSandboxLinux({
          command: 'true',
          needsNetworkRestriction: true,
          httpSocketPath,
          socksSocketPath,
          httpProxyPort: 3128,
          socksProxyPort: 1080,
          allowAllUnixSockets: true,
        })
      } finally {
        cleanupBwrapMountPoints()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }

    it('listens on IPv4 only when the kernel has no IPv6 stack', async () => {
      const wrapped = await wrapWithIpv6(false)
      assert.match(wrapped, /TCP4-LISTEN:3128,/, 'patch missing: HTTP listener is not IPv4')
      assert.match(wrapped, /TCP4-LISTEN:1080,/, 'patch missing: SOCKS listener is not IPv4')
      assert.doesNotMatch(wrapped, /\bTCP-LISTEN:/)
    })

    it('keeps the dual-stack listeners when IPv6 is available', async () => {
      const wrapped = await wrapWithIpv6(true)
      assert.match(wrapped, /\bTCP-LISTEN:3128,/)
      assert.match(wrapped, /\bTCP-LISTEN:1080,/)
      assert.doesNotMatch(wrapped, /TCP4-LISTEN:/)
    })
  },
)
