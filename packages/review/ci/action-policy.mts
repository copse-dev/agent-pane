import { z } from 'zod'
import { load as loadYaml } from 'js-yaml'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'
import type { FetchLike } from '../src/forge-review.ts'

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

const lockSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(
    z.string(),
    z.object({
      resolved: z.string().optional(),
      integrity: z.string().optional(),
      link: z.boolean().optional(),
    }),
  ),
})

/** Only registry tarballs are fetched on the trusted host, never a contributor manifest. */
export function npmTarballs(text: string): string[] {
  const lock = safeJsonParse(text, decodeWithSchema(lockSchema))
  if (lock === null) throw new Error('Copse Actions requires an npm v2/v3 package-lock.json')
  const urls = new Set<string>()
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue
    if (
      !path.startsWith('node_modules/') ||
      entry.link ||
      !entry.resolved ||
      !entry.integrity?.match(/^sha512-[A-Za-z0-9+/]+=*$/)
    ) {
      throw new Error(
        'Copse Actions requires integrity-pinned registry dependencies; links are unsupported',
      )
    }
    const url = new URL(entry.resolved)
    if (
      url.origin !== 'https://registry.npmjs.org' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      !url.pathname.endsWith('.tgz')
    ) {
      throw new Error('Copse Actions only fetches HTTPS tarballs from registry.npmjs.org')
    }
    urls.add(url.href)
  }
  return [...urls]
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
      const labels = pull?.labels.map((label) => label.name) ?? []
      if (
        response.status !== 200 ||
        pull === null ||
        pull.state !== 'open' ||
        pull.head.sha !== request.head ||
        pull.base.sha !== request.base ||
        labels.includes('copse-review-skip') ||
        (pull.draft && !labels.includes('copse-review'))
      ) {
        throw new Error('Copse did not publish: the PR changed, closed, or opted out during review')
      }
    }
    return fetchImpl(url, init)
  }
}

const pnpmLockSchema = z.object({
  lockfileVersion: z.literal('9.0'),
  packages: z.record(
    z.string(),
    z.object({
      resolution: z.union([
        z.object({ integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/) }).strict(),
        z
          .object({ directory: z.literal('packages/extract-zip'), type: z.literal('directory') })
          .strict(),
      ]),
    }),
  ),
  patchedDependencies: z
    .record(
      z.string(),
      z.object({
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        path: z.string().regex(/^patches\/[^/]+\.patch$/),
      }),
    )
    .optional(),
})

/** Copse's one reviewed directory dependency stays in the cell; the host only fetches registry data. */
export function copsePnpmPatches(text: string): Record<string, string> {
  const lock = pnpmLockSchema.parse(loadYaml(text))
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (Object.hasOwn(entry.resolution, 'directory')) {
      if (name !== 'extract-zip@file:packages/extract-zip') {
        throw new Error('Only the reviewed Copse extract-zip directory dependency is supported')
      }
    } else if (!/^(?:@[^/\s]+\/)?[^@/:\s]+@[^/:\s]+$/.test(name)) {
      throw new Error('Copse Actions requires registry package versions')
    }
  }
  return Object.fromEntries(
    Object.entries(lock.patchedDependencies ?? {}).map(([name, patch]) => [name, patch.path]),
  )
}
