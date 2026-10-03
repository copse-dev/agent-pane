import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { MCP_UI_CANVAS_PLUGIN_ID } from '@copse/agent/plugins/mcp-ui-canvas-plugin.ts'
import { DARK_FACTORY_PLUGIN_ID } from '@copse/agent/plugins/dark-factory-plugin.ts'
import type { PluginRegistry } from '@copse/agent/plugins/plugin-registry.ts'
import { storageDelete, storageSet } from '../storage/storage.ts'
import { pluginSettingsKey } from '../plugins/plugin-settings-read.ts'
import { ANIMATED_EXPLAINERS_SETTING_ID } from '@copse/agent/canvas-settings.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { CANVAS_SERVER_NAME } from './bundled-mcp-server.ts'
import { mcpToolName } from './mcp-config.ts'
import {
  loadMcpServers,
  reloadMcpServers,
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
    storageDelete(pluginSettingsKey(MCP_UI_CANVAS_PLUGIN_ID))
    if (previousEvalFlag === undefined) delete process.env['COPSE_AGENT_EVAL']
    else process.env['COPSE_AGENT_EVAL'] = previousEvalFlag
  })

  beforeEach(async () => {
    await shutdownMcpServers()
    storageDelete(pluginSettingsKey(MCP_UI_CANVAS_PLUGIN_ID))
    plugins = createFirstPartyPluginRegistry()
    setDefaultPluginRegistry(plugins)
    tools = new ToolRegistry()
  })

  it('opts existing Canvas users into explainers and revokes them live without removing HTML Canvas', async () => {
    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    await loadMcpServers(tools)
    const preview = mcpToolName(CANVAS_SERVER_NAME, 'preview_explainer')
    const render = mcpToolName(CANVAS_SERVER_NAME, 'render_explainer')
    assert.equal(tools.has(RENDER_TOOL), true)
    assert.equal(tools.has(preview), false)
    assert.equal(tools.has(render), false)
    for (const enabled of [true, false]) {
      storageSet(pluginSettingsKey(MCP_UI_CANVAS_PLUGIN_ID), {
        [ANIMATED_EXPLAINERS_SETTING_ID]: enabled,
      })
      await reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
      assert.equal(tools.has(preview), enabled)
      assert.equal(tools.has(render), enabled)
      assert.equal(tools.has(RENDER_TOOL), true)
    }
  })

  it('drops render_html_artefact as soon as the canvas plugin is disabled', async () => {
    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    await loadMcpServers(tools)
    assert.equal(tools.has(RENDER_TOOL), true, 'precondition: the canvas tool is offered')

    plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)
    const statuses = await reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)

    assert.ok(statuses, 'the canvas toggle resyncs the bundled server')
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

    assert.ok(statuses, 'the canvas toggle resyncs the bundled server')
    assert.equal(tools.has(RENDER_TOOL), true)
    const canvas = statuses.find((status) => status.name === CANVAS_SERVER_NAME)
    assert.equal(canvas?.state, 'connected')
    assert.ok(canvas.tools.includes('render_html_artefact'))
  })

  it("keeps other MCP servers' tools registered across a canvas toggle", async () => {
    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    await loadMcpServers(tools)
    // Stands in for a configured server's tool: a full teardown unregisters
    // every MCP-prefixed tool, so this only survives a bundled-only resync.
    const otherTool = mcpToolName('configured-server', 'ping')
    tools.register({
      name: otherTool,
      description: 'configured server tool',
      parameters: z.object({}),
      execute: async () => 'pong',
    })

    plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)
    await reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(tools.has(RENDER_TOOL), false)
    assert.equal(tools.has(otherTool), true)

    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    await reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
    assert.equal(tools.has(RENDER_TOOL), true)
    assert.equal(tools.has(otherTool), true)
  })

  it('does not let a superseded enable register the canvas tool after a disable', async () => {
    // Toggle on, then back off while the enable's bundled-server start is still
    // in flight. The in-process start settles within microtasks, so the disable
    // is placed after 0, 1, 2 … microtask hops; every placement must leave the
    // tool unregistered.
    const hop = (): Promise<void> => Promise.resolve()
    for (let turns = 0; turns <= 200; turns++) {
      await shutdownMcpServers()
      tools = new ToolRegistry()
      plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)
      await loadMcpServers(tools)

      plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
      const enabling = reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
      for (let i = 0; i < turns; i++) await hop()
      plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)
      const disabling = reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
      const [, statuses] = await Promise.all([enabling, disabling])

      assert.equal(tools.has(RENDER_TOOL), false, `tool registered after ${String(turns)} hops`)
      assert.equal(
        statuses?.some((status) => status.name === CANVAS_SERVER_NAME),
        false,
        `status reported after ${String(turns)} hops`,
      )
    }
  })

  it('keeps tracking a bundled client a concurrent full reload connected', async () => {
    // A toggle's resync awaits the old bundled clients closing. A full reload that
    // reconnects the canvas meanwhile must not have its fresh client dropped from
    // tracking, or a later disable could no longer find and remove its tool.
    const hop = (): Promise<void> => Promise.resolve()
    for (const reloadFirst of [false, true]) {
      for (let hops = 0; hops <= 200; hops++) {
        await shutdownMcpServers()
        tools = new ToolRegistry()
        plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
        await loadMcpServers(tools)

        const first = reloadFirst
          ? reloadMcpServers(tools)
          : reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
        for (let i = 0; i < hops; i++) await hop()
        const second = reloadFirst
          ? reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
          : reloadMcpServers(tools)
        await Promise.all([first, second])

        plugins.disable(MCP_UI_CANVAS_PLUGIN_ID)
        await reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
        const order = reloadFirst ? 'reload first' : 'toggle first'
        assert.equal(
          tools.has(RENDER_TOOL),
          false,
          `${order}, ${String(hops)} hops: tool left registered`,
        )
      }
    }
  })

  it('does not orphan a client when a full reload overlaps a bundled resync', async () => {
    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    const listTools = mock.method(Client.prototype, 'listTools')
    let releaseFirstClose: (() => void) | undefined
    const firstClose = new Promise<void>((resolve) => {
      releaseFirstClose = resolve
    })
    const closedClients = new Set<unknown>()
    let closeCalls = 0
    const close = mock.method(Client.prototype, 'close', function (this: Client) {
      closedClients.add(this)
      closeCalls++
      return closeCalls === 1 ? firstClose : Promise.resolve()
    })
    try {
      await loadMcpServers(tools)

      // Hold the reload inside teardown. Before lifecycle operations were
      // serialized, the resync could connect a fresh client during this wait;
      // teardown then cleared it from activeServers without closing it.
      const reloading = reloadMcpServers(tools)
      for (let hops = 0; hops < 200 && closeCalls === 0; hops++) await Promise.resolve()
      assert.equal(closeCalls, 1, 'the reload reached its awaited client close')
      const resyncing = reloadMcpServersForPluginToggle(tools, MCP_UI_CANVAS_PLUGIN_ID)
      for (let hops = 0; hops < 200; hops++) await Promise.resolve()

      releaseFirstClose?.()
      await Promise.all([reloading, resyncing])
      await shutdownMcpServers()

      for (const call of listTools.mock.calls) {
        assert.ok(closedClients.has(call.this), 'every connected bundled client was closed')
      }
    } finally {
      releaseFirstClose?.()
      listTools.mock.restore()
      close.mock.restore()
    }
  })

  it('closes a bundled client whose tool listing fails', async () => {
    plugins.enable(MCP_UI_CANVAS_PLUGIN_ID)
    const listTools = mock.method(Client.prototype, 'listTools', () =>
      Promise.reject(new Error('listing failed')),
    )
    const close = mock.method(Client.prototype, 'close')
    try {
      await loadMcpServers(tools)
      assert.equal(tools.has(RENDER_TOOL), false)
      assert.ok(close.mock.callCount() >= 1, 'the untracked client is closed, not leaked')
    } finally {
      listTools.mock.restore()
      close.mock.restore()
    }
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
