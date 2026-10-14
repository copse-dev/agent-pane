/**
 * GitHub stacked pull requests: the Stacks REST API decoders and the paging
 * shared by the CLI and token backends. See docs/plans/stacked-pull-requests.md.
 *
 * Both backends read stacks over REST (`GET /repos/{o}/{r}/stacks`) rather than
 * the GraphQL `stack` field: an unknown GraphQL field fails the whole query, so
 * adding it to the details query would break details on any host without
 * stacks. A REST 404 instead says "stacks unavailable here" and nothing else.
 */
import { z } from 'zod'
import { safeJsonParse } from '@shared/safe-json.ts'
import type { GhPrStack, GhPrStackEntry, GhRepoStacks } from '@shared/types/git.ts'
import type { PrRef } from './backend.ts'

/** GitHub's maximum page size for the Stacks API. */
export const STACKS_PAGE_SIZE = 100
/**
 * Upper bound on pages read per repository. A stack holds at most 100 PRs, so
 * 1,000 stacks is far beyond any repository the panel lists; the bound keeps a
 * misbehaving response from looping.
 */
export const STACKS_MAX_PAGES = 10

const stackPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged_at: z.string().nullable().optional(),
  head: z.object({ ref: z.string() }),
})

const stackSchema = z.object({
  number: z.number().int().positive(),
  base: z.object({ ref: z.string() }),
  open: z.boolean().optional(),
  pull_requests: z.array(stackPullSchema),
})

type RestStack = z.infer<typeof stackSchema>

function toEntry(pull: RestStack['pull_requests'][number], index: number): GhPrStackEntry {
  const merged = typeof pull.merged_at === 'string' && pull.merged_at.length > 0
  return {
    number: pull.number,
    position: index + 1,
    // A merged PR is closed; any state GitHub adds later is treated as closed
    // too, so an unknown state can never make a PR look mergeable.
    state: pull.state.toLowerCase() === 'open' && !merged ? 'open' : 'closed',
    draft: pull.draft === true,
    merged,
    headRefName: pull.head.ref,
  }
}

function toStack(raw: RestStack): GhPrStack {
  const entries = raw.pull_requests.map(toEntry)
  return {
    number: raw.number,
    baseRefName: raw.base.ref,
    open: raw.open ?? entries.some((entry) => entry.state === 'open'),
    entries,
  }
}

/** Decode one stack resource; null when the payload does not match. */
export function parseStack(json: unknown): GhPrStack | null {
  const parsed = stackSchema.safeParse(json)
  return parsed.success ? toStack(parsed.data) : null
}

/** Decode a list of stack resources; null when the payload is not a stack array. */
export function parseStackList(json: unknown): GhPrStack[] | null {
  const parsed = z.array(stackSchema).safeParse(json)
  return parsed.success ? parsed.data.map(toStack) : null
}

/** The stack containing PR `number`, if any. */
export function stackContaining(stacks: GhPrStack[], number: number): GhPrStack | undefined {
  return stacks.find((stack) => stack.entries.some((entry) => entry.number === number))
}

/** `repos/{o}/{r}/stacks?...` without a leading slash; the API backend adds one. */
export function stacksPagePath(owner: string, repo: string, page: number): string {
  return `repos/${owner}/${repo}/stacks?per_page=${String(STACKS_PAGE_SIZE)}&page=${String(page)}`
}

export function stackForPrPath(ref: PrRef): string {
  return `repos/${ref.owner}/${ref.repo}/stacks?pull_request=${String(ref.number)}`
}

/** One REST read as the backends report it to the shared loaders below. */
export type StacksResponse =
  | { kind: 'ok'; json: unknown }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }

export type StacksFetcher = (path: string) => Promise<StacksResponse>

/**
 * Classify a finished `gh api` call. `gh` exits non-zero on any HTTP error and
 * names the status in stderr (`gh: Not Found (HTTP 404)`), which is the only
 * place a CLI caller can tell "stacks unavailable" from a real failure.
 */
export function stacksResponseFromGh(result: {
  stdout: string
  stderr: string
  code: number
  errorMessage: string
}): StacksResponse {
  if (result.code !== 0) {
    if (/\(HTTP 404\)/.test(result.stderr)) return { kind: 'not-found' }
    return { kind: 'error', message: result.errorMessage }
  }
  return { kind: 'ok', json: safeJsonParse(result.stdout.trim()) }
}

/**
 * Every stack in a repository, paging until a short page. 404 means stacks are
 * unavailable; any other failure throws so the caller never mistakes it for
 * "this repository has no stacks".
 */
export async function loadRepoStacks(
  fetchPath: StacksFetcher,
  owner: string,
  repo: string,
): Promise<GhRepoStacks> {
  const stacks: GhPrStack[] = []
  for (let page = 1; page <= STACKS_MAX_PAGES; page += 1) {
    const response = await fetchPath(stacksPagePath(owner, repo, page))
    if (response.kind === 'not-found') return { status: 'unavailable' }
    if (response.kind === 'error') throw new Error(response.message)
    const batch = parseStackList(response.json)
    if (!batch) throw new Error(`Unexpected response listing stacks for ${owner}/${repo}.`)
    stacks.push(...batch)
    if (batch.length < STACKS_PAGE_SIZE) break
  }
  return { status: 'enabled', stacks }
}

/**
 * The stack containing one PR, for the details view. Best-effort by design:
 * a 404, an error, or an unexpected payload all mean "no stack shown", because
 * a stack read must never fail or block the PR details load.
 */
export async function loadStackForPr(
  fetchPath: StacksFetcher,
  ref: PrRef,
): Promise<GhPrStack | undefined> {
  try {
    const response = await fetchPath(stackForPrPath(ref))
    if (response.kind !== 'ok') return undefined
    const stacks = parseStackList(response.json)
    return stacks ? stackContaining(stacks, ref.number) : undefined
  } catch {
    return undefined
  }
}
