import OpenAI from 'openai'
import { ResponsesProvider } from '@copse/llm/responses-provider.ts'
import type { LLMProvider, ProviderStreamChunk } from '@copse/llm/wire-types.ts'

export type AzurePrototypeAuth =
  | { kind: 'api-key'; key: string }
  | {
      kind: 'entra'
      /** An identity SDK owns caching/renewal; called before every HTTP attempt. */
      getToken: (signal: AbortSignal) => Promise<{ token: string; expiresAt: number }>
    }

export class AzurePrototypeError extends Error {
  readonly code: 'auth' | 'forbidden' | 'deployment' | 'quota' | 'transport' | 'stream'

  constructor(code: AzurePrototypeError['code']) {
    const messages = {
      auth: 'Azure authentication failed. Renew the selected credential and retry.',
      forbidden: 'Azure denied inference. Check the selected identity and resource permissions.',
      deployment: 'Azure deployment was not found. Check the resource and deployment name.',
      quota: 'Azure quota or rate limit reached. Check the deployment quota and retry later.',
      transport: 'Azure request failed. Check the resource connection and retry.',
      stream: 'Azure stream ended without a terminal response. The partial turn was not replayed.',
    }
    super(messages[code])
    this.name = 'AzurePrototypeError'
    this.code = code
  }
}

/** Public Azure resource endpoints only; private/sovereign/custom gateways are out of scope. */
export function azureResponsesUrl(endpoint: string): string {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Error('Use an HTTPS Azure OpenAI resource endpoint.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^[a-z0-9][a-z0-9-]*\.(?:openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname) ||
    !['/', '/openai/v1', '/openai/v1/'].includes(url.pathname)
  ) {
    throw new Error('Use an HTTPS Azure resource root or its /openai/v1 endpoint.')
  }
  return `${url.origin}/openai/v1/responses`
}

function safeError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted || error instanceof OpenAI.APIUserAbortError)
    return new DOMException('Azure request cancelled', 'AbortError')
  if (error instanceof AzurePrototypeError) return error
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401) return new AzurePrototypeError('auth')
    if (error.status === 403) return new AzurePrototypeError('forbidden')
    if (error.status === 404) return new AzurePrototypeError('deployment')
    if (error.status === 429) return new AzurePrototypeError('quota')
  }
  // Deliberately do not retain SDK bodies, headers or causes: they can echo secrets.
  return new AzurePrototypeError('transport')
}

/** Cancellation must stop waiting even when an identity SDK ignores AbortSignal. */
async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const onAbort = (): void => {
    cancelled.reject(new DOMException('Cancelled', 'AbortError'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted()
        return operation()
      }),
      cancelled.promise,
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Experimental connection, intentionally outside app routing. Requiring a
 * transport makes the offline demo incapable of falling through to real fetch.
 */
export function createAzurePrototype(
  connection: { endpoint: string; deployment: string; auth: AzurePrototypeAuth },
  transport: { fetch: typeof globalThis.fetch; now?: () => number },
): LLMProvider {
  const target = azureResponsesUrl(connection.endpoint)
  const deployment = connection.deployment.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(deployment))
    throw new Error(
      'Use an Azure deployment name of 1–128 letters, digits, dots, hyphens or underscores.',
    )
  // Pin connection selection even if its caller later changes a settings object.
  const auth = { ...connection.auth }
  const send = transport.fetch
  const now = transport.now ?? Date.now
  const azureFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    if (request.url !== target || request.method !== 'POST')
      throw new Error('Azure transport refused a request outside the selected deployment endpoint.')
    request.signal.throwIfAborted()
    let token: string
    try {
      if (auth.kind === 'api-key') token = auth.key
      else {
        const credential = await abortable(() => auth.getToken(request.signal), request.signal)
        if (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= now() + 30_000)
          throw new Error('Credential needs renewal')
        token = credential.token
      }
      if (!token.trim() || /[\r\n]/.test(token)) throw new Error('Credential unavailable')
    } catch {
      request.signal.throwIfAborted()
      // A local credential failure is terminal, not an SDK connection error
      // that the existing transport retry loop would replay four times.
      return Response.json({ error: { message: 'Azure credential unavailable' } }, { status: 401 })
    }
    request.signal.throwIfAborted()
    const headers = new Headers(request.headers)
    headers.delete('api-key')
    headers.delete('openai-organization')
    headers.delete('openai-project')
    headers.set('authorization', `Bearer ${token}`)
    return send(new Request(request, { headers, redirect: 'error' }))
  }
  const provider = new ResponsesProvider(deployment, {
    baseURL: target.slice(0, -'/responses'.length),
    apiKey: 'azure-transport-owned-auth',
    fetch: azureFetch,
    extraBody: { store: false },
  })
  return {
    async *stream(messages, tools, signal, options): AsyncIterable<ProviderStreamChunk> {
      let terminal = false
      try {
        signal?.throwIfAborted()
        for await (const chunk of provider.stream(messages, tools, signal, options)) {
          signal?.throwIfAborted()
          if (chunk.type === 'done') terminal = true
          yield chunk
        }
        signal?.throwIfAborted()
        if (!terminal) throw new AzurePrototypeError('stream')
      } catch (error) {
        throw safeError(error, signal)
      }
    },
  }
}
