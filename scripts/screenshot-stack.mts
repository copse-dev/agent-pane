// Trusted Actions entry: no dependencies, checkout execution, or candidate imports.
import { createHash } from 'node:crypto'
import { safeJsonParse } from './lib/safe-json.mts'

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
    throw new Error('Expected exactly one screenshot stack declaration')
  }
  const tokens = payload.split(' ')
  const tipToken = tokens.pop()
  const tipMatch = /^tip=#([1-9][0-9]*)$/.exec(tipToken ?? '')
  const tip = Number(tipMatch?.[1])
  if (!Number.isSafeInteger(tip) || tip <= 0 || tokens.length < 1 || tokens.length > 19) {
    throw new Error('A screenshot stack needs 1–19 pinned lower PRs and one tip')
  }
  const seen = new Set([tip])
  const members = tokens.map((token) => {
    const match = /^#([1-9][0-9]*)@([0-9a-f]{40})$/.exec(token)
    const number = Number(match?.[1])
    const sha = match?.[2]
    if (!Number.isSafeInteger(number) || number <= 0 || !sha || seen.has(number)) {
      throw new Error('Screenshot stack members must be unique PRs pinned to full SHAs')
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
    const { data } = await github.rest.repos.listCommitStatusesForRef({
      owner: input.owner,
      repo: input.repo,
      ref,
      per_page: 100,
      page,
    })
    if (!Array.isArray(data)) throw new Error('Screenshot stack statuses unavailable')
    for (const status of data) {
      const context = field(status, 'context')
      const id = field(status, 'id')
      if (typeof context !== 'string' || typeof id !== 'number' || !Number.isSafeInteger(id)) {
        throw new Error('Invalid screenshot stack status')
      }
      const previous = field(latest.get(context), 'id')
      if (typeof previous !== 'number' || id > previous) latest.set(context, status)
    }
    if (data.length < 100) return latest
  }
  throw new Error('Screenshot stack status pagination limit exceeded')
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
    throw new Error('Stack PR must have a same-repository head')
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
    throw new Error('Current PR head is not pinned in its screenshot stack')
  }
  const tip = lower ? await get(declaration.tip) : current
  const tipHead = sourceHead(tip, input)
  if (
    field(tip, 'state') !== 'open' ||
    field(tip, 'draft') !== false ||
    parseScreenshotStack(field(tip, 'body'))?.text !== declaration.text
  ) {
    throw new Error('Screenshot stack tip must be open, ready, and declare the same stack')
  }
  let previous: string | undefined
  for (const member of declaration.members) {
    const pr = member.number === input.number ? current : await get(member.number)
    if (
      sourceHead(pr, input) !== member.sha ||
      (field(pr, 'state') !== 'open' && field(pr, 'merged') !== true) ||
      parseScreenshotStack(field(pr, 'body'))?.text !== declaration.text
    ) {
      throw new Error(
        `Screenshot stack PR #${String(member.number)} changed or is not in the declared stack`,
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
      throw new Error('Screenshot stack revisions are not an ordered ancestor chain of the tip')
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
      throw new Error('Screenshot stack changed during validation')
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
    throw new Error('Invalid screenshot stack coverage manifest')
  }
  const stack = await verifyScreenshotStack(github, input)
  if (
    !stack ||
    stack.lower ||
    stack.head !== expectedHead ||
    stack.declaration.text !== manifest.declaration
  ) {
    throw new Error('Coverage manifest does not match the live screenshot stack tip')
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

export async function reconcileScreenshotStack(github: StackGitHub, input: Input): Promise<void> {
  const { data: pr } = await github.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.number,
  })
  if (field(pr, 'state') !== 'open') return
  const head = sourceHead(pr, input)
  const latest = await statuses(github, input, head)
  const old = field(latest.get('Screenshot review'), 'description')
  // Removing a declaration must revoke a previous deferral on the same SHA.
  try {
    const declaration = parseScreenshotStack(field(pr, 'body'))
    if (!declaration) {
      if (typeof old !== 'string' || !old.startsWith('Stack ')) return
      await write('pending', 'Stack removed; rerun CI for individual screenshot review')
      return
    }
    const stack = await verifyScreenshotStack(github, input)
    if (!stack) throw new Error('Screenshot stack disappeared')
    if (!stack.lower) return // The tip retains its normal accept/decline review.
    await write(
      stack.approved ? 'success' : 'pending',
      stack.approved
        ? `Stack deferred to approved tip #${String(declaration.tip)} at ${stack.tipHead.slice(0, 12)}`
        : `Stack waiting for covered screenshot approval on tip #${String(declaration.tip)}`,
    )
  } catch {
    await write('error', 'Stack invalid or changed; update declarations and rerun tip CI')
  }
  async function write(state: 'pending' | 'success' | 'error', description: string): Promise<void> {
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
