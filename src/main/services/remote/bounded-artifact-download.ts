/**
 * Explicit, user-requested artifact bytes for the main-owned Save dialog.
 * Only the provider adapter's exact HTTPS origin is reachable. Redirects are
 * checked afresh, and no response or platform error may expose a signed URL.
 * Unlike automatic image hydration, the file may have any media type.
 */
import {
  checkDownloadUrl,
  CURSOR_ARTIFACT_DOWNLOAD_ORIGINS,
  MAX_ARTIFACT_IMAGE_REDIRECTS,
  resolveRedirect,
} from './artifact-image/policy.ts'

export const MAX_EXPLICIT_ARTIFACT_BYTES = 32 * 1024 * 1024
const DOWNLOAD_DEADLINE_MS = 30_000
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Read at most 32 MiB, including when Content-Length is absent or false. */
export async function fetchSignedArtifact(
  rawUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const signal = AbortSignal.timeout(DOWNLOAD_DEADLINE_MS)
  let current = checkDownloadUrl(rawUrl, CURSOR_ARTIFACT_DOWNLOAD_ORIGINS)
  for (let hop = 0; hop <= MAX_ARTIFACT_IMAGE_REDIRECTS; hop++) {
    let response: Response
    try {
      response = await fetcher(current.href, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
        signal,
      })
    } catch (error) {
      throw new Error('Could not download the artifact.', { cause: error })
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {})
      const location = response.headers.get('location')
      if (!location || hop === MAX_ARTIFACT_IMAGE_REDIRECTS) {
        throw new Error('Artifact download redirect was blocked.')
      }
      current = resolveRedirect(current, location, CURSOR_ARTIFACT_DOWNLOAD_ORIGINS)
      continue
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      throw new Error('Could not download the artifact.')
    }
    const encoding = response.headers.get('content-encoding')
    if (encoding && encoding.toLowerCase() !== 'identity') {
      await response.body?.cancel().catch(() => {})
      throw new Error('Artifact download encoding was blocked.')
    }
    const declared = response.headers.get('content-length')
    if (
      declared !== null &&
      (!/^\d{1,12}$/u.test(declared) || Number(declared) > MAX_EXPLICIT_ARTIFACT_BYTES)
    ) {
      await response.body?.cancel().catch(() => {})
      throw new Error('Artifact download is too large.')
    }
    if (!response.body) {
      if (declared !== null && Number(declared) !== 0) {
        throw new Error('Artifact download was incomplete.')
      }
      return Buffer.alloc(0)
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let received = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_EXPLICIT_ARTIFACT_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error('Artifact download is too large.')
        }
        chunks.push(Buffer.from(value))
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'Artifact download is too large.') throw error
      throw new Error('Could not download the artifact.', { cause: error })
    }
    if (declared !== null && received !== Number(declared)) {
      throw new Error('Artifact download was incomplete.')
    }
    return Buffer.concat(chunks, received)
  }
  throw new Error('Artifact download redirect was blocked.')
}
