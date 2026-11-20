import { z } from 'zod'
import { ConditionalReads, conditionalGet } from './conditional-reads.ts'

export class RemoteRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RemoteRequestError'
    this.status = status
  }
}

const reads = new ConditionalReads()

/**
 * A read (no method, or GET) that the Mac reports unchanged resolves to the
 * same object as the read before it; see {@link ConditionalReads}.
 */
export async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = localStorage.getItem('copse-mobile-token')
  if (!token) throw new Error('Pair this browser with your Mac first.')
  const send = (conditional: Record<string, string>): Promise<Response> => {
    const headers = new Headers(options.headers)
    headers.set('Authorization', 'Bearer ' + token)
    for (const [name, value] of Object.entries(conditional)) headers.set(name, value)
    return fetch(path, { ...options, headers, signal: AbortSignal.timeout(35000) })
  }
  const read = options.method === undefined || options.method === 'GET'
  const result = read ? await conditionalGet(reads, path, send) : { response: await send({}) }
  if ('unchanged' in result) return result.unchanged
  const { response } = result
  const value: unknown = await response.json()
  if (read) {
    // A refusal says nothing held is still current: a revoked pairing must not
    // be answered from memory.
    if (response.ok) reads.remember(path, response.headers.get('ETag'), value)
    else reads.clear()
  }
  if (!response.ok) {
    const detail = z.object({ error: z.string().optional() }).safeParse(value)
    throw new RemoteRequestError(
      response.status,
      detail.success && detail.data.error
        ? detail.data.error
        : `Mac connection unavailable (${String(response.status)}). Your draft is kept.`,
    )
  }
  return value
}
