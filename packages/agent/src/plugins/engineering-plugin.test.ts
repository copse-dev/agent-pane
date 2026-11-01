import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { buildEngineeringGuidance, engineeringSteeringHook } from '../engineering-steering.ts'
import { createHookRegistry, mergeBlockingOutcomes } from '../hooks/hook-registry.ts'
import { setDefaultPluginRegistry } from './default-plugin-registry.ts'
import {
  createFirstPartyPluginRegistry,
  EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS,
} from './first-party-plugins.ts'
import { ENGINEERING_PLUGIN_ID, engineeringPlugin } from './engineering-plugin.ts'

describe('Copse engineering workflows', () => {
  afterEach(() => {
    setDefaultPluginRegistry(null)
  })

  it('ships experimental and participates in fresh-profile opt-in', () => {
    assert.equal(engineeringPlugin.manifest.stability, 'experimental')
    assert.ok(EXPERIMENTAL_FIRST_PARTY_PLUGIN_IDS.includes(ENGINEERING_PLUGIN_ID))
    assert.deepEqual(engineeringPlugin.contributions.blockingHooks, [engineeringSteeringHook])
    assert.deepEqual(engineeringPlugin.contributions.toolNames, [])
  })

  it('provides the same workflows for local and ACP without unavailable tool names', () => {
    const payload = { userText: 'Investigate the failing parser test', priorTodos: [] }
    const local = buildEngineeringGuidance({ ...payload, executor: 'local', toolNames: [] })
    const acp = buildEngineeringGuidance({ ...payload, executor: 'acp', toolNames: [] })
    assert.equal(local, acp)
    assert.ok(local)
    for (const workflow of ['Investigate:', 'Change:', 'Review:'])
      assert.ok(local.includes(workflow))
    assert.match(local, /do not turn it into an unsolicited patch/)
    assert.match(local, /Small mechanical edits do not automatically need new tests/)
    assert.match(local, /Before broad test suites, run a bounded diagnostic spike/)
    assert.match(local, /satisfy required project gates before marking the work ready/)
    assert.match(local, /may create a draft PR after focused investigation and checks/)
    assert.match(local, /on-device testing wherever CI is insufficient/)
    assert.match(local, /explicitly cite this draft\/cloud-validation route/)
    assert.match(local, /keep the PR draft until required checks and device evidence pass/)
    assert.doesNotMatch(local, /review_changes|Task|update_todos|composer-/)
    assert.match(
      buildEngineeringGuidance({ ...payload, toolNames: ['review_changes'] }) ?? '',
      /available review_changes tool/,
    )
  })

  it('yields to any explicitly invoked skill and abstains on empty messages', () => {
    for (const invokedSkills of [['poteto-mode'], ['pstack/poteto-mode'], ['team-workflow']]) {
      assert.equal(
        buildEngineeringGuidance({ userText: 'Fix this bug', priorTodos: [], invokedSkills }),
        undefined,
      )
    }
    assert.equal(buildEngineeringGuidance({ userText: '  ', priorTodos: [] }), undefined)
  })

  it('injects once per thread: fires on the first turn, abstains afterward', () => {
    const payload = { userText: 'Fix this bug', priorTodos: [] }
    assert.ok(buildEngineeringGuidance({ ...payload, firstTurn: true }))
    assert.equal(buildEngineeringGuidance({ ...payload, firstTurn: false }), undefined)
    // Absent `firstTurn` (older fire sites, pure package tests) keeps the prior
    // always-inject behavior rather than silently going quiet.
    assert.ok(buildEngineeringGuidance(payload))
  })

  it('removes new guidance when disabled and leaves other contributions intact', async () => {
    const plugins = createFirstPartyPluginRegistry()
    setDefaultPluginRegistry(plugins)
    const payload = { userText: 'Explain this parser', priorTodos: [] }
    const run = async (): Promise<string | undefined> =>
      mergeBlockingOutcomes(
        (
          await createHookRegistry().emit('turnStart', payload, {
            signal: new AbortController().signal,
          })
        ).outcomes,
      ).injectContext
    const before = await run()
    assert.match(before ?? '', /Copse engineering workflows/)
    const tools = plugins.activeToolNames()
    plugins.disable(ENGINEERING_PLUGIN_ID)
    assert.doesNotMatch((await run()) ?? '', /Copse engineering workflows/)
    assert.deepEqual(plugins.activeToolNames(), tools)
    plugins.enable(ENGINEERING_PLUGIN_ID)
    assert.equal(await run(), before)
  })
})
