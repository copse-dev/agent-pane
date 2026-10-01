import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  buildExplainerSteeringPrompt,
  shouldSteerExplainer,
  explainerSteeringHook,
} from './explainer-steering.ts'
import { createFirstPartyPluginRegistry } from './plugins/first-party-plugins.ts'

it('recognises natural explanation requests while preserving explicit text-only choices', () => {
  for (const value of [
    'explain how context trimming works',
    'Can you explain x?',
    'Show me how parallel search works',
    'Make an animated explainer of this flow',
  ])
    assert.equal(shouldSteerExplainer(value), true, value)
  for (const value of [
    'Fix the explainer tool',
    'Explain x in plain text',
    'explain x without animation',
    'No video, explain x',
    'Make it simpler',
  ])
    assert.equal(shouldSteerExplainer(value), false, value)
})

it('offers executor-neutral instructions only when the exact tool is available', async () => {
  const registry = createFirstPartyPluginRegistry()
  assert.ok(registry.activeBlockingHooks().some((hook) => hook.id === explainerSteeringHook.id))
  registry.disable('copse.mcp-ui-canvas')
  assert.equal(
    registry.activeBlockingHooks().some((hook) => hook.id === explainerSteeringHook.id),
    false,
  )
  // The policy is shared; the existing canonical hook harness owns executor dispatch.
  const prompt = buildExplainerSteeringPrompt('mcp__copse-canvas__render_explainer')
  assert.match(prompt, /mcp__copse-canvas__render_explainer/)
  assert.match(prompt, /inspect relevant project evidence/)
  assert.match(prompt, /No editor/)
})

it('abstains with an unavailable tool and names the offered tool for both executors', async () => {
  for (const executor of ['local', 'acp'] as const) {
    const payload = { userText: 'explain parallel search', priorTodos: [], executor }
    assert.equal(await explainerSteeringHook.run(payload, {}), undefined)
    assert.equal(
      await explainerSteeringHook.run({ ...payload, toolNames: ['write_file'] }, {}),
      undefined,
    )
    const result = await explainerSteeringHook.run(
      { ...payload, toolNames: ['mcp__copse-canvas__render_explainer'] },
      {},
    )
    assert.match(result?.injectContext ?? '', /mcp__copse-canvas__render_explainer/)
  }
})

it('steers scene composition and actual preview only when the preview tool is offered', () => {
  const preview = 'mcp__copse-canvas__preview_explainer'
  const render = 'mcp__copse-canvas__render_explainer'
  const prompt = buildExplainerSteeringPrompt(render, preview)
  assert.match(prompt, /4–6 scenes/)
  assert.match(prompt, /actual returned scene images/)
  assert.match(prompt, /identical story/)
  assert.match(prompt, /140/)
  assert.match(prompt, /300/)
  assert.equal(buildExplainerSteeringPrompt(render).includes(preview), false)
})
