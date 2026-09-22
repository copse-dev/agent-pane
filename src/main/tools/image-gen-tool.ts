import OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { withAppAttribution } from '@copse/llm/app-attribution.ts'
import { defineTool, type ToolDefinition, type ToolExecuteResult } from '@shared/types'
import { getElectronUserDataPath } from '../services/electron-app-runtime.ts'
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

interface GeneratedImage {
  base64: string
  revisedPrompt?: string
}

interface ImageGenDependencies {
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
    description: `Generate one PNG from a text prompt with ${IMAGE_GEN_MODEL} using the configured OpenAI API key. Returns the generated bitmap as an inline tool-result image and saves a durable copy under Copse's profile.`,
    parameters: imageGenParameters,
    async execute(request, signal): Promise<ToolExecuteResult> {
      const apiKey = dependencies.resolveOpenAiKey()
      if (!apiKey) {
        throw new Error(
          'OpenAI image generation is not configured. Add an OpenAI API key in Settings and retry.',
        )
      }
      const generated = await dependencies.requestImage(apiKey, request, signal)
      const bytes = Buffer.from(generated.base64, 'base64')
      if (bytes.length === 0) throw new Error('OpenAI returned an empty generated image.')
      const name = `image-gen-${randomUUID()}.png`
      const path = await dependencies.persistImage(bytes, name)
      const revised = generated.revisedPrompt ? `\nRevised prompt: ${generated.revisedPrompt}` : ''
      return {
        result: `Generated a PNG with ${IMAGE_GEN_MODEL} and saved it to ${path}.${revised}`,
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
