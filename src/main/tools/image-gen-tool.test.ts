import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolExecuteResult } from '@shared/types'
import { createImageGenTool, IMAGE_GEN_MODEL, type ImageGenDependencies } from './image-gen-tool.ts'

const unusedAgents: Pick<
  ImageGenDependencies,
  'listAgents' | 'requestAgentImage' | 'approveApiFallback'
> = {
  listAgents: () => [],
  requestAgentImage: async () => {
    throw new Error('Unexpected ACP request')
  },
  approveApiFallback: async () => true,
}

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
      ...unusedAgents,
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
      ...unusedAgents,
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
      /add an OpenAI API key/,
    )
    assert.equal(requested, false)
  })
})

const codex = { id: 'codex-acp', title: 'Codex', command: 'codex-acp', enabled: true }
const other = {
  id: 'image-agent',
  title: 'Image agent',
  command: 'image-agent',
  enabled: true,
  imageGeneration: true,
}

function routingTool(overrides: Partial<ImageGenDependencies> = {}): {
  calls: string[]
  run: (signal?: AbortSignal) => Promise<ToolExecuteResult>
} {
  const calls: string[] = []
  const tool = createImageGenTool({
    listAgents: () => [other, codex],
    requestAgentImage: async (agent) => {
      calls.push(agent.id)
      return { base64: PNG_BASE64 }
    },
    resolveOpenAiKey: () => 'sk-test',
    approveApiFallback: async (failures) => {
      calls.push(`approve:${failures.join('|')}`)
      return true
    },
    requestImage: async () => {
      calls.push('api')
      return { base64: PNG_BASE64 }
    },
    persistImage: async () => '/profile/image.png',
    ...overrides,
  })
  return {
    calls,
    run: async (signal = new AbortController().signal): Promise<ToolExecuteResult> =>
      tool.execute(tool.parameters.parse({ prompt: 'A cat' }), signal),
  }
}

describe('image generation routing', () => {
  it('tries Codex before other runners and never consults the API on success', async () => {
    const { calls, run } = routingTool()
    const result = await run()
    assert.deepEqual(calls, ['codex-acp'])
    assert.notEqual(typeof result, 'string')
    if (typeof result === 'string') assert.fail()
    assert.match(result.result, /with Codex/)
  })

  it('prefers a Codex adapter configured under a custom id when opted in', async () => {
    const { calls, run } = routingTool({
      listAgents: () => [other, { ...codex, id: 'custom-codex', imageGeneration: true }],
    })
    await run()
    assert.deepEqual(calls, ['custom-codex'])
  })

  it('tries another image-capable runner after Codex fails', async () => {
    const attempted: string[] = []
    const { calls, run } = routingTool({
      requestAgentImage: async (agent) => {
        attempted.push(agent.id)
        if (agent.id === 'codex-acp') throw new Error('Native image tool unavailable')
        return { base64: PNG_BASE64 }
      },
    })
    await run()
    assert.deepEqual(attempted, ['codex-acp', 'image-agent'])
    assert.deepEqual(calls, [])
  })

  it('does not infer generation from an enabled coding agent, and respects opt-outs', async () => {
    const { calls, run } = routingTool({
      listAgents: () => [
        { ...codex, imageGeneration: false },
        { ...other, enabled: false },
        { id: 'claude-acp', title: 'Claude', command: 'claude-agent-acp', enabled: true },
      ],
    })
    await run()
    assert.deepEqual(calls, ['approve:', 'api'])
  })

  it('requires approval after all runners fail, carrying their errors into the fallback', async () => {
    const { calls, run } = routingTool({
      requestAgentImage: async () => {
        throw new Error('image unavailable')
      },
    })
    await run()
    assert.deepEqual(calls, [
      'approve:Codex: image unavailable|Image agent: image unavailable',
      'api',
    ])
  })

  it('does not call the API when fallback approval is declined', async () => {
    const { calls, run } = routingTool({
      listAgents: () => [],
      approveApiFallback: async () => false,
    })
    await assert.rejects(() => run(), /declined/)
    assert.deepEqual(calls, [])
  })

  it('reports runner failures without prompting when no API key is configured', async () => {
    const { calls, run } = routingTool({
      resolveOpenAiKey: () => null,
      requestAgentImage: async () => {
        throw new Error('native tool missing')
      },
    })
    await assert.rejects(() => run(), /Codex: native tool missing/)
    assert.deepEqual(calls, [])
  })

  it('stops routing when aborted during a runner request', async () => {
    const controller = new AbortController()
    const { calls, run } = routingTool({
      requestAgentImage: async () => {
        controller.abort(new Error('Stopped'))
        throw new Error('runner stopped')
      },
    })
    await assert.rejects(() => run(controller.signal), /Stopped/)
    assert.deepEqual(calls, [])
  })

  it('stops routing after a runner permission is declined', async () => {
    const { ImageGenerationDeclinedError } = await import('../services/acp/acp-image-generation.ts')
    const { calls, run } = routingTool({
      requestAgentImage: async () => {
        throw new ImageGenerationDeclinedError('Declined runner permission')
      },
    })
    await assert.rejects(() => run(), /Declined runner permission/)
    assert.deepEqual(calls, [])
  })
})
