import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { modelCardCandidates, modelIdForms } from './model-card-candidates.ts'
import { MODEL_CARDS } from './model-cards.ts'

const urls = (id: string): string[] => modelCardCandidates(id).map((c) => c.url)
const origins = (id: string): string[] => modelCardCandidates(id).map((c) => c.origin)

describe('modelIdForms', () => {
  it('collects the aliases other providers serve the same weights under', () => {
    const forms = modelIdForms('claude-opus-4-8')
    assert.ok(forms.includes('claude-opus-4-8'))
    // Curated in scripts/data/intellect-scores.json as an OpenRouter route.
    assert.ok(forms.includes('anthropic/claude-opus-4-8'))
  })

  it('reaches the same aliases from a wrapped id form', () => {
    const forms = modelIdForms('openrouter:anthropic/claude-opus-4-8')
    for (const expected of modelIdForms('claude-opus-4-8')) {
      assert.ok(forms.includes(expected), `missing ${expected}`)
    }
    // Plus the id as given, so a caller can always find the form it passed in.
    assert.ok(forms.includes('openrouter:anthropic/claude-opus-4-8'))
  })

  it('returns just the id when nothing is known about it', () => {
    assert.deepEqual(modelIdForms('nobody/knows-this'), ['nobody/knows-this'])
  })
})

describe('modelCardCandidates', () => {
  it('puts the reviewed card first', () => {
    const [first] = modelCardCandidates('claude-opus-4-8')
    assert.ok(first)
    assert.equal(first.origin, 'curated')
    assert.equal(first.url, MODEL_CARDS['claude-opus-4-8']?.url)
  })

  it('never offers a Hugging Face URL for a closed commercial model', () => {
    // `anthropic/claude-opus-4-8` is an OpenRouter route, not an org/repo — a
    // probe could resolve it to an unrelated repo of that name.
    for (const id of ['claude-opus-4-8', 'openrouter:anthropic/claude-opus-4-8', 'gpt-4o']) {
      assert.deepEqual(
        urls(id).filter((u) => u.includes('huggingface.co')),
        [],
        `${id} must not produce a Hugging Face candidate`,
      )
    }
  })

  it('derives the router card for a Hugging Face id, ahead of nothing else', () => {
    const [first] = modelCardCandidates('huggingface:zai-org/GLM-5.2:novita')
    assert.ok(first)
    assert.equal(first.url, 'https://huggingface.co/zai-org/GLM-5.2')
    assert.equal(first.origin, 'hf-router')
  })

  it('tries the canonical repo path first, then other providers’ spellings', () => {
    // This is the case model-cards.ts refuses to answer blind. OpenRouter
    // lower-cases and re-orgs the same weights, so its spelling is a guess and
    // must be probed only after the reviewed canonical path fails.
    const candidates = modelCardCandidates('openrouter:zai-org/GLM-5.2')
    const [first] = candidates
    assert.ok(first)
    assert.equal(first.url, 'https://huggingface.co/zai-org/GLM-5.2')
    assert.equal(first.origin, 'hf-alias')
    assert.ok(
      candidates.slice(1).every((c) => c.origin === 'hf-derived'),
      'other-provider spellings must rank below the canonical path',
    )
    // The OpenRouter spelling is still offered — it is a real fallback.
    assert.ok(candidates.some((c) => c.url === 'https://huggingface.co/z-ai/glm-5.2'))
  })

  it('ranks the reviewed spelling above every guessed one', () => {
    // MiniMaxAI/MiniMax-M3 is a canonical intellect id, so its casing is reviewed.
    const ranks = origins('MiniMaxAI/MiniMax-M3')
    assert.equal(ranks[0], 'hf-alias', `expected hf-alias first, got ${ranks.join(', ')}`)
    assert.ok(ranks.slice(1).every((r) => r === 'hf-derived'))
  })

  it('deduplicates a URL two id forms both produce', () => {
    const list = urls('huggingface:MiniMaxAI/MiniMax-M3')
    assert.equal(new Set(list).size, list.length)
  })

  it('returns nothing for a model with no card and no repo-shaped id', () => {
    assert.deepEqual(modelCardCandidates('lmstudio:some-local-gguf'), [])
  })
})
