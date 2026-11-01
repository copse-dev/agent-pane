import { z } from 'zod'

export class RemoteRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RemoteRequestError'
    this.status = status
  }
}

export async function request(path: string, options: RequestInit = {}): Promise<unknown> {
  const token = localStorage.getItem('copse-mobile-token')
  if (!token) throw new Error('Pair this browser with your Mac first.')
  const headers = new Headers(options.headers)
  headers.set('Authorization', 'Bearer ' + token)
  const response = await fetch(path, { ...options, headers, signal: AbortSignal.timeout(35000) })
  const value: unknown = await response.json()
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
