import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  dataPolicyForProvider,
  openRouterDataPolicy,
  pickerPrivacyNote,
  privacyBadge,
} from './data-policies.ts'
import { BUILTIN_EXTRA_PROVIDERS } from './extra-providers.ts'

describe('dataPolicyForProvider coverage', () => {
  it('has a policy for every non-local built-in extra provider', () => {
    for (const provider of BUILTIN_EXTRA_PROVIDERS) {
      if (provider.local) continue
      const policy = dataPolicyForProvider(provider)
      assert.ok(policy, `missing data policy for built-in provider '${provider.id}'`)
      assert.ok(policy.note.length > 0)
      assert.match(policy.policyUrl, /^https:\/\//)
    }
  })

  it('has a policy for every fixed cloud provider', () => {
    for (const id of ['anthropic', 'openai', 'openrouter']) {
      assert.ok(dataPolicyForProvider({ id }), `missing data policy for fixed provider '${id}'`)
    }
  })

  it('resolves known-endpoint customs by hostname', () => {
    for (const baseUrl of [
      'https://api.together.xyz/v1',
      'https://api.groq.com/openai/v1',
      'https://api.fireworks.ai/inference/v1',
      'https://api.x.ai/v1',
    ]) {
      assert.ok(
        dataPolicyForProvider({ id: 'some-custom', baseUrl }),
        `missing data policy for known endpoint '${baseUrl}'`,
      )
    }
  })

  it('returns null (unknown, not safe) for unrecognized providers', () => {
    assert.equal(dataPolicyForProvider({ id: 'mystery' }), null)
    assert.equal(
      dataPolicyForProvider({ id: 'mystery', baseUrl: 'https://api.example.com/v1' }),
      null,
    )
    assert.equal(dataPolicyForProvider({ id: 'mystery', baseUrl: 'not a url' }), null)
  })
})

describe('policy defaults match the researched provider behavior', () => {
  it('flags default-training providers', () => {
    for (const id of ['gemini', 'mistral', 'deepseek']) {
      assert.equal(
        dataPolicyForProvider({ id })?.trainsOnData,
        true,
        `'${id}' should be marked as training on data by default`,
      )
    }
  })

  it('marks no-training-but-retained providers', () => {
    for (const id of ['anthropic', 'openai']) {
      const policy = dataPolicyForProvider({ id })
      assert.ok(policy)
      assert.equal(policy.trainsOnData, false)
      assert.equal(policy.retainsPrompts, true)
      assert.equal(policy.retentionDays, 30)
    }
  })

  it('marks Hugging Face as partner-dependent (unknown), not safe or unsafe', () => {
    const policy = dataPolicyForProvider({ id: 'huggingface' })
    assert.ok(policy)
    assert.equal(policy.retainsPrompts, null)
    assert.equal(policy.trainsOnData, null)
    assert.equal(policy.zdr, 'unknown')
  })

  it('marks Perplexity API requests as zero-retention and no-training', () => {
    const policy = dataPolicyForProvider({ id: 'perplexity' })
    assert.ok(policy)
    assert.equal(policy.retainsPrompts, false)
    assert.equal(policy.trainsOnData, false)
    assert.equal(policy.zdr, 'default')
  })
})

describe('openRouterDataPolicy', () => {
  it('is zero-retention with ZDR-only routing on', () => {
    const policy = openRouterDataPolicy(true)
    assert.equal(policy.retainsPrompts, false)
    assert.equal(policy.trainsOnData, false)
  })

  it('still excludes trainers with ZDR-only off (retention unknown, training denied)', () => {
    const policy = openRouterDataPolicy(false)
    assert.equal(policy.retainsPrompts, null)
    assert.equal(policy.trainsOnData, false)
  })

  it('marks may-train routing only with the explicit allow-training opt-in', () => {
    const policy = openRouterDataPolicy(false, true)
    assert.equal(policy.retainsPrompts, null)
    assert.equal(policy.trainsOnData, true)
    assert.equal(pickerPrivacyNote(policy), 'may train on your data')
  })
})

describe('privacyBadge', () => {
  it('local providers short-circuit regardless of policy', () => {
    assert.equal(privacyBadge(null, { local: true }).kind, 'local')
  })

  it('training providers get the warning badge', () => {
    assert.equal(privacyBadge(dataPolicyForProvider({ id: 'deepseek' })).kind, 'trains')
  })

  it('unknown policies surface as unknown rather than hidden', () => {
    assert.equal(privacyBadge(null).kind, 'unknown')
    assert.equal(privacyBadge(dataPolicyForProvider({ id: 'huggingface' })).kind, 'unknown')
  })

  it('zero-retention and retained-no-training are distinguished', () => {
    assert.equal(privacyBadge(openRouterDataPolicy(true)).kind, 'zdr')
    const anthropic = privacyBadge(dataPolicyForProvider({ id: 'anthropic' }))
    assert.equal(anthropic.kind, 'no-training')
    assert.match(anthropic.label, /30 days/)
  })
})

describe('pickerPrivacyNote', () => {
  it('annotates only the caution cases', () => {
    assert.equal(
      pickerPrivacyNote(dataPolicyForProvider({ id: 'gemini' })),
      'may train on your data',
    )
    assert.equal(
      pickerPrivacyNote(dataPolicyForProvider({ id: 'huggingface' })),
      'retention varies by provider',
    )
    assert.equal(pickerPrivacyNote(dataPolicyForProvider({ id: 'anthropic' })), null)
    assert.equal(pickerPrivacyNote(openRouterDataPolicy(true)), null)
    assert.equal(pickerPrivacyNote(null), null)
  })
})
