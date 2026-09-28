// Images a reviewer can look at (docs/plans/copse-reviewer.md, §Images in review):
// an image file the change adds or modifies, on either side, and an image
// posted in the pull request's conversation. Both reach the model as a
// `ToolResultImage` from `view_image`; neither is ever executed or rendered.
//
// Remote images are the careful part. Only a URL that appeared in the
// conversation can be fetched (the reviewer names an opaque id, never a URL),
// over https, from the forge's own hosts or hosts the caller allowlisted, with
// every redirect re-checked. The forge token goes only to the forge's API: a
// same-repository raw link at a commit is read through the contents endpoint,
// which also works for a private repository; anything else is fetched without
// credentials.
import type { ToolResultImage } from '@copse/llm/wire-types.ts'
import type { ReviewContext } from './context.ts'
import type { PullRequestRef } from './pr-conversation.ts'

/** Anthropic's per-image ceiling; the others accept at least this much. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 3

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i

/** Image files the change adds or modifies; a deleted one has nothing on head to look at. */
export function changedImagePaths(context: Pick<ReviewContext, 'files'>): string[] {
  return context.files
    .filter((file) => file.status !== 'deleted' && IMAGE_EXTENSIONS.test(file.path))
    .map((file) => file.path)
}

/**
 * What a reviewer can pass to `view_image`, for a prompt: the changed image
 * files and the conversation's image index. Empty when there is nothing to see.
 */
export function describeReviewImages(context: ReviewContext): string[] {
  const paths = changedImagePaths(context)
  const conversation = context.conversation?.images ?? []
  if (paths.length === 0 && conversation.length === 0) return []
  return [
    'Images you can look at with view_image:',
    ...paths.map((path) => `- ${path} (changed; head and base)`),
    ...conversation.map((image) => `- ${image.id}: ${image.label} (${image.postedIn})`),
  ]
}

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

/** The image type from its first bytes, or `null` for anything a provider would refuse. */
export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  const at = (index: number): number => bytes[index] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png'
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif'
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...bytes.subarray(start, end))
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  return null
}

/** A validated image as the model receives it. */
export function toToolResultImage(bytes: Uint8Array, name: string): ToolResultImage {
  const mime = sniffImageType(bytes)
  if (mime === null) throw new Error(`${name} is not a PNG, JPEG, GIF or WebP image`)
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `${name} is ${String(bytes.byteLength)} bytes; the limit is ${String(MAX_IMAGE_BYTES)}`,
    )
  }
  return {
    dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    name,
    kind: 'screenshot',
  }
}

export type BinaryFetchLike = (
  url: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    redirect: 'manual'
    signal: AbortSignal
  },
) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  /** Read as a stream, so an oversized body is cancelled at the cap, never buffered whole. */
  body: ReadableStream<Uint8Array> | null
}>

export interface RemoteImageOptions {
  readonly fetch?: BinaryFetchLike
  /** Extra hostnames, matched exactly, that images may be fetched from. */
  readonly extraHosts?: readonly string[]
}

/** Fetches one conversation image by URL, or says why it would not. */
export type RemoteImageFetcher = (url: string, signal: AbortSignal) => Promise<Uint8Array>

function webOrigin(ref: PullRequestRef): URL {
  const api = new URL(ref.apiBase)
  if (ref.forge === 'forgejo') return new URL(api.origin)
  // api.github.com serves github.com; a GHE instance serves both from one host.
  return api.hostname === 'api.github.com' ? new URL('https://github.com') : new URL(api.origin)
}

/**
 * Whether `url` is on a host images may come from. The forge's own origin is
 * matched by `URL.host`, so a Forgejo or GHE instance on its own port keeps
 * working; every other allowed host must be on the default HTTPS port, since an
 * allowed hostname on another port is a different service (fail closed).
 */
function hostAllowed(ref: PullRequestRef, url: URL, extra: readonly string[]): boolean {
  const web = webOrigin(ref)
  if (url.host === web.host) return true
  // `URL` drops the default port, so an empty `port` is exactly https's 443.
  if (url.port !== '') return false
  const host = url.hostname
  if (extra.includes(host)) return true
  // GitHub serves raw files, attachments and camo proxies from these.
  return (
    web.hostname === 'github.com' &&
    (host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com'))
  )
}

const COMMIT = /^[0-9a-f]{7,40}$/

/**
 * A GitHub link to a file of this repository at a commit, as the contents API
 * path. Branch names can contain `/`, so only an unambiguous commit qualifies.
 */
export function sameRepositoryContentsPath(ref: PullRequestRef, url: URL): string | null {
  if (ref.forge !== 'github') return null
  const web = webOrigin(ref).host
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  let rest: string[] | null = null
  if (url.host === web && (parts[2] === 'raw' || parts[2] === 'blob')) {
    rest = [parts[0] ?? '', parts[1] ?? '', ...parts.slice(3)]
  } else if (url.host === 'raw.githubusercontent.com') {
    rest = parts
  }
  if (rest === null) return null
  const [owner, repo, commit, ...path] = rest
  if (
    owner?.toLowerCase() !== ref.owner.toLowerCase() ||
    repo?.toLowerCase() !== ref.repo.toLowerCase() ||
    commit === undefined ||
    !COMMIT.test(commit) ||
    path.length === 0
  ) {
    return null
  }
  const base = ref.apiBase.replace(/\/+$/, '')
  const encoded = path.map(encodeURIComponent).join('/')
  return `${base}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/${encoded}?ref=${commit}`
}

/** Drop a response body the caller will not read, so its connection is released. */
async function discard(response: Awaited<ReturnType<BinaryFetchLike>>): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * The body, read chunk by chunk and cancelled as soon as it passes
 * `MAX_IMAGE_BYTES`. A missing or understated Content-Length therefore costs
 * at most one chunk past the cap, not the whole body.
 */
async function readCapped(
  response: Awaited<ReturnType<BinaryFetchLike>>,
  url: string,
): Promise<Uint8Array> {
  const tooLarge = (): Error => new Error(`${url} is larger than ${String(MAX_IMAGE_BYTES)} bytes`)
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_IMAGE_BYTES) {
    await discard(response)
    throw tooLarge()
  }
  if (response.body === null) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function createRemoteImageFetcher(
  ref: PullRequestRef,
  options: RemoteImageOptions = {},
): RemoteImageFetcher {
  const fetchImpl: BinaryFetchLike = options.fetch ?? fetch
  const extra = options.extraHosts ?? []
  return async (url, outer) => {
    const signal = AbortSignal.any([outer, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
    let current = new URL(url)
    const contents = sameRepositoryContentsPath(ref, current)
    if (contents !== null) {
      const response = await fetchImpl(contents, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(ref.token === undefined ? {} : { Authorization: `Bearer ${ref.token}` }),
        },
        redirect: 'manual',
        signal,
      })
      if (response.status === 200) return readCapped(response, url)
      // A 404 at a commit this token cannot see falls back to the public URL.
      await discard(response)
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Re-checked on every hop: a redirect to another port is refused like one to another host.
      if (current.protocol !== 'https:' || !hostAllowed(ref, current, extra)) {
        throw new Error(
          current.port === ''
            ? `${current.host} is not an allowed image host; pass --image-host ${current.hostname} to allow it`
            : `${current.host} is not an allowed image host; images are fetched only from the default HTTPS port`,
        )
      }
      // Forgejo serves attachments from its own origin, which the token belongs to.
      const sameForgejo =
        ref.forge === 'forgejo' &&
        ref.token !== undefined &&
        current.origin === webOrigin(ref).origin
      const response = await fetchImpl(current.href, {
        method: 'GET',
        headers: {
          Accept: 'image/*',
          ...(sameForgejo ? { Authorization: `token ${ref.token ?? ''}` } : {}),
        },
        redirect: 'manual',
        signal,
      })
      if (response.status >= 300 && response.status < 400) {
        await discard(response)
        const location = response.headers.get('location')
        if (location === null) throw new Error(`${current.href} redirected without a location`)
        current = new URL(location, current)
        continue
      }
      if (response.status !== 200) {
        await discard(response)
        throw new Error(`${current.href} returned ${String(response.status)}`)
      }
      return readCapped(response, url)
    }
    throw new Error(`${url} redirected more than ${String(MAX_REDIRECTS)} times`)
  }
}
