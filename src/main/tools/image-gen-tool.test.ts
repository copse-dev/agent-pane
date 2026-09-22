import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createImageGenTool, IMAGE_GEN_MODEL } from './image-gen-tool.ts'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'

describe('imageGenTool', () => {
  it('generates, persists, and returns one inline PNG', async () => {
    const persisted: Array<{ bytes: Buffer; name: string }> = []
    const requests: Array<{
      apiKey: string
      prompt: string
      size: string
      quality: string
      background: string
      aborted: boolean
    }> = []
    const tool = createImageGenTool({
      resolveOpenAiKey: () => 'sk-test',
      requestImage: async (apiKey, request, signal) => {
        requests.push({ apiKey, ...request, aborted: signal.aborted })
        return { base64: PNG_BASE64, revisedPrompt: 'A friendly orange tabby.' }
      },
      persistImage: async (bytes, name) => {
        persisted.push({ bytes, name })
        return `/profile/generated-images/${name}`
      },
    })

    const args = tool.parameters.parse({ prompt: 'Show me a cat' })
    const result = await tool.execute(args, new AbortController().signal)

    assert.equal(requests.length, 1)
    assert.deepEqual(requests[0], {
      apiKey: 'sk-test',
      prompt: 'Show me a cat',
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      aborted: false,
    })
    const saved = persisted[0]
    assert.ok(saved)
    assert.match(saved.name, /^image-gen-[\w-]+\.png$/)
    assert.deepEqual(saved.bytes, Buffer.from(PNG_BASE64, 'base64'))
    assert.notEqual(typeof result, 'string')
    if (typeof result === 'string') assert.fail('expected a structured image result')
    assert.match(result.result, new RegExp(IMAGE_GEN_MODEL))
    assert.match(result.result, /Revised prompt: A friendly orange tabby\./)
    assert.deepEqual(result.images, [
      {
        dataUrl: `data:image/png;base64,${PNG_BASE64}`,
        name: saved.name,
        kind: 'screenshot',
      },
    ])
  })

  it('fails before making a request when the OpenAI key is unavailable', async () => {
    let requested = false
    const tool = createImageGenTool({
      resolveOpenAiKey: () => null,
      requestImage: async () => {
        requested = true
        return { base64: PNG_BASE64 }
      },
      persistImage: async () => '/unused.png',
    })

    const args = tool.parameters.parse({ prompt: 'Show me a cat' })
    await assert.rejects(
      async () => await tool.execute(args, new AbortController().signal),
      /Add an OpenAI API key in Settings/,
    )
    assert.equal(requested, false)
  })
})
