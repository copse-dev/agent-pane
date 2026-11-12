import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { remoteReadSchema } from '../../../shared/remote-interface.ts'
import type { RemoteInterface } from './remote-interface.ts'

/** Shared by the HTTPS router and boundary tests; authorization is checked after awaits. */
export async function remoteHttp(
  bridge: RemoteInterface,
  authorized: () => boolean,
  body?: string,
): Promise<{ status: number; body: unknown }> {
  if (!authorized()) return { status: 403, body: { error: 'Phone control was disabled.' } }
  if (body === undefined) return { status: 200, body: bridge.snapshot() }
  const request = safeJsonParse(body, decodeWithSchema(remoteReadSchema))
  if (!request) return { status: 400, body: { error: 'Invalid remote request.' } }
  try {
    const value = await bridge.read(request, authorized)
    return { status: 200, body: { value } }
  } catch {
    return {
      status: authorized() ? 503 : 403,
      body: {
        error: authorized() ? 'Desktop request unavailable.' : 'Phone control was disabled.',
      },
    }
  }
}
