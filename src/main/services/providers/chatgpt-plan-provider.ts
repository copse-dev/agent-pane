import OpenAI from 'openai'
import { ResponsesProvider } from '@copse/llm/responses-provider.ts'
import { withCredentialOutputRedaction } from '@copse/llm/credential-output-provider.ts'
import { withSecretRedaction } from '@copse/llm/redacting-provider.ts'
import { redactSecrets } from '@copse/llm/redact-secrets.ts'
import type { LLMProvider } from '@shared/types'
import type { ProviderStreamChunk } from '@copse/llm/wire-types.ts'
import type { ModelParameters } from '@copse/llm/model-parameters.ts'
import type { ChatGptPlanService } from './chatgpt-plan-service.ts'

/** Keep upstream diagnostics useful without retaining a token-bearing SDK cause. */
function planRequestError(error: unknown, secrets: readonly string[]): Error {
  const message =
    error instanceof Error ? redactSecrets(error.message, secrets) : 'ChatGPT plan request failed.'
  const cause = new Error(message)
  if (error instanceof OpenAI.APIError) {
    const code = redactSecrets(error.code ?? '', secrets)
    if (code === 'subscription_sharing_usage_limit_exceeded')
      return new Error(
        'ChatGPT plan usage limit reached. Review your plan or Copse’s allowance.\n\n[Manage usage](https://chatgpt.com/settings/usage)',
        { cause },
      )
    if (code === 'subscription_sharing_user_not_eligible')
      return new Error(
        'This ChatGPT account or workspace is not eligible for plan usage in Copse.',
        { cause },
      )
    const requestId = error.requestID ? `, request ${redactSecrets(error.requestID, secrets)}` : ''
    return new Error(
      `ChatGPT plan request failed (HTTP ${String(error.status ?? 'stream')}${code ? `, ${code}` : ''}${requestId}): ${message}`,
      { cause },
    )
  }
  return new Error(message, { cause })
}

export function createChatGptPlanProvider(
  service: ChatGptPlanService,
  selection: { clientId: string; model: string },
  modelValue: string,
  params: ModelParameters,
  threadId?: string,
): LLMProvider {
  return {
    async *stream(messages, tools, signal, options): AsyncIterable<ProviderStreamChunk> {
      const sessionSignal = service.requestSignal(selection.clientId)
      const requestSignal = signal ? AbortSignal.any([signal, sessionSignal]) : sessionSignal
      requestSignal.throwIfAborted()
      const credentials = await service.credentials(selection.clientId)
      requestSignal.throwIfAborted()
      const secrets = [credentials.accessToken, credentials.refreshToken, credentials.idToken]
      const provider = withSecretRedaction(
        new ResponsesProvider(selection.model, {
          apiKey: credentials.accessToken,
          chatGptPlan: true,
          reasoningSummaries: true,
          encryptedReasoning: true,
          params,
          // Partition reasoning replay by registration so switching accounts cannot
          // replay another account's opaque encrypted content. Never sent as a host ID.
          ...(threadId ? { promptCacheKey: `${selection.clientId}:${threadId}` } : {}),
        }),
        secrets,
      )
      try {
        for await (const chunk of withCredentialOutputRedaction(provider, secrets, (error) =>
          planRequestError(error, secrets),
        ).stream(messages, tools, requestSignal, options)) {
          yield chunk.type === 'usage' ? { ...chunk, model: modelValue } : chunk
        }
      } catch (error) {
        throw planRequestError(error, secrets)
      }
    },
  }
}
