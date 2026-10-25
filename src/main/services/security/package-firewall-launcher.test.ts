import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { globalNpmInstallArgs, PACKAGE_FIREWALL_LAUNCH_ENV } from './package-firewall-launcher.ts'

const LAUNCHER = {
  execPath: '/Applications/Copse.app/Contents/MacOS/Copse',
  scriptPath: '/app/dist/main/package-firewall.js',
}

describe('globalNpmInstallArgs', () => {
  it('runs npm behind the firewall script with lifecycle scripts disabled', () => {
    assert.deepEqual(
      globalNpmInstallArgs(LAUNCHER, '/opt/node/bin/npm', '@agentclientprotocol/codex-acp'),
      [
        '/app/dist/main/package-firewall.js',
        '/opt/node/bin/npm',
        'install',
        '-g',
        '--ignore-scripts',
        '@agentclientprotocol/codex-acp',
      ],
    )
  })

  it('launches the app binary as Node', () => {
    assert.deepEqual(PACKAGE_FIREWALL_LAUNCH_ENV, { ELECTRON_RUN_AS_NODE: '1' })
  })
})
