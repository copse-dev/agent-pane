import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { acpAgentSandboxOverlay, workspaceSandboxOverlay } from './config.ts'

describe('ASRT per-spawn macOS certificate verification', () => {
  it('keeps per-spawn trustd support in the installed runtime on every platform', async () => {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@anthropic-ai/sandbox-runtime')
    const manager = await readFile(join(dirname(entry), 'sandbox/sandbox-manager.js'), 'utf8')
    assert.match(
      manager,
      /enableWeakerNetworkIsolation: customConfig\?\.enableWeakerNetworkIsolation \?\? getEnableWeakerNetworkIsolation\(\)/,
    )
  })

  it(
    'emits trustd only in the opted-in profile, without changing the global policy',
    {
      skip: process.platform !== 'darwin',
    },
    async () => {
      // Exercise the installed runtime, not a stub: upstream used to silently
      // ignore this overlay and read only the global flag. No child or network
      // listener is needed to inspect the generated seatbelt profile.
      const globalConfig = SandboxManager.getConfig()
      const workspace = '/tmp/copse-acp-trustd-test'
      const trustRule = '(allow mach-lookup (global-name "com.apple.trustd.agent"))'
      const wrap = async (trusted: boolean): Promise<string> => {
        const { argv } = await SandboxManager.wrapWithSandboxArgv(
          'true',
          '/bin/sh',
          acpAgentSandboxOverlay(workspace, { allowedDomains: [], allowMacOsTrustd: trusted }),
        )
        return argv.join(' ')
      }
      assert.ok(!(await wrap(false)).includes(trustRule))
      const trusted = await wrap(true)
      assert.ok(trusted.includes(trustRule))
      assert.ok(trusted.includes('(deny default '))
      assert.ok(!trusted.includes('(allow network*)'))
      assert.ok(!(await wrap(false)).includes(trustRule))
      const ordinary = await SandboxManager.wrapWithSandboxArgv(
        'true',
        '/bin/sh',
        workspaceSandboxOverlay(workspace),
      )
      assert.ok(!ordinary.argv.join(' ').includes(trustRule))
      assert.deepEqual(SandboxManager.getConfig(), globalConfig)
    },
  )
})
