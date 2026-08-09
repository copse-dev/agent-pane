import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { SITE_BUILDING_STEERING_PROMPT } from '@copse/agent/site-building-steering.ts'
import { createFirstPartyPackRegistry } from '@copse/agent/packs/first-party-packs.ts'
import { setDefaultPackRegistry } from '@copse/agent/packs/default-pack-registry.ts'
import { SITE_BUILDING_PACK_ID } from '@copse/agent/packs/site-building-pack.ts'
import { ToolRegistry } from '../tool-registry.ts'
import { assembleAcpTurnStart } from './acp-turn-start.ts'

const cupcakeBrief =
  'Build a polished coming-soon site for Crumb & Bloom, a playful premium cupcake studio. Include email signup, make it feel handcrafted, and preview it when done.'

describe('ACP turnStart assembly (decision 20)', () => {
  afterEach(() => {
    setDefaultPackRegistry(null)
  })

  it('delivers the stable site-building pack to ACP from the natural visible brief', async () => {
    const guidance = await assembleAcpTurnStart({
      userText: cupcakeBrief,
      priorTodos: [],
      model: 'acp:codex',
      registry: new ToolRegistry(),
      signal: new AbortController().signal,
    })
    assert.equal(guidance, SITE_BUILDING_STEERING_PROMPT)
  })

  it('removes the guidance atomically when the pack is disabled', async () => {
    const packs = createFirstPartyPackRegistry()
    packs.disable(SITE_BUILDING_PACK_ID)
    setDefaultPackRegistry(packs)

    const guidance = await assembleAcpTurnStart({
      userText: cupcakeBrief,
      priorTodos: [],
      model: 'acp:codex',
      registry: new ToolRegistry(),
      signal: new AbortController().signal,
    })
    assert.equal(guidance, undefined)
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
      name: 'ask_user',
      description: 'not bridged',
      parameters: z.object({ question: z.string() }),
      execute: () => 'ok',
    })

    const records: { hookId: string; payload: unknown }[] = []
    await assembleAcpTurnStart({
      userText: cupcakeBrief,
      priorTodos: [],
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
      executor: 'acp',
      model: 'acp:codex',
      toolNames: ['read_file'],
    })
  })
})
