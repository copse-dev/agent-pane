import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseHuggingFaceModels, selectBestHfProvider } from './huggingface-models.ts'

describe('selectBestHfProvider', () => {
  it('picks the cheapest live, tool-capable provider by input+output rate', () => {
    const best = selectBestHfProvider([
      {
        provider: 'together',
        status: 'live',
        supports_tools: true,
        context_length: 1_048_576,
        pricing: { input: 1.69, output: 3.38 },
      },
      {
        provider: 'novita',
        status: 'live',
        supports_tools: true,
        context_length: 512_000,
        pricing: { input: 1.5, output: 3.0 },
      },
    ])
    assert.equal(best?.provider, 'novita')
    assert.equal(best?.contextLength, 512_000)
    assert.equal(best?.inputPricePerMTok, 1.5)
    assert.equal(best?.outputPricePerMTok, 3.0)
  })

  it('skips non-live providers and ones flagged unable to use tools', () => {
    const best = selectBestHfProvider([
      { provider: 'cheap-dead', status: 'error', pricing: { input: 0.1, output: 0.1 } },
      { provider: 'cheap-no-tools', supports_tools: false, pricing: { input: 0.2, output: 0.2 } },
      {
        provider: 'fireworks',
        status: 'live',
        supports_tools: true,
        pricing: { input: 2, output: 4 },
      },
    ])
    assert.equal(best?.provider, 'fireworks')
  })

  it('skips providers with no reported price and returns null when none qualify', () => {
    assert.equal(
      selectBestHfProvider([{ provider: 'free', status: 'live', supports_tools: true }]),
      null,
    )
    assert.equal(selectBestHfProvider([]), null)
    assert.equal(selectBestHfProvider(undefined), null)
  })

  it('defaults output to the input rate when only input is reported', () => {
    const best = selectBestHfProvider([{ provider: 'p', pricing: { input: 5 } }])
    assert.equal(best?.inputPricePerMTok, 5)
    assert.equal(best?.outputPricePerMTok, 5)
  })
})

describe('parseHuggingFaceModels', () => {
  it('pins the chosen provider into the id and carries price + context', () => {
    const models = parseHuggingFaceModels({
      object: 'list',
      data: [
        {
          id: 'zai-org/GLM-5.2',
          providers: [
            {
              provider: 'together',
              status: 'live',
              supports_tools: true,
              context_length: 131_072,
              pricing: { input: 0.6, output: 2.2 },
            },
          ],
        },
      ],
    })
    assert.equal(models.length, 1)
    assert.deepEqual(models[0], {
      id: 'zai-org/GLM-5.2:together',
      label: 'zai-org/GLM-5.2',
      contextWindow: 131_072,
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.2,
    })
  })

  it('drops models with no priceable, eligible provider', () => {
    const models = parseHuggingFaceModels({
      data: [
        { id: 'a/unpriced', providers: [{ provider: 'x', status: 'live', supports_tools: true }] },
        { id: 'b/ok', providers: [{ provider: 'y', pricing: { input: 1, output: 1 } }] },
      ],
    })
    assert.deepEqual(
      models.map((m) => m.id),
      ['b/ok:y'],
    )
  })

  it('tolerates a malformed payload', () => {
    assert.deepEqual(parseHuggingFaceModels(null), [])
    assert.deepEqual(parseHuggingFaceModels({}), [])
    assert.deepEqual(parseHuggingFaceModels({ data: 'nope' }), [])
  })
})
