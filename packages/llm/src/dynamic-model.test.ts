import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BEST_INTELLECT_MODEL_SELECTOR,
  BEST_LOCAL_MODEL_SELECTOR,
  BEST_VALUE_MODEL_SELECTOR,
  CHEAPEST_MODEL_SELECTOR,
  dynamicModelChoices,
  dynamicModelLabel,
  isDynamicModel,
  minIntellectSelector,
  parseDynamicModel,
  roleModelSelector,
} from './dynamic-model.ts'
import { AGENT_ROLES } from './agent-roles.ts'
import { isExtraProviderModel } from './extra-providers.ts'

describe('parseDynamicModel', () => {
  it('parses each named selector', () => {
    assert.deepEqual(parseDynamicModel(BEST_VALUE_MODEL_SELECTOR), { kind: 'best-value' })
    assert.deepEqual(parseDynamicModel(BEST_INTELLECT_MODEL_SELECTOR), { kind: 'best-intellect' })
    assert.deepEqual(parseDynamicModel(BEST_LOCAL_MODEL_SELECTOR), { kind: 'best-local' })
    assert.deepEqual(parseDynamicModel(CHEAPEST_MODEL_SELECTOR), { kind: 'cheapest' })
    assert.deepEqual(parseDynamicModel(minIntellectSelector(45)), {
      kind: 'min-intellect',
      threshold: 45,
    })
    assert.deepEqual(parseDynamicModel(roleModelSelector('reviewer')), {
      kind: 'role',
      role: 'reviewer',
    })
  })

  it('treats a pinned model id as not dynamic', () => {
    for (const id of ['claude-opus-4-8', 'lmstudio:qwen/qwen3.6-35b-a3b', 'openrouter:x/y', '']) {
      assert.equal(parseDynamicModel(id), null)
      assert.equal(isDynamicModel(id), false)
    }
  })

  it('rejects an auto: value this build does not understand rather than guessing', () => {
    // A selector written by a newer build must fall through to the pinned-id
    // path, not silently resolve as something the user never chose.
    assert.equal(parseDynamicModel('auto:whatever-ships-next'), null)
    assert.equal(parseDynamicModel('auto:role:not-a-role'), null)
    assert.equal(parseDynamicModel('auto:min-intellect:abc'), null)
    assert.equal(parseDynamicModel('auto:min-intellect:-5'), null)
    // …but it is still recognisably an `auto:` value.
    assert.equal(isDynamicModel('auto:whatever-ships-next'), true)
  })
})

describe('best-value sentinel', () => {
  it('keeps the value the chat default has always persisted', () => {
    // Changing this string would orphan every stored chat-model setting —
    // `BEST_VALUE_CHAT_MODEL` in the app is this constant.
    assert.equal(BEST_VALUE_MODEL_SELECTOR, 'auto:best-value')
  })
})

describe('selector namespace', () => {
  it('is not mistaken for an extra provider slug', () => {
    // `auto:` looks exactly like `<slug>:<modelId>`; without the reserved-prefix
    // registration a selector would be routed to a provider called "auto".
    assert.equal(isExtraProviderModel(BEST_VALUE_MODEL_SELECTOR), false)
    assert.equal(isExtraProviderModel(roleModelSelector('advisor')), false)
  })
})

describe('dynamicModelLabel', () => {
  it('names each selector and declines to label a pinned id', () => {
    assert.equal(dynamicModelLabel(BEST_VALUE_MODEL_SELECTOR), 'Best value')
    assert.equal(dynamicModelLabel(BEST_LOCAL_MODEL_SELECTOR), 'Best on-device')
    assert.equal(dynamicModelLabel(minIntellectSelector(50)), 'At least 50 intelligence')
    assert.equal(dynamicModelLabel(roleModelSelector('advisor')), 'Role: Advisor')
    assert.equal(dynamicModelLabel('claude-opus-4-8'), null)
  })
})

describe('dynamicModelChoices', () => {
  it('offers every role and every intelligence bar, with unique parseable values', () => {
    const choices = dynamicModelChoices()
    const values = choices.map((choice) => choice.value)
    assert.equal(new Set(values).size, values.length)
    for (const value of values) assert.notEqual(parseDynamicModel(value), null)
    for (const role of AGENT_ROLES) {
      assert.ok(values.includes(roleModelSelector(role.id)), `missing role ${role.id}`)
    }
  })

  it('leads with the automatic rules so the common choice is the first one', () => {
    const [first] = dynamicModelChoices()
    assert.equal(first?.value, BEST_VALUE_MODEL_SELECTOR)
  })

  it('gives every choice a description — the picker has no model ids to fall back on', () => {
    for (const choice of dynamicModelChoices()) {
      assert.ok(choice.description.trim().length > 0, `${choice.value} has no description`)
      assert.ok(choice.group.trim().length > 0, `${choice.value} has no group`)
    }
  })
})
