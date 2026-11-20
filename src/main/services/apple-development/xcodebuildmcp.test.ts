import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { storageDelete, storageSet } from '../storage/storage.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { APPLE_DEVELOPMENT_PLUGIN_ID } from '@copse/agent/plugins/apple-development-plugin.ts'
import {
  createXcodeBuildMcpConfig,
  getXcodeBuildMcpConfig,
  xcodeBuildMcpToolTimeoutMs,
  isXcodeBuildMcpToolName,
  prepareXcodeBuildMcpArguments,
  XCODEBUILD_MCP_TOOL_PREFIX,
  XCODEBUILD_MCP_WORKFLOWS,
} from './xcodebuildmcp.ts'

describe('XcodeBuildMCP integration', () => {
  it('keeps source defaults when building test products and clears them only for prepared execution', () => {
    const entry = createRequire(join(process.cwd(), 'package.json')).resolve('xcodebuildmcp')
    execFileSync(
      process.execPath,
      [join(process.cwd(), 'tests/fixtures/xcodebuildmcp-session-defaults.mjs'), entry],
      { timeout: 15_000 },
    )
  })

  it('cancels native child execution through the real registered MCP handler', () => {
    const entry = createRequire(join(process.cwd(), 'package.json')).resolve('xcodebuildmcp')
    execFileSync(
      process.execPath,
      [join(process.cwd(), 'tests/fixtures/xcodebuildmcp-cancellation.mjs'), entry],
      { timeout: 15_000 },
    )
  })

  it('launches the pinned entry as an Electron Node child with every workflow enabled', () => {
    const config = createXcodeBuildMcpConfig({
      root: '/workspace/project',
      entryPath: '/app/node_modules/xcodebuildmcp/build/cli.js',
      execPath: '/app/Copse',
    })
    assert.equal(config.name, 'xcodebuildmcp')
    assert.equal(config.transport, 'stdio')
    assert.equal(config.command, '/app/Copse')
    assert.deepEqual(config.args, ['/app/node_modules/xcodebuildmcp/build/cli.js', 'mcp'])
    assert.equal(config.cwd, '/workspace/project')
    assert.ok(config.env)
    assert.equal(config.env['ELECTRON_RUN_AS_NODE'], '1')
    assert.equal(config.env['XCODEBUILDMCP_SENTRY_DISABLED'], 'true')
    assert.deepEqual(config.env['XCODEBUILDMCP_ENABLED_WORKFLOWS']?.split(','), [
      ...XCODEBUILD_MCP_WORKFLOWS,
    ])
  })

  it('bounds native build/test and boot calls beyond the SDK default', () => {
    for (const tool of ['build_sim', 'build_run_sim', 'test_sim', 'build_macos', 'test_device'])
      assert.equal(xcodeBuildMcpToolTimeoutMs(tool), 1_200_000)
    assert.equal(xcodeBuildMcpToolTimeoutMs('boot_sim'), 240_000)
    assert.equal(xcodeBuildMcpToolTimeoutMs('list_sims'), undefined)
    assert.equal(xcodeBuildMcpToolTimeoutMs('session_set_defaults'), undefined)
  })

  it('recognizes only the reserved MCP tool prefix', () => {
    assert.equal(isXcodeBuildMcpToolName(`${XCODEBUILD_MCP_TOOL_PREFIX}build_macos`), true)
    assert.equal(isXcodeBuildMcpToolName('mcp__other__build_macos'), false)
  })

  it('adds approved provisioning updates only to Xcode build and test calls', () => {
    assert.deepEqual(prepareXcodeBuildMcpArguments('build_run_macos', { extraArgs: ['-quiet'] }), {
      extraArgs: ['-quiet', '-allowProvisioningUpdates'],
    })
    assert.deepEqual(
      prepareXcodeBuildMcpArguments('test_sim', {
        extraArgs: ['-allowProvisioningUpdates'],
      }),
      { extraArgs: ['-allowProvisioningUpdates'] },
    )
    assert.deepEqual(prepareXcodeBuildMcpArguments('launch_app_sim', { extraArgs: ['-quiet'] }), {
      extraArgs: ['-quiet'],
    })
  })
})

describe('XcodeBuildMCP requested project authority', () => {
  const a = '/copse-fixture/project-a'
  const b = '/copse-fixture/project-b'
  let platform: PropertyDescriptor

  beforeEach(() => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    assert.ok(descriptor)
    platform = descriptor
    // Exercise the existing OS gate on every CI host; no process/toolchain starts.
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' })
    const plugins = createFirstPartyPluginRegistry()
    plugins.enable(APPLE_DEVELOPMENT_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)
    storageSet('projects', [
      { id: 'a', path: a },
      { id: 'b', path: b },
    ])
    storageSet('activeProjectId', 'b')
    storageSet('plugin.copse.apple-development.state', {
      version: 1,
      projects: { a: { enrolled: true, threads: {} }, b: { enrolled: true, threads: {} } },
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    setDefaultPluginRegistry(null)
    for (const key of ['projects', 'activeProjectId', 'plugin.copse.apple-development.state'])
      storageDelete(key)
  })

  it('uses the admitted A project while B is selected', () => {
    assert.equal(getXcodeBuildMcpConfig(a, 'a')?.cwd, a)
    assert.equal(getXcodeBuildMcpConfig(b, 'b')?.cwd, b)
  })

  it('does not borrow B enrollment for unenrolled A', () => {
    storageSet('plugin.copse.apple-development.state', {
      version: 1,
      projects: { a: { enrolled: false, threads: {} }, b: { enrolled: true, threads: {} } },
    })
    assert.equal(getXcodeBuildMcpConfig(a, 'a'), null)
  })

  it('rejects a requested project whose persisted root does not match the connection set', () => {
    assert.equal(getXcodeBuildMcpConfig(a, 'b'), null)
    assert.equal(getXcodeBuildMcpConfig(a, 'missing'), null)
  })

  it('loads the matching UI project while active-selection persistence catches up', () => {
    assert.equal(getXcodeBuildMcpConfig(a)?.cwd, a)
    assert.equal(getXcodeBuildMcpConfig('/copse-fixture/unknown'), null)
  })

  it('does not select another enrolled identity for an ambiguous unowned workspace', () => {
    storageSet('projects', [
      { id: 'a', path: a },
      { id: 'another-a', path: a },
      { id: 'b', path: b },
    ])
    assert.equal(getXcodeBuildMcpConfig(a), null)
  })

  it('retains plugin, remote-project and host-platform restrictions', () => {
    storageSet('projects', [{ id: 'a', path: a, sshHost: 'remote' }])
    assert.equal(getXcodeBuildMcpConfig(a, 'a'), null)
    storageSet('projects', [{ id: 'a', path: a }])
    const plugins = createFirstPartyPluginRegistry()
    plugins.disable(APPLE_DEVELOPMENT_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)
    assert.equal(getXcodeBuildMcpConfig(a, 'a'), null)
    plugins.enable(APPLE_DEVELOPMENT_PLUGIN_ID)
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    assert.equal(getXcodeBuildMcpConfig(a, 'a'), null)
  })
})
