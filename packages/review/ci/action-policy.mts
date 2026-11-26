import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import { ForgePublicationSkippedError, type FetchLike } from '../src/forge-review.ts'

// The lockfile checks moved beside the local pull-request shell, which shares them.
export { copsePnpmPatches, npmTarballs } from '../src/dependency-policy.ts'

const sha = z.string().regex(/^[0-9a-f]{40}$/)
const requestSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  pr: z.number().int().positive(),
  head: sha,
  base: sha,
})

export function decodeActionRequest(text: string): z.infer<typeof requestSchema> {
  const request = safeJsonParse(text, decodeWithSchema(requestSchema))
  if (request === null) throw new Error('Invalid Copse review request')
  return request
}

const currentPullSchema = z.object({
  state: z.string(),
  head: z.object({ sha }),
  base: z.object({ sha }),
  draft: z.boolean(),
  labels: z.array(z.object({ name: z.string() })),
})

/** Recheck freshness and opt-out before every publishing mutation, including superseding reviews. */
export function actionPublishingFetch(
  request: ReturnType<typeof decodeActionRequest>,
  readToken: string,
  fetchImpl: FetchLike = fetch,
): FetchLike {
  const pullUrl = `https://api.github.com/repos/${request.repository}/pulls/${String(request.pr)}`
  return async (url, init) => {
    if (init.method !== 'GET') {
      const response = await fetchImpl(pullUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${readToken}`, Accept: 'application/vnd.github+json' },
      })
      const pull = safeJsonParse(await response.text(), decodeWithSchema(currentPullSchema))
      if (response.status !== 200 || pull === null) {
        throw new Error('Copse did not publish: GitHub could not attest the current PR')
      }
      const labels = pull.labels.map((label) => label.name)
      if (
        pull.state !== 'open' ||
        pull.head.sha !== request.head ||
        pull.base.sha !== request.base ||
        labels.includes('copse-review-skip') ||
        (pull.draft && !labels.includes('copse-review'))
      ) {
        throw new ForgePublicationSkippedError(
          'Copse did not publish: the PR changed, closed, or opted out during review',
        )
      }
    }
    return fetchImpl(url, init)
  }
}
