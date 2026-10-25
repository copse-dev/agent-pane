import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { SITE_BUILDING_STEERING_PROMPT } from '@copse/agent/site-building-steering.ts'
import { createFirstPartyPluginRegistry } from '@copse/agent/plugins/first-party-plugins.ts'
import { setDefaultPluginRegistry } from '@copse/agent/plugins/default-plugin-registry.ts'
import { SITE_BUILDING_PLUGIN_ID } from '@copse/agent/plugins/site-building-plugin.ts'
import { ENGINEERING_PLUGIN_ID } from '@copse/agent/plugins/engineering-plugin.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { assembleAcpTurnStart } from './acp-turn-start.ts'

const cupcakeBrief =
  'Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio. Include email signup, make it feel handcrafted, and preview it when done.'

describe('ACP turnStart assembly (decision 20)', () => {
  beforeEach(() => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.disable(ENGINEERING_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)
  })
  afterEach(() => {
    setDefaultPluginRegistry(null)
  })

  it('delivers the stable site-building plugin to ACP from the natural visible brief', async () => {
    const guidance = await assembleAcpTurnStart({
      userText: cupcakeBrief,
      priorTodos: [],
      firstTurn: true,
      model: 'acp:codex',
      registry: new ToolRegistry(),
      signal: new AbortController().signal,
    })
    assert.equal(guidance, SITE_BUILDING_STEERING_PROMPT)
  })

  it('removes the guidance atomically when the plugin is disabled', async () => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.disable(SITE_BUILDING_PLUGIN_ID)
    plugins.disable(ENGINEERING_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)

    const guidance = await assembleAcpTurnStart({
      userText: cupcakeBrief,
      priorTodos: [],
      firstTurn: true,
      model: 'acp:codex',
      registry: new ToolRegistry(),
      signal: new AbortController().signal,
    })
    assert.equal(guidance, undefined)
  })

  it('shares engineering guidance and explicit-skill precedence with ACP', async () => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.enable(ENGINEERING_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)
    const options = {
      userText: 'Explain this parser',
      priorTodos: [],
      firstTurn: true,
      model: 'acp:codex',
      registry: new ToolRegistry(),
      signal: new AbortController().signal,
    }
    assert.match((await assembleAcpTurnStart(options)) ?? '', /Copse engineering workflows/)
    assert.equal(
      await assembleAcpTurnStart({ ...options, invokedSkills: ['poteto-mode'] }),
      undefined,
    )
    plugins.disable(ENGINEERING_PLUGIN_ID)
    assert.equal(await assembleAcpTurnStart(options), undefined)
  })

  it('abstains the engineering guidance on a later turn in the same thread', async () => {
    const plugins = createFirstPartyPluginRegistry()
    plugins.enable(ENGINEERING_PLUGIN_ID)
    setDefaultPluginRegistry(plugins)
    const options = {
      userText: 'Explain this parser',
      priorTodos: [],
      firstTurn: false,
      model: 'acp:codex',
      registry: new ToolRegistry(),
      signal: new AbortController().signal,
    }
    assert.equal(await assembleAcpTurnStart(options), undefined)
  })

  it('reports only live Copse bridge tools to hooks', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'read_file',
      description: 'read',
      parameters: z.object({ path: z.string() }),
      execute: () => 'ok',
    })
    registry.register({
      name: 'mcp__docs__search',
      description: 'connected MCP tool',
      parameters: z.object({ query: z.string() }),
      execute: () => 'ok',
    })
    registry.register({
      name: 'ask_user',
      description: 'not bridged',
      parameters: z.object({ question: z.string() }),
      execute: () => 'ok',
    })

    const records: { hookId: string; payload: unknown }[] = []
    await assembleAcpTurnStart({
      userText: cupcakeBrief,
      priorTodos: [],
      firstTurn: true,
      model: 'acp:codex',
      registry,
      signal: new AbortController().signal,
      recordHookRun: (record) => records.push({ hookId: record.hookId, payload: record.payload }),
    })

    const siteRecord = records.find((record) => record.hookId === 'site-building-steering')
    assert.ok(siteRecord)
    assert.deepEqual(siteRecord.payload, {
      userText: cupcakeBrief,
      priorTodos: [],
      firstTurn: true,
      executor: 'acp',
      model: 'acp:codex',
      toolNames: ['read_file', 'mcp__docs__search'],
    })
  })
})
