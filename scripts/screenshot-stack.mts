// Trusted Actions entry: no dependencies, checkout execution, or candidate imports.
import { createHash } from 'node:crypto'
import { safeJsonParse } from './lib/safe-json.mts'

class StackValidationError extends Error {}

const PREFIX = '<!-- copse-screenshot-stack:'
const BOT = 41898282
const SHA = /^[0-9a-f]{40}$/
export const STACK_COVERAGE = 'Screenshot stack coverage'
export const STACK_DECISION = 'Screenshot stack decision'

interface Member {
  number: number
  sha: string
}
interface Declaration {
  members: Member[]
  tip: number
  text: string
  digest: string
}

export interface StackGitHub {
  rest: {
    pulls: {
      get(input: { owner: string; repo: string; pull_number: number }): Promise<{ data: unknown }>
    }
    repos: {
      compareCommitsWithBasehead(input: {
        owner: string
        repo: string
        basehead: string
      }): Promise<{ data: unknown }>
      getCombinedStatusForRef?(input: {
        owner: string
        repo: string
        ref: string
        per_page: number
        page: number
      }): Promise<{ data: unknown }>
      listCommitStatusesForRef(input: {
        owner: string
        repo: string
        ref: string
        per_page: number
        page: number
      }): Promise<{ data: unknown }>
      createCommitStatus(input: {
        owner: string
        repo: string
        sha: string
        context: string
        state: 'pending' | 'success' | 'error'
        description: string
        target_url?: string
      }): Promise<unknown>
    }
  }
}

/** Share only immutable SHA comparisons within one reconciliation run. */
export function memoizeScreenshotStackAncestry(github: StackGitHub): StackGitHub {
  const comparisons = new Map<string, Promise<{ data: unknown }>>()
  return {
    rest: {
      pulls: github.rest.pulls,
      repos: {
        ...github.rest.repos,
        compareCommitsWithBasehead(input): Promise<{ data: unknown }> {
          const key = JSON.stringify([input.owner, input.repo, input.basehead])
          let result = comparisons.get(key)
          if (!result) {
            result = github.rest.repos.compareCommitsWithBasehead(input)
            comparisons.set(key, result)
          }
          return result
        },
      },
    },
  }
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key)
    ? Reflect.get(value, key)
    : undefined
}

export function parseScreenshotStack(body: unknown): Declaration | null {
  if (typeof body !== 'string' || !body.includes(PREFIX)) return null
  const matches = [...body.matchAll(/<!-- copse-screenshot-stack: ([^\n]+) -->/g)]
  const payload = matches[0]?.[1]
  if (matches.length !== 1 || body.split(PREFIX).length !== 2 || !payload) {
    throw new StackValidationError('Expected exactly one screenshot stack declaration')
  }
  const tokens = payload.split(' ')
  const tipToken = tokens.pop()
  const tipMatch = /^tip=#([1-9][0-9]*)$/.exec(tipToken ?? '')
  const tip = Number(tipMatch?.[1])
  if (!Number.isSafeInteger(tip) || tip <= 0 || tokens.length < 1 || tokens.length > 19) {
    throw new StackValidationError('A screenshot stack needs 1–19 pinned lower PRs and one tip')
  }
  const seen = new Set([tip])
  const members = tokens.map((token) => {
    const match = /^#([1-9][0-9]*)@([0-9a-f]{40})$/.exec(token)
    const number = Number(match?.[1])
    const sha = match?.[2]
    if (!Number.isSafeInteger(number) || number <= 0 || !sha || seen.has(number)) {
      throw new StackValidationError(
        'Screenshot stack members must be unique PRs pinned to full SHAs',
      )
    }
    seen.add(number)
    return { number, sha }
  })
  const text = `${PREFIX} ${payload} -->`
  return { members, tip, text, digest: createHash('sha256').update(text).digest('hex') }
}

interface Input {
  owner: string
  repo: string
  number: number
}

async function statuses(
  github: StackGitHub,
  input: Input,
  ref: string,
): Promise<Map<string, unknown>> {
  const latest = new Map<string, unknown>()
  for (let page = 1; page <= 20; page += 1) {
    // The combined endpoint returns the latest status for each context, rather
    // than walking every historical deferral written on an unchanged SHA.
    // Keep live reads uncached so revoked decisions are observed immediately.
    const combined = github.rest.repos.getCombinedStatusForRef?.bind(github.rest.repos)
    const { data: response } = await (
      combined
        ? combined.bind(github.rest.repos)
        : github.rest.repos.listCommitStatusesForRef.bind(github.rest.repos)
    )({
      owner: input.owner,
      repo: input.repo,
      ref,
      per_page: 100,
      page,
    })
    const data = combined ? field(response, 'statuses') : response
    if (!Array.isArray(data))
      throw new StackValidationError('Screenshot stack statuses unavailable')
    for (const status of data) {
      const context = field(status, 'context')
      const id = field(status, 'id')
      if (typeof context !== 'string' || typeof id !== 'number' || !Number.isSafeInteger(id)) {
        throw new StackValidationError('Invalid screenshot stack status')
      }
      const previous = field(latest.get(context), 'id')
      if (typeof previous !== 'number' || id > previous) latest.set(context, status)
    }
    if (data.length < 100) {
      if (combined) await hydrateStatusCreators(github, input, ref, latest)
      return latest
    }
  }
  throw new StackValidationError('Screenshot stack status pagination limit exceeded')
}

/** status-simple omits creator; authenticate only the current screenshot proof. */
async function hydrateStatusCreators(
  github: StackGitHub,
  input: Input,
  ref: string,
  latest: Map<string, unknown>,
): Promise<void> {
  const contexts = new Set(['Screenshot review', STACK_COVERAGE, STACK_DECISION])
  const pending = new Set<string>()
  for (const context of contexts) {
    const status = latest.get(context)
    if (status && typeof field(field(status, 'creator'), 'id') !== 'number') {
      pending.add(context)
    }
  }
  if (pending.size === 0) return
  for (let page = 1; page <= 20; page += 1) {
    const { data } = await github.rest.repos.listCommitStatusesForRef({
      owner: input.owner,
      repo: input.repo,
      ref,
      per_page: 100,
      page,
    })
    if (!Array.isArray(data))
      throw new StackValidationError('Screenshot stack statuses unavailable')
    for (const status of data) {
      const context = field(status, 'context')
      const id = field(status, 'id')
      if (typeof context !== 'string' || typeof id !== 'number' || !Number.isSafeInteger(id)) {
        throw new StackValidationError('Invalid screenshot stack status')
      }
      if (!contexts.has(context)) continue
      const previous = field(latest.get(context), 'id')
      // Equal IDs hydrate the compact record. A newer record must win too,
      // including a revocation published between the two API reads.
      if (typeof previous !== 'number' || id >= previous) {
        latest.set(context, status)
        pending.delete(context)
      }
    }
    if (pending.size === 0) return
    if (data.length < 100) break
  }
  throw new StackValidationError('Screenshot stack status creators unavailable')
}

function successful(status: unknown): boolean {
  return field(status, 'state') === 'success' && field(field(status, 'creator'), 'id') === BOT
}

function sourceHead(pr: unknown, input: Input): string {
  const head = field(pr, 'head')
  const sha = field(head, 'sha')
  if (
    field(field(head, 'repo'), 'full_name') !== `${input.owner}/${input.repo}` ||
    typeof sha !== 'string' ||
    !SHA.test(sha)
  )
    throw new StackValidationError('Stack PR must have a same-repository head')
  return sha
}

// Validate from live API data each time, including at queue admission. A status
// alone cannot authorize a changed declaration or lower head.
export async function verifyScreenshotStack(
  github: StackGitHub,
  input: Input,
): Promise<{
  declaration: Declaration
  head: string
  tipHead: string
  lower: boolean
  approved: boolean
} | null> {
  const get = async (number: number): Promise<unknown> =>
    (await github.rest.pulls.get({ owner: input.owner, repo: input.repo, pull_number: number }))
      .data
  const current = await get(input.number)
  const declaration = parseScreenshotStack(field(current, 'body'))
  if (!declaration) return null
  const head = sourceHead(current, input)
  const lower = input.number !== declaration.tip
  if (
    lower &&
    !declaration.members.some((member) => member.number === input.number && member.sha === head)
  ) {
    throw new StackValidationError(
      `PR #${String(input.number)} head moved; update its stack pin and rerun tip CI`,
    )
  }
  const tip = lower ? await get(declaration.tip) : current
  const tipHead = sourceHead(tip, input)
  if (
    field(tip, 'state') !== 'open' ||
    field(tip, 'draft') !== false ||
    parseScreenshotStack(field(tip, 'body'))?.text !== declaration.text
  ) {
    throw new StackValidationError(
      'Screenshot stack tip must be open, ready, and declare the same stack',
    )
  }
  let previous: string | undefined
  for (const member of declaration.members) {
    const pr = member.number === input.number ? current : await get(member.number)
    if (
      sourceHead(pr, input) !== member.sha ||
      (field(pr, 'state') !== 'open' && field(pr, 'merged') !== true) ||
      parseScreenshotStack(field(pr, 'body'))?.text !== declaration.text
    ) {
      throw new StackValidationError(
        `PR #${String(member.number)} head or declaration changed; update stack pins and rerun tip CI`,
      )
    }
    if (previous) await ancestor(previous, member.sha)
    await ancestor(member.sha, tipHead)
    previous = member.sha
  }
  async function ancestor(base: string, headSha: string): Promise<void> {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      owner: input.owner,
      repo: input.repo,
      basehead: `${base}...${headSha}`,
    })
    if (
      (field(data, 'status') !== 'ahead' && field(data, 'status') !== 'identical') ||
      field(field(data, 'merge_base_commit'), 'sha') !== base
    ) {
      throw new StackValidationError(
        'Screenshot stack revisions are not an ordered ancestor chain of the tip',
      )
    }
  }
  const latest = await statuses(github, input, tipHead)
  const coverage = latest.get(STACK_COVERAGE)
  const decision = latest.get(STACK_DECISION)
  const review = latest.get('Screenshot review')
  const reviewDescription = field(review, 'description')
  const approved =
    successful(review) &&
    typeof reviewDescription === 'string' &&
    /^(?:Accepted|Declined) by @/.test(reviewDescription) &&
    successful(decision) &&
    field(decision, 'description') === `Stack decision ${declaration.digest}` &&
    successful(coverage) &&
    field(coverage, 'description') === `Stack coverage ${declaration.digest}`
  // Re-read every member after comparisons/status reads to reject racing pushes.
  for (const member of [...declaration.members, { number: declaration.tip, sha: tipHead }]) {
    const live = await get(member.number)
    if (
      sourceHead(live, input) !== member.sha ||
      parseScreenshotStack(field(live, 'body'))?.text !== declaration.text ||
      (member.number === declaration.tip &&
        (field(live, 'state') !== 'open' || field(live, 'draft') !== false))
    ) {
      throw new StackValidationError('Screenshot stack changed during validation')
    }
  }
  return { declaration, head, tipHead, lower, approved }
}

// Called only by the successful CI publisher, using a bounded artifact generated
// from the source event before CI. A later body edit cannot claim older coverage.
export async function attestScreenshotStack(
  github: StackGitHub,
  input: Input,
  expectedHead: string,
  manifestText: string,
): Promise<{ base: string; needsReview: boolean }> {
  const manifest = safeJsonParse(manifestText, (value) => {
    const declaration = field(value, 'declaration')
    const head = field(value, 'head')
    const base = field(value, 'base')
    const number = field(value, 'number')
    return typeof declaration === 'string' &&
      typeof head === 'string' &&
      SHA.test(head) &&
      typeof base === 'string' &&
      SHA.test(base) &&
      number === input.number
      ? { declaration, head, base }
      : null
  })
  if (manifestText.length > 4096 || !manifest || manifest.head !== expectedHead) {
    throw new StackValidationError('Invalid screenshot stack coverage manifest')
  }
  const stack = await verifyScreenshotStack(github, input)
  if (
    !stack ||
    stack.lower ||
    stack.head !== expectedHead ||
    stack.declaration.text !== manifest.declaration
  ) {
    throw new StackValidationError('Coverage manifest does not match the live screenshot stack tip')
  }
  await github.rest.repos.createCommitStatus({
    owner: input.owner,
    repo: input.repo,
    sha: expectedHead,
    context: STACK_COVERAGE,
    state: 'success',
    description: `Stack coverage ${stack.declaration.digest}`,
  })
  const latest = await statuses(github, input, expectedHead)
  const review = latest.get('Screenshot review')
  const decision = latest.get(STACK_DECISION)
  const description = field(review, 'description')
  const needsReview =
    !successful(review) ||
    typeof description !== 'string' ||
    !/^(?:Accepted|Declined) by @/.test(description) ||
    !successful(decision) ||
    field(decision, 'description') !== `Stack decision ${stack.declaration.digest}`
  if (needsReview)
    await github.rest.repos.createCommitStatus({
      owner: input.owner,
      repo: input.repo,
      sha: expectedHead,
      context: 'Screenshot review',
      state: 'pending',
      description: 'Combined stack needs explicit screenshot review',
    })
  return { base: manifest.base, needsReview }
}

interface ReconciledReview {
  head: string
  state: 'pending' | 'success' | 'error'
  description: string
}

export async function reconcileScreenshotStack(
  github: StackGitHub,
  input: Input,
): Promise<ReconciledReview | undefined> {
  const { data: pr } = await github.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
  })
  if (field(pr, 'state') !== 'open') return
  const head = sourceHead(pr, input)
  const latest = await statuses(github, input, head)
  const old = field(latest.get('Screenshot review'), 'description')
  let review: ReconciledReview | undefined
  // Removing a declaration must revoke a previous deferral on the same SHA.
  try {
    const declaration = parseScreenshotStack(field(pr, 'body'))
    if (!declaration) {
      if (typeof old !== 'string' || !old.startsWith('Stack ')) return
      await write('pending', 'Stack removed; rerun CI for individual screenshot review')
      return review
    }
    const stack = await verifyScreenshotStack(github, input)
    if (!stack) throw new StackValidationError('Screenshot stack disappeared')
    if (!stack.lower) {
      // A setup error may have been written while declarations were being edited.
      // Once valid, clear it without replacing an explicit visual decision.
      if (typeof old === 'string' && old.startsWith('Stack ')) {
        await write(
          'pending',
          'Stack ready; waiting for combined CI and explicit tip screenshot review',
        )
      }
      return review
    }
    await write(
      stack.approved ? 'success' : 'pending',
      stack.approved
        ? `Stack deferred to approved tip #${String(declaration.tip)} at ${stack.tipHead.slice(0, 12)}`
        : `Stack waiting for covered screenshot approval on tip #${String(declaration.tip)}`,
    )
  } catch (error) {
    const reason =
      error instanceof StackValidationError
        ? error.message
        : 'Validation unavailable; retry stack gates or check workflow logs'
    await write('error', `Stack blocked: ${reason}`.slice(0, 140))
  }
  return review
  async function write(state: 'pending' | 'success' | 'error', description: string): Promise<void> {
    review = { head, state, description }
    const current = latest.get('Screenshot review')
    if (
      field(field(current, 'creator'), 'id') === BOT &&
      field(current, 'state') === state &&
      field(current, 'description') === description
    )
      return
    await github.rest.repos.createCommitStatus({
      owner: input.owner,
      repo: input.repo,
      sha: head,
      context: 'Screenshot review',
      state,
      description,
      target_url: `https://github.com/${input.owner}/${input.repo}/pull/${String(input.number)}`,
    })
  }
}
