import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chatGptPlanModelValue, parseChatGptPlanModel } from './chatgpt-plan.ts'
import { parseModelSelection } from './model-selection.ts'
import { isExtraProviderModel } from './extra-providers.ts'
import { modelParameterSupport } from './model-parameters.ts'
import { modelCapabilities } from './model-capabilities.ts'

describe('ChatGPT plan selections', () => {
  it('preserves the billing registration independently of the upstream model', () => {
    const value = chatGptPlanModelValue('oaiapp_account', 'gpt-6.1-sol')
    assert.deepEqual(parseChatGptPlanModel(value), {
      clientId: 'oaiapp_account',
      model: 'gpt-6.1-sol',
    })
    assert.equal(parseModelSelection(value).namespace, 'chatgpt-plan')
    assert.equal(isExtraProviderModel(value), false)
    assert.equal(parseChatGptPlanModel('gpt-6.1-sol'), null)
    assert.throws(() => parseChatGptPlanModel('chatgpt-plan:account'), /Choose/)
  })
  it('offers reasoning but never sampling or an unsupported output ceiling', () => {
    const value = chatGptPlanModelValue('oaiapp_account', 'gpt-6.1-sol')
    const support = modelParameterSupport(value)
    assert.deepEqual(support.sampling, [])
    assert.equal(support.outputCap, false)
    assert.equal(modelCapabilities(value).transport, 'openai-responses')
  })
})
