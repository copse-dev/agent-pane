import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { MCP_UI_CANVAS_PLUGIN_ID } from '@copse/agent/plugins/mcp-ui-canvas-plugin.ts'
import { DARK_FACTORY_PLUGIN_ID } from '@copse/agent/plugins/dark-factory-plugin.ts'
import type { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { CANVAS_SERVER_NAME } from './bundled-mcp-server.ts'
import { mcpToolName } from './mcp-config.ts'
import {
  loadMcpServers,
  reloadMcpServersForPluginToggle,
  shutdownMcpServers,
} from './mcp-registry.ts'

// `plugins:set-enabled` delegates the MCP side of a first-party toggle to
// `reloadMcpServersForPluginToggle`. These exercise the real bundled canvas
// server through it in both directions. `COPSE_AGENT_EVAL` keeps configured
// (user/project) servers out of the load — the bundled in-process server still
// connects under it, and it is the only one these tests look at.

const RENDER_TOOL = mcpToolName(CANVAS_SERVER_NAME, 'render_html_artefact')

describe('reloadMcpServersForPluginToggle', () => {
  let plugins: PluginRegistry
  let tools: ToolRegistry
  let previousEvalFlag: string | undefined

  before(() => {
    previousEvalFlag = process.env['COPSE_AGENT_EVAL']
    process.env['COPSE_AGENT_EVAL'] = '1'
  })

  after(async () => {
    await shutdownMcpServers()
    setDefaultPluginRegistry(null)
    if (previousEvalFlag === undefined) delete process.env['COPSE_AGENT_EVAL']
    else process.env['COPSE_AGENT_EVAL'] = previousEvalFlag
  })

  beforeEach(async () => {
    await shutdownMcpServers()
    plugins = createFirstPartyPluginRegistry()
    setDefaultPluginRegistry(plugins)
    tools = new ToolRegistry()
  })

  it('drops render_html_artefact as soon as the canvas plugin is disabled', async () => {
    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    await loadMcpServers(tools)
    assert.equal(tools.has(RENDER_TOOL), true, 'precondition: the canvas tool is offered')

    plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)
    const statuses = await reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)

    assert.ok(statuses, 'the canvas toggle reloads MCP servers')
    assert.equal(tools.has(RENDER_TOOL), false)
    assert.equal(
      statuses.some((status) => status.name === CANVAS_SERVER_NAME),
      false,
    )
  })

  it('offers render_html_artefact as soon as the canvas plugin is enabled', async () => {
    plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)
    await loadMcpServers(tools)
    assert.equal(tools.has(RENDER_TOOL), false, 'precondition: no canvas tool while off')

    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    const statuses = await reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)

    assert.ok(statuses, 'the canvas toggle reloads MCP servers')
    assert.equal(tools.has(RENDER_TOOL), true)
    const canvas = statuses.find((status) => status.name === CANVAS_SERVER_NAME)
    assert.equal(canvas?.state, 'connected')
    assert.ok(canvas.tools.includes('render_html_artefact'))
  })

  it('leaves MCP servers alone for a plugin that gates no bundled server', async () => {
    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    await loadMcpServers(tools)
    // Flip the canvas capability without telling MCP: a reload would drop the tool.
    plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)

    const statuses = await reloadMcpServersForPluginToggle(tools, DARK_FACTORY_PLUGIN_ID)

    assert.equal(statuses, null)
    assert.equal(tools.has(RENDER_TOOL), true)
  })
})
