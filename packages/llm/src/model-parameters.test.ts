import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicParameterFields,
  anthropicThinkingBudget,
  decodeModelParametersMap,
  isEmptyModelParameters,
  clampReasoning,
  isReasoningLevel,
  modelParameterSupport,
  recommendedModelParameters,
  recommendedOutputCeiling,
  openAiParameterFields,
  openRouterReasoningBody,
  resolveModelParameters,
  sanitizeModelParameters,
} from './model-parameters.ts'

describe('isReasoningLevel', () => {
  it('accepts every level in the vocabulary', () => {
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(isReasoningLevel(level), true, level)
    }
  })

  it('rejects near-misses and non-strings', () => {
    assert.equal(isReasoningLevel('HIGH'), false)
    assert.equal(isReasoningLevel('extreme'), false)
    assert.equal(isReasoningLevel(''), false)
    assert.equal(isReasoningLevel(3), false)
    assert.equal(isReasoningLevel(null), false)
    assert.equal(isReasoningLevel(undefined), false)
  })
})

describe('modelParameterSupport', () => {
  it('offers the full effort ladder and no sampling on the models that removed it', () => {
    for (const model of ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
      const support = modelParameterSupport(model)
      assert.equal(support.sampling, false, model)
      assert.equal(support.reasoningWire, 'anthropic-effort', model)
      assert.ok(support.reasoning.includes('xhigh'), model)
      assert.ok(support.reasoning.includes('max'), model)
    }
  })

  it('keeps sampling and drops xhigh on the 4.6 generation', () => {
    const support = modelParameterSupport('claude-sonnet-4-6')
    assert.equal(support.sampling, true)
    assert.equal(support.temperatureMax, 1)
    assert.equal(support.reasoningWire, 'anthropic-effort')
    assert.equal(support.reasoning.includes('xhigh'), false)
    assert.ok(support.reasoning.includes('max'))
  })

  it('omits "off" for models whose thinking cannot be disabled', () => {
    assert.equal(modelParameterSupport('claude-fable-5').reasoning.includes('off'), false)
    assert.equal(modelParameterSupport('claude-opus-5').reasoning.includes('off'), true)
  })

  it('falls back to a thinking budget on pre-effort Claude models', () => {
    const support = modelParameterSupport('claude-haiku-4-5')
    assert.equal(support.reasoningWire, 'anthropic-budget')
    assert.equal(support.sampling, true)
    assert.deepEqual([...support.reasoning], ['off', 'low', 'medium', 'high'])
  })

  it('resolves a dated snapshot to its family', () => {
    assert.equal(modelParameterSupport('claude-opus-4-8-20260101').sampling, false)
  })

  it('gives OpenAI reasoning models effort without sampling, and gpt-4o the reverse', () => {
    const gpt5 = modelParameterSupport('gpt-5.6-sol')
    assert.equal(gpt5.reasoningWire, 'openai-effort')
    assert.equal(gpt5.sampling, false)
    assert.ok(gpt5.reasoning.includes('minimal'))

    const gpt4o = modelParameterSupport('gpt-4o')
    assert.deepEqual([...gpt4o.reasoning], [])
    assert.equal(gpt4o.sampling, true)
    assert.equal(gpt4o.temperatureMax, 2)
  })

  it('routes OpenRouter through its unified reasoning field', () => {
    const support = modelParameterSupport('openrouter:deepseek/deepseek-v4-flash')
    assert.equal(support.reasoningWire, 'openrouter')
    assert.equal(support.sampling, true)
    assert.equal(support.upstreamDecides, true)
    assert.ok(support.reasoning.includes('max'))
  })

  it('gives local and extra-provider models the OpenAI-compatible ladder', () => {
    for (const model of ['lmstudio:qwen3-coder', 'deepseek:deepseek-chat']) {
      const support = modelParameterSupport(model)
      assert.equal(support.reasoningWire, 'openai-effort', model)
      assert.equal(support.sampling, true, model)
      assert.equal(support.upstreamDecides, true, model)
    }
  })

  it('offers nothing for selections that own their own settings', () => {
    for (const model of [
      'acp:claude-code#opus',
      'remote-agent:cursor#composer',
      'auto:best-value',
    ]) {
      const support = modelParameterSupport(model)
      assert.deepEqual([...support.reasoning], [], model)
      assert.equal(support.sampling, false, model)
      assert.ok(support.unavailableReason, model)
    }
  })
})

describe('sanitizeModelParameters', () => {
  it('drops sampling for a model that rejects it', () => {
    const sanitized = sanitizeModelParameters(
      { reasoning: 'high', temperature: 0.7, topP: 0.95 },
      'claude-opus-5',
    )
    assert.deepEqual(sanitized, { reasoning: 'high' })
  })

  it('drops a level the model does not offer', () => {
    assert.deepEqual(sanitizeModelParameters({ reasoning: 'xhigh' }, 'claude-sonnet-4-6'), {})
    assert.deepEqual(sanitizeModelParameters({ reasoning: 'off' }, 'claude-fable-5'), {})
  })

  it('keeps the vendor-recommended agentic sampling for an OpenAI-compatible model', () => {
    const sanitized = sanitizeModelParameters(
      { reasoning: 'max', temperature: 1, topP: 0.95 },
      'openrouter:deepseek/deepseek-v4-flash',
    )
    assert.deepEqual(sanitized, { reasoning: 'max', temperature: 1, topP: 0.95 })
  })

  it('clamps out-of-range values to the family bounds', () => {
    assert.deepEqual(sanitizeModelParameters({ temperature: 5, topP: 4 }, 'gpt-4o'), {
      temperature: 2,
      topP: 1,
    })
    assert.deepEqual(sanitizeModelParameters({ temperature: 1.8 }, 'claude-sonnet-4-6'), {
      temperature: 1,
    })
    assert.deepEqual(sanitizeModelParameters({ temperature: -1 }, 'gpt-4o'), { temperature: 0 })
  })

  it('ignores non-finite numbers rather than sending NaN', () => {
    assert.deepEqual(sanitizeModelParameters({ temperature: Number.NaN }, 'gpt-4o'), {})
  })

  it('strips everything for an agent selection', () => {
    assert.deepEqual(
      sanitizeModelParameters({ reasoning: 'high', temperature: 0.5 }, 'acp:claude-code'),
      {},
    )
  })
})

describe('anthropicThinkingBudget', () => {
  it('scales with the level', () => {
    assert.equal(anthropicThinkingBudget('low', 64_000), 4_096)
    assert.equal(anthropicThinkingBudget('medium', 64_000), 16_384)
    assert.equal(anthropicThinkingBudget('high', 64_000), 32_768)
  })

  it('leaves room for the answer when the output cap is small', () => {
    assert.equal(anthropicThinkingBudget('high', 8_192), 7_168)
  })

  it('returns null when the cap leaves no room to think', () => {
    assert.equal(anthropicThinkingBudget('high', 2_000), null)
    assert.equal(anthropicThinkingBudget('off', 64_000), null)
  })
})

describe('anthropicParameterFields', () => {
  it('pairs an effort with adaptive thinking', () => {
    assert.deepEqual(anthropicParameterFields({ reasoning: 'xhigh' }, 'claude-opus-5'), {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    })
  })

  it('disables thinking for "off" instead of naming an effort', () => {
    assert.deepEqual(anthropicParameterFields({ reasoning: 'off' }, 'claude-opus-5'), {
      thinking: { type: 'disabled' },
    })
  })

  it('sends a token budget on a pre-effort model', () => {
    assert.deepEqual(
      anthropicParameterFields({ reasoning: 'medium' }, 'claude-haiku-4-5', 64_000),
      {
        thinking: { type: 'enabled', budget_tokens: 16_384 },
      },
    )
  })

  it('omits thinking when the budget would not fit', () => {
    assert.deepEqual(anthropicParameterFields({ reasoning: 'high' }, 'claude-haiku-4-5', 1_500), {})
  })

  it('passes sampling through unchanged', () => {
    assert.deepEqual(
      anthropicParameterFields({ temperature: 0.3, topP: 0.9 }, 'claude-sonnet-4-6'),
      {
        temperature: 0.3,
        top_p: 0.9,
      },
    )
  })

  it('sends nothing when nothing is set', () => {
    assert.deepEqual(anthropicParameterFields({}, 'claude-opus-5'), {})
  })
})

describe('openAiParameterFields', () => {
  it('maps a level onto reasoning_effort', () => {
    assert.deepEqual(openAiParameterFields({ reasoning: 'minimal' }), {
      reasoning_effort: 'minimal',
    })
    assert.deepEqual(openAiParameterFields({ reasoning: 'max', temperature: 1, topP: 0.95 }), {
      reasoning_effort: 'max',
      temperature: 1,
      top_p: 0.95,
    })
  })

  it('maps "off" onto the none effort', () => {
    assert.deepEqual(openAiParameterFields({ reasoning: 'off' }), { reasoning_effort: 'none' })
  })

  it('sends nothing when nothing is set', () => {
    assert.deepEqual(openAiParameterFields({}), {})
  })
})

describe('openRouterReasoningBody', () => {
  it('uses the unified effort field', () => {
    assert.deepEqual(openRouterReasoningBody({ reasoning: 'max' }), {
      reasoning: { effort: 'max' },
    })
  })

  it('expresses "off" as disabled reasoning', () => {
    assert.deepEqual(openRouterReasoningBody({ reasoning: 'off' }), {
      reasoning: { enabled: false },
    })
  })

  it('contributes nothing when reasoning is unset', () => {
    assert.deepEqual(openRouterReasoningBody({ temperature: 0.5 }), {})
  })
})

describe('decodeModelParametersMap', () => {
  it('keeps recognised fields and drops the rest', () => {
    const decoded = decodeModelParametersMap({
      'claude-opus-5': { reasoning: 'high', temperature: 0.4, topP: 0.9, nonsense: true },
      'gpt-4o': { reasoning: 'ludicrous', temperature: 'hot' },
      'lmstudio:qwen': {},
    })
    assert.deepEqual(decoded, {
      'claude-opus-5': { reasoning: 'high', temperature: 0.4, topP: 0.9 },
    })
  })

  it('returns an empty map for non-object input', () => {
    assert.deepEqual(decodeModelParametersMap(null), {})
    assert.deepEqual(decodeModelParametersMap(['a']), {})
    assert.deepEqual(decodeModelParametersMap('nope'), {})
  })
})

describe('resolveModelParameters', () => {
  it('sanitizes a stale entry against the model it is read for', () => {
    const stored = { 'claude-opus-5': { reasoning: 'high', temperature: 0.7 } }
    assert.deepEqual(resolveModelParameters(stored, 'claude-opus-5'), { reasoning: 'high' })
  })

  it('returns nothing for a model with no entry', () => {
    assert.deepEqual(resolveModelParameters({ 'gpt-4o': { temperature: 1 } }, 'claude-opus-5'), {})
  })
})

describe('isEmptyModelParameters', () => {
  it('distinguishes an unset entry from a zero value', () => {
    assert.equal(isEmptyModelParameters({}), true)
    assert.equal(isEmptyModelParameters({ temperature: 0 }), false)
  })
})

describe('clampReasoning', () => {
  it('leaves a level at or below the ceiling alone', () => {
    assert.equal(clampReasoning('low', 'low'), 'low')
    assert.equal(clampReasoning('off', 'low'), 'off')
    assert.equal(clampReasoning('minimal', 'low'), 'minimal')
  })

  it('lowers a deeper level to the ceiling', () => {
    assert.equal(clampReasoning('max', 'low'), 'low')
    assert.equal(clampReasoning('xhigh', 'medium'), 'medium')
  })

  it('passes an unset level through untouched', () => {
    assert.equal(clampReasoning(undefined, 'low'), undefined)
  })
})

describe('recommendedModelParameters', () => {
  it('returns the published recipe for a model we hold one for', () => {
    const recommendation = recommendedModelParameters('openrouter:deepseek/deepseek-v4-flash-0731')
    assert.ok(recommendation)
    assert.deepEqual(recommendation.params, { reasoning: 'max', temperature: 1, topP: 0.95 })
    assert.match(recommendation.source, /^https:\/\//)
    assert.ok(recommendation.label)
  })

  it('matches the same model through a different route', () => {
    assert.ok(recommendedModelParameters('lmstudio:deepseek-v4-flash-0731'))
    assert.ok(recommendedModelParameters('deepseek:deepseek-v4-flash'))
  })

  it('returns nothing for a model with no published recipe', () => {
    assert.equal(recommendedModelParameters('claude-opus-5'), null)
    assert.equal(recommendedModelParameters('gpt-4o'), null)
  })

  it('never offers a recipe for a selection that takes no parameters', () => {
    assert.equal(recommendedModelParameters('acp:deepseek-v4-flash'), null)
    assert.equal(recommendedModelParameters('auto:best-value'), null)
  })

  it('carries the published output ceiling alongside the tunable values', () => {
    const recommendation = recommendedModelParameters('openrouter:deepseek/deepseek-v4-flash-0731')
    assert.ok(recommendation)
    assert.deepEqual(recommendation.outputCeiling, { tokens: 384_000, fromReasoning: 'high' })
  })
})

describe('recommendedOutputCeiling', () => {
  const MODEL = 'openrouter:deepseek/deepseek-v4-flash-0731'

  it('applies at the level the card names, and deeper', () => {
    assert.equal(recommendedOutputCeiling(MODEL, { reasoning: 'high' }), 384_000)
    assert.equal(recommendedOutputCeiling(MODEL, { reasoning: 'xhigh' }), 384_000)
    assert.equal(recommendedOutputCeiling(MODEL, { reasoning: 'max' }), 384_000)
  })

  it('does not apply below it', () => {
    for (const reasoning of ['off', 'minimal', 'low', 'medium'] as const) {
      assert.equal(recommendedOutputCeiling(MODEL, { reasoning }), undefined)
    }
  })

  it('does not apply when the user chose no level at all', () => {
    // A ceiling is published *for* the deep levels; without one the model runs
    // at its own default effort, so its own default output cap belongs with it.
    assert.equal(recommendedOutputCeiling(MODEL, {}), undefined)
    assert.equal(recommendedOutputCeiling(MODEL, { temperature: 1, topP: 0.95 }), undefined)
  })

  it('holds none for a model with no published card', () => {
    assert.equal(recommendedOutputCeiling('claude-opus-5', { reasoning: 'max' }), undefined)
    assert.equal(recommendedOutputCeiling('lmstudio:qwen3-coder', { reasoning: 'max' }), undefined)
  })

  it('holds none for a selection that owns its own settings', () => {
    assert.equal(recommendedOutputCeiling('acp:deepseek-v4-flash', { reasoning: 'max' }), undefined)
  })
})
