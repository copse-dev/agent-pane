import { createConnection } from 'node:net'
import type { LLMProvider } from '@shared/types'
import { EgressLink } from '../container-runtime/egress-link.ts'
import { buildHostInferenceProvider } from '../container-runtime/guest-host-provider.ts'

export const DESKTOP_PARENT_MODEL = 'isolated-parent:session'
export const DESKTOP_INFERENCE_SOCKET = '/tmp/runtime/parent-inference.sock'

/** Supported only in the disposable Linux desktop; this never enables a host execution broker. */
export function isIsolatedDesktopGuest(): boolean {
  return process.platform === 'linux' && process.env['COPSE_DESKTOP_INFERENCE'] === '1'
}

let provider: LLMProvider | undefined
export function desktopGuestProvider(): LLMProvider {
  if (!isIsolatedDesktopGuest())
    throw new Error('Parent inference is available only inside the isolated desktop')
  if (!provider) {
    const socket = createConnection(DESKTOP_INFERENCE_SOCKET)
    const link = new EgressLink(socket, socket)
    // The link handles errors and revocation; no fallback or automatic reconnection.
    provider = buildHostInferenceProvider(link)
  }
  return provider
}
