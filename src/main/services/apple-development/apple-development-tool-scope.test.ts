import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { storageDelete, storageSet } from '../storage/storage.ts'
import { activeBridgeToolNames } from '../acp/acp-native-bridge.ts'
import {
  isAppleDevelopmentToolName,
  isAppleDevelopmentToolOffered,
} from './apple-development-tool-scope.ts'

const STORE_KEY = 'plugin.copse.apple-development.state'
const SIMULATOR_TOOL = 'open_simulator_desktop'
const XCODE_TOOL = 'mcp__xcodebuildmcp__build_sim'

function enroll(...projectIds: string[]): void {
  storageSet(STORE_KEY, {
    version: 1,
    projects: Object.fromEntries(projectIds.map((id) => [id, { enrolled: true, threads: {} }])),
  })
}

describe('Apple Development tool scope', () => {
  beforeEach(() => {
    storageDelete(STORE_KEY)
    storageDelete('projects')
  })

  afterEach(() => {
    storageDelete(STORE_KEY)
    storageDelete('projects')
    setDefaultPluginRegistry(null)
  })

  it('recognises the Simulator bridge and XcodeBuildMCP tools only', () => {
    assert.equal(isAppleDevelopmentToolName(SIMULATOR_TOOL), true)
    assert.equal(isAppleDevelopmentToolName(XCODE_TOOL), true)
    assert.equal(isAppleDevelopmentToolName('read_file'), false)
    assert.equal(isAppleDevelopmentToolName('mcp__github__list_prs'), false)
  })

  it('leaves every other tool untouched', () => {
    assert.equal(isAppleDevelopmentToolOffered('read_file', undefined, 'linux'), true)
    assert.equal(isAppleDevelopmentToolOffered('mcp__github__list_prs', 'web', 'linux'), true)
  })

  it('offers Apple tools only to an enrolled project on a local macOS host', () => {
    enroll('ios-app')
    storageSet('projects', [
      { id: 'ios-app', path: '/ios-app' },
      { id: 'web', path: '/web' },
    ])

    for (const tool of [SIMULATOR_TOOL, XCODE_TOOL]) {
      assert.equal(isAppleDevelopmentToolOffered(tool, 'ios-app', 'darwin'), true, tool)
      assert.equal(isAppleDevelopmentToolOffered(tool, 'web', 'darwin'), false, tool)
      assert.equal(isAppleDevelopmentToolOffered(tool, undefined, 'darwin'), false, tool)
      assert.equal(isAppleDevelopmentToolOffered(tool, 'ios-app', 'linux'), false, tool)
    }
  })

  it('withholds Apple tools from an enrolled remote project', () => {
    enroll('remote-ios')
    storageSet('projects', [{ id: 'remote-ios', path: '/ios', sshHost: 'builder' }])

    assert.equal(isAppleDevelopmentToolOffered(SIMULATOR_TOOL, 'remote-ios', 'darwin'), false)
  })

  it('scopes the tools an ACP agent is offered over the native bridge', () => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.enable(APPLE_DEVELOPMENT_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)
    enroll('ios-app')
    storageSet('projects', [{ id: 'ios-app', path: '/ios-app' }])

    assert.equal(activeBridgeToolNames('web').includes(SIMULATOR_TOOL), false)
    assert.equal(activeBridgeToolNames(undefined).includes(SIMULATOR_TOOL), false)
    assert.equal(
      activeBridgeToolNames('ios-app').includes(SIMULATOR_TOOL),
      process.platform === 'darwin',
    )
    assert.ok(activeBridgeToolNames('web').includes('read_file'))
  })
})
