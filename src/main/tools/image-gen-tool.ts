import OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { withAppAttribution } from '@copse/llm/app-attribution.ts'
import { defineTool, type ToolDefinition, type ToolExecuteResult } from '@shared/types'
import { getElectronUserDataPath } from '../services/electron-app-runtime.ts'
import { listEnabledAcpAgents } from '../services/acp/acp-agent-registry.ts'
import {
  runAcpImageGeneration,
  ImageGenerationDeclinedError,
} from '../services/acp/acp-image-generation.ts'
import { acpAgentSupportsImageGeneration, acpPlanProvider } from '@shared/acp.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { DeferredApprovalError } from '@shared/threads/deferred-approval.ts'
import { requestApproval, ApprovalPendingError } from '../services/approval.ts'
import { errorMessage } from '@shared/errors.ts'
import { resolveApiKey } from '../services/storage/settings.ts'

export const IMAGE_GEN_TOOL_NAME = 'image_gen'
export const IMAGE_GEN_MODEL = 'gpt-image-2.5-flare'

const imageGenParameters = z.object({
  prompt: z.string().min(1).max(32_000).describe('Text description of the image to generate.'),
  size: z
    .enum(['auto', '1024x1024', '1536x1024', '1024x1536'])
    .optional()
    .default('auto')
    .describe('Output dimensions. Use landscape or portrait when composition calls for it.'),
  quality: z
    .enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional()
    .default('auto')
    .describe('Rendering quality. Auto balances quality, latency, and cost.'),
  background: z
    .enum(['auto', 'opaque', 'transparent'])
    .optional()
    .default('auto')
    .describe('Background treatment. Transparent output remains a PNG with alpha.'),
})

export interface ImageGenerationRequest {
  prompt: string
  size: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  quality: 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  background: 'auto' | 'opaque' | 'transparent'
}

export interface GeneratedImage {
  base64: string
  revisedPrompt?: string
  provider?: string
}

export interface ImageGenDependencies {
  listAgents(): AcpAgentConfig[]
  requestAgentImage(
    agent: AcpAgentConfig,
    request: ImageGenerationRequest,
    signal: AbortSignal,
  ): Promise<GeneratedImage>
  approveApiFallback(
    failures: readonly string[],
    request: ImageGenerationRequest,
    signal: AbortSignal,
  ): Promise<boolean>
  resolveOpenAiKey(): string | null
  requestImage(
    apiKey: string,
    request: ImageGenerationRequest,
    signal: AbortSignal,
  ): Promise<GeneratedImage>
  persistImage(bytes: Buffer, name: string): Promise<string>
}

async function requestOpenAiImage(
  apiKey: string,
  request: ImageGenerationRequest,
  signal: AbortSignal,
): Promise<GeneratedImage> {
  const client = new OpenAI({
    apiKey,
    defaultHeaders: withAppAttribution(),
  })
  const response = await client.images.generate(
    {
      model: IMAGE_GEN_MODEL,
      prompt: request.prompt,
      size: request.size,
      quality: request.quality,
      background: request.background,
      output_format: 'png',
      n: 1,
    },
    { signal },
  )
  const image = response.data?.[0]
  if (!image?.b64_json) {
    throw new Error('OpenAI returned no generated image data.')
  }
  return {
    base64: image.b64_json,
    ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}),
  }
}

async function persistGeneratedImage(bytes: Buffer, name: string): Promise<string> {
  const dir = join(getElectronUserDataPath(), 'generated-images')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, bytes)
  return path
}

const defaultDependencies: ImageGenDependencies = {
  listAgents: listEnabledAcpAgents,
  requestAgentImage: runAcpImageGeneration,
  approveApiFallback: async (failures, request, signal) => {
    const decision = await requestApproval(
      {
        type: 'mcp',
        cause: 'mcp-tool',
        title: 'Use the OpenAI API for this image?',
        body: [
          'Image-capable coding agents did not produce an image. This fallback uses your configured OpenAI API key and incurs API charges, separately from your ChatGPT plan.',
          ...failures,
          `Prompt: ${request.prompt}`,
        ].join('\n\n'),
        approveLabel: 'Use OpenAI API',
        allowRemember: false,
        standalone: true,
      },
      signal,
    )
    signal.throwIfAborted()
    if (!decision.approved && decision.resolution !== undefined && decision.resolution !== 'user') {
      throw new ImageGenerationDeclinedError(
        `The API image fallback was not approved (${decision.resolution}).`,
      )
    }
    return decision.approved
  },
  resolveOpenAiKey: () => resolveApiKey('openai'),
  requestImage: requestOpenAiImage,
  persistImage: persistGeneratedImage,
}

export function createImageGenTool(
  dependencies: ImageGenDependencies = defaultDependencies,
): ToolDefinition<z.output<typeof imageGenParameters>> {
  return defineTool({
    name: IMAGE_GEN_TOOL_NAME,
    provenance: 'external',
    description:
      'Generate one PNG: try enabled Codex first, then other configured image-capable coding agents. If none succeeds, ask the user before using the configured OpenAI API key (separate API charges). Returns an inline bitmap and saves a durable copy. Do not substitute SVG, code, or a screenshot for image generation.',
    parameters: imageGenParameters,
    async execute(request, signal): Promise<ToolExecuteResult> {
      signal.throwIfAborted()
      const agents = dependencies
        .listAgents()
        .filter((agent) => agent.enabled && acpAgentSupportsImageGeneration(agent))
        .sort(
          (a, b) => Number(acpPlanProvider(b) === 'codex') - Number(acpPlanProvider(a) === 'codex'),
        )
      const failures: string[] = []
      let generated: GeneratedImage | undefined
      for (const agent of agents) {
        signal.throwIfAborted()
        try {
          generated = await dependencies.requestAgentImage(agent, request, signal)
          if (!generated.base64) throw new Error('The agent returned no generated image data.')
          generated = { ...generated, provider: agent.title }
          break
        } catch (error) {
          signal.throwIfAborted()
          if (
            error instanceof ImageGenerationDeclinedError ||
            error instanceof DeferredApprovalError ||
            error instanceof ApprovalPendingError
          )
            throw error
          generated = undefined
          failures.push(`${agent.title}: ${errorMessage(error).slice(0, 1500)}`)
        }
      }
      if (!generated) {
        const apiKey = dependencies.resolveOpenAiKey()
        if (!apiKey) {
          throw new Error(
            [
              'No image-capable coding agent produced an image. Enable an image-capable agent in Settings, or add an OpenAI API key for an approved fallback.',
              ...failures,
            ].join('\n'),
          )
        }
        if (!(await dependencies.approveApiFallback(failures, request, signal))) {
          throw new ImageGenerationDeclinedError('The user declined the OpenAI API image fallback.')
        }
        signal.throwIfAborted()
        generated = {
          ...(await dependencies.requestImage(apiKey, request, signal)),
          provider: IMAGE_GEN_MODEL,
        }
      }
      signal.throwIfAborted()
      const bytes = Buffer.from(generated.base64, 'base64')
      if (bytes.length === 0) throw new Error('OpenAI returned an empty generated image.')
      const name = `image-gen-${randomUUID()}.png`
      const path = await dependencies.persistImage(bytes, name)
      const revised = generated.revisedPrompt ? `\nRevised prompt: ${generated.revisedPrompt}` : ''
      return {
        result: `Generated a PNG with ${generated.provider ?? IMAGE_GEN_MODEL} and saved it to ${path}.${revised}`,
        images: [
          {
            dataUrl: `data:image/png;base64,${generated.base64}`,
            name,
            kind: 'screenshot',
          },
        ],
      }
    },
  })
}

export const imageGenTool = createImageGenTool()
