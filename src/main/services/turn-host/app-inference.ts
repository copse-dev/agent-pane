import type { LLMStreamOptions, ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import { buildProvider, type BuildProviderOptions } from '../providers/provider-selection.ts'
import type { HostInferRequest } from './turn-host-protocol.ts'

/**
 * Make a worker's model call here, with this app's keys and settings, as an
 * in-process turn would (`host-inference-relay.ts` is the worker's end).
 */
export async function* appInference(
  request: HostInferRequest,
  signal: AbortSignal,
): AsyncIterable<ProviderStreamChunk> {
  const { reasoning, maxReasoning, maxOutputTokens } = request.providerOptions
  const opts: BuildProviderOptions = {
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(maxReasoning === undefined ? {} : { maxReasoning }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
  const provider = await buildProvider(request.model, request.promptCacheKey, opts)
  const { toolChoice, compactAtTokens, suppressReasoning } = request.options ?? {}
  const options: LLMStreamOptions = {
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(compactAtTokens === undefined ? {} : { compactAtTokens }),
    ...(suppressReasoning === undefined ? {} : { suppressReasoning }),
  }
  yield* provider.stream(request.messages, request.tools, signal, options)
}
