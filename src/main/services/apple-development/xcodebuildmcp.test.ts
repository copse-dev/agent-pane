import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createXcodeBuildMcpConfig,
  isXcodeBuildMcpToolName,
  prepareXcodeBuildMcpArguments,
  XCODEBUILD_MCP_TOOL_PREFIX,
  XCODEBUILD_MCP_WORKFLOWS,
} from './xcodebuildmcp.ts'

describe('XcodeBuildMCP integration', () => {
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
