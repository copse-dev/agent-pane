import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { runAgentLoop } from '@copse/agent/run-agent-loop.ts'
import type { AgentStreamChunk } from '@copse/agent/wire-types.ts'
import type { LLMMessage } from '@copse/llm/wire-types.ts'
import {
  COLLECTOR_DEMO_PROMPT,
  LINT_DEMO_PROMPT,
  coordinationDemoJournal,
  registerCoordinationDemoTools,
  startCoordinationDemoRun,
} from './coordination-demo.ts'
import { ToolRegistry, setPermissionGateForTests } from './tool-registry.ts'
import { runWithAgentRunReadonly } from './agent-run-readonly.ts'

const keys = ['COPSE_COORDINATION_DEMO', 'COPSE_E2E', 'COPSE_PANEL_MOCK_LLM']
const original = keys.map((key) => process.env[key])
beforeEach(() => {
  for (const key of keys) process.env[key] = '1'
  setPermissionGateForTests(async () => true)
})
afterEach(() => {
  keys.forEach((key, i) => {
    const value = original[i]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  })
  setPermissionGateForTests(null)
})

test('two real loops exchange notes through the registry and release the shared intention', async () => {
  const registry = new ToolRegistry()
  registerCoordinationDemoTools(registry)
  const chunks: AgentStreamChunk[] = []
  const run = async (id: string, prompt: string): Promise<void> => {
    const controller = new AbortController()
    const demo = startCoordinationDemoRun(id, prompt, '/demo', '/demo', controller.signal)
    assert.ok(demo)
    const messages: LLMMessage[] = [{ role: 'user', content: prompt }]
    try {
      await runAgentLoop({
        provider: demo.provider,
        messages,
        tools: registry.toLLMTools(),
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
        executeTool: (name, args, signal) =>
          demo.execute(() => registry.execute(name, args, signal)),
        signal: controller.signal,
      })
    } finally {
      demo.stop()
    }
  }
  await Promise.all([run('collector', COLLECTOR_DEMO_PROMPT), run('lint', LINT_DEMO_PROMPT)])
  const texts = chunks.filter((chunk) => chunk.type === 'text').map((chunk) => chunk.text)
  assert.equal(texts.filter((text) => text.includes('demo — completed')).length, 2)
  assert.ok(texts.some((text) => text.includes('I released the notices file')))
  const records = coordinationDemoJournal()
  assert.equal(records.filter((entry) => entry.kind === 'sent').length, 2)
  assert.equal(records.filter((entry) => entry.kind === 'received').length, 2)
  assert.equal(records.filter((entry) => entry.kind === 'stopped').length, 2)
})

test('demo requires every host gate and an exact demo prompt', () => {
  for (const key of keys) {
    Reflect.deleteProperty(process.env, key)
    const registry = new ToolRegistry()
    registerCoordinationDemoTools(registry)
    assert.deepEqual(registry.names(), [])
    assert.equal(
      startCoordinationDemoRun(
        'off',
        COLLECTOR_DEMO_PROMPT,
        '/demo',
        '/demo',
        new AbortController().signal,
      ),
      undefined,
    )
    process.env[key] = '1'
  }
  assert.equal(
    startCoordinationDemoRun(
      'normal',
      'ordinary prompt',
      '/demo',
      '/demo',
      new AbortController().signal,
    ),
    undefined,
  )
})

test('registry permission denial and read-only mode still block coordination', async () => {
  const registry = new ToolRegistry()
  registerCoordinationDemoTools(registry)
  const controller = new AbortController()
  const demo = startCoordinationDemoRun(
    'guarded',
    COLLECTOR_DEMO_PROMPT,
    '/demo',
    '/demo',
    controller.signal,
  )
  assert.ok(demo)
  const before = coordinationDemoJournal().filter((entry) => entry.kind === 'claimed').length
  try {
    setPermissionGateForTests(async () => false)
    const rejected = await demo.execute(() =>
      registry.execute('coordination_check', { paths: ['private.ts'] }, controller.signal),
    )
    assert.ok(typeof rejected === 'string')
    assert.match(rejected, /User rejected/)
    setPermissionGateForTests(async () => true)
    const readonly = await runWithAgentRunReadonly(true, () =>
      demo.execute(() =>
        registry.execute('coordination_check', { paths: ['private.ts'] }, controller.signal),
      ),
    )
    assert.ok(typeof readonly === 'string')
    assert.match(readonly, /read.only/i)
    assert.equal(
      coordinationDemoJournal().filter((entry) => entry.kind === 'claimed').length,
      before,
    )
  } finally {
    demo.stop()
  }
})

test('Stop aborts an in-flight wait immediately and revokes the session', async () => {
  const registry = new ToolRegistry()
  registerCoordinationDemoTools(registry)
  const controller = new AbortController()
  const demo = startCoordinationDemoRun(
    'stopped-waiter',
    COLLECTOR_DEMO_PROMPT,
    '/separate',
    '/separate',
    controller.signal,
  )
  assert.ok(demo)
  const wait = demo.execute(() =>
    registry.execute(
      'coordination_check',
      { paths: ['wait.ts'], wait_for_peer: true },
      controller.signal,
    ),
  )
  controller.abort()
  await assert.rejects(wait, /abort/i)
  await assert.rejects(
    demo.execute(() =>
      registry.execute('coordination_check', { paths: ['wait.ts'] }, new AbortController().signal),
    ),
    /revoked/,
  )
  demo.stop()
})
