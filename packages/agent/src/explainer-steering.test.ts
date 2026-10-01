import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  buildExplainerSteeringPrompt,
  shouldSteerExplainer,
  explainerSteeringHook,
} from './explainer-steering.ts'
import { MCP_UI_CANVAS_PLUGIN_ID, ANIMATED_EXPLAINERS_SETTING_ID } from './canvas-settings.ts'
import { createFirstPartyPluginRegistry } from './plugins/first-party-plugins.ts'

const enabledContext = {
  resolvePluginSetting: (id: string, key: string): boolean =>
    id === MCP_UI_CANVAS_PLUGIN_ID && key === ANIMATED_EXPLAINERS_SETTING_ID,
}

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
    assert.equal(await explainerSteeringHook.run(payload, enabledContext), undefined)
    assert.equal(
      await explainerSteeringHook.run({ ...payload, toolNames: ['write_file'] }, enabledContext),
      undefined,
    )
    const result = await explainerSteeringHook.run(
      { ...payload, toolNames: ['mcp__copse-canvas__render_explainer'] },
      enabledContext,
    )
    assert.match(result?.injectContext ?? '', /mcp__copse-canvas__render_explainer/)
  }
})

it('steers original drawings through transition review and token-only publication', () => {
  const preview = 'mcp__copse-canvas__preview_explainer'
  const render = 'mcp__copse-canvas__render_explainer'
  const prompt = buildExplainerSteeringPrompt(render, preview)
  assert.match(prompt, /3–6 beats/)
  assert.match(prompt, /drawing.code/)
  assert.match(prompt, /grounding only/)
  assert.match(prompt, /helpers.textBox/)
  assert.match(prompt, /enlarge the box or shorten the label/)
  assert.match(prompt, /mid-transition and outcome/)
  assert.match(prompt, /only previewId/)
  assert.match(prompt, /Publish the finished explainer automatically/)
  assert.match(prompt, /unless they explicitly requested a review step/)
  assert.match(prompt, /do not rebuild/)
  assert.match(prompt, /140/)
  assert.match(prompt, /300/)
  assert.equal(buildExplainerSteeringPrompt(render).includes(preview), false)
})

it('requires explicit opt-in even when an executor offers explainer tools', async () => {
  const payload = {
    userText: 'explain caching',
    priorTodos: [],
    executor: 'acp' as const,
    toolNames: ['mcp__copse-canvas__render_explainer'],
  }
  assert.equal(await explainerSteeringHook.run(payload, {}), undefined)
  for (const value of [undefined, null, false, 'true', 1]) {
    assert.equal(
      await explainerSteeringHook.run(payload, { resolvePluginSetting: () => value }),
      undefined,
    )
  }
  assert.ok((await explainerSteeringHook.run(payload, enabledContext))?.injectContext)
  assert.equal(
    await explainerSteeringHook.run(
      { ...payload, userText: 'explain caching in plain text' },
      enabledContext,
    ),
    undefined,
  )
})
