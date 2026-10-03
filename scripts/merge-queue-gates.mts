// Loaded from the event's trusted base SHA, never from queued candidate code.
// GitHub's PR-only legal and visual decisions must also gate the synthetic SHA.
// Initial policy admits one entry per build; unknown membership fails closed.

const CONTEXTS = ['CLA', 'Screenshot review'] as const
const ACTIONS_BOT_ID = 41898282
const SHA = /^[0-9a-f]{40}$/
const PAGE_LIMIT = 20

interface Input {
  owner: string
  repo: string
  baseRef: string
  baseSha: string
  headSha: string
}

interface StatusWrite {
  owner: string
  repo: string
  sha: string
  context: string
  state: 'pending' | 'success' | 'error'
  description: string
}

export interface QueueGateGitHub {
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>
  rest: {
    pulls: {
      get(input: { owner: string; repo: string; pull_number: number }): Promise<{ data: unknown }>
    }
    repos: {
      compareCommits(input: {
        owner: string
        repo: string
        base: string
        head: string
      }): Promise<{ data: unknown }>
      listCommitStatusesForRef(input: {
        owner: string
        repo: string
        ref: string
        per_page: number
        page: number
      }): Promise<{ data: unknown }>
      createCommitStatus(input: StatusWrite): Promise<unknown>
    }
  }
}

interface Entry {
  id: string
  position: number
  baseSha: string
  headSha: string
  pr: number
  prHead: string
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
  return Reflect.get(value, key)
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Missing API string')
  return value
}

function sha(value: unknown): string {
  const result = string(value)
  if (!SHA.test(result)) throw new Error('Invalid commit SHA')
  return result
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid API identifier or queue position')
  }
  return value
}

const QUEUE_QUERY = `query($owner:String!,$repo:String!,$branch:String!,$after:String){
  repository(owner:$owner,name:$repo){mergeQueue(branch:$branch){
    entries(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{
      id position baseCommit{oid}headCommit{oid}pullRequest{number headRefOid}
    }}
  }}
}`

async function member(github: QueueGateGitHub, input: Input): Promise<Entry> {
  const entries: Entry[] = []
  let after: string | null = null
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const result = await github.graphql(QUEUE_QUERY, {
      owner: input.owner,
      repo: input.repo,
      branch: input.baseRef.slice('refs/heads/'.length),
      after,
    })
    const connection = field(field(field(result, 'repository'), 'mergeQueue'), 'entries')
    const nodes = field(connection, 'nodes')
    if (!Array.isArray(nodes)) throw new Error('Queue membership unavailable')
    for (const node of nodes) {
      // Other not-yet-built entries legitimately have null commits. They cannot
      // match this event and must not be guessed from branch names or titles.
      if (field(field(node, 'headCommit'), 'oid') !== input.headSha) continue
      const pr = field(node, 'pullRequest')
      entries.push({
        id: string(field(node, 'id')),
        position: integer(field(node, 'position')),
        baseSha: sha(field(field(node, 'baseCommit'), 'oid')),
        headSha: sha(field(field(node, 'headCommit'), 'oid')),
        pr: integer(field(pr, 'number')),
        prHead: sha(field(pr, 'headRefOid')),
      })
    }
    const pageInfo = field(connection, 'pageInfo')
    const more = field(pageInfo, 'hasNextPage')
    if (typeof more !== 'boolean') throw new Error('Invalid queue pagination')
    if (!more) {
      const entry = entries[0]
      if (
        entries.length !== 1 ||
        !entry ||
        entry.position !== 1 ||
        entry.baseSha !== input.baseSha
      ) {
        throw new Error('Event does not identify exactly one first-position queue entry')
      }
      return entry
    }
    const cursor = string(field(pageInfo, 'endCursor'))
    if (cursor === after) throw new Error('Queue pagination did not advance')
    after = cursor
  }
  throw new Error('Queue pagination limit exceeded')
}

async function verifyHead(github: QueueGateGitHub, input: Input, entry: Entry): Promise<void> {
  const { data } = await github.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: entry.pr,
  })
  const base = field(data, 'base')
  if (
    field(data, 'state') !== 'open' ||
    field(data, 'draft') !== false ||
    field(base, 'ref') !== input.baseRef.slice('refs/heads/'.length) ||
    field(field(base, 'repo'), 'full_name') !== `${input.owner}/${input.repo}` ||
    field(field(data, 'head'), 'sha') !== entry.prHead ||
    field(field(field(data, 'head'), 'repo'), 'full_name') !== `${input.owner}/${input.repo}`
  ) {
    throw new Error('Queued pull request no longer matches its admitted head and base')
  }
}

async function verifyCommit(github: QueueGateGitHub, input: Input, entry: Entry): Promise<void> {
  const { data } = await github.rest.repos.compareCommits({
    owner: input.owner,
    repo: input.repo,
    base: entry.prHead,
    head: input.headSha,
  })
  // Bind the currently approved source head to the synthetic commit graph.
  // This uses server-calculated ancestry, never commit messages, branch names,
  // tree similarity or assumptions about the final squash merge method.
  const comparison = field(data, 'status')
  if (
    field(field(data, 'merge_base_commit'), 'sha') !== entry.prHead ||
    field(data, 'behind_by') !== 0 ||
    (comparison !== 'ahead' && comparison !== 'identical')
  ) {
    throw new Error('Synthetic commit does not contain exactly the current PR source head')
  }
}

async function verifyStatuses(github: QueueGateGitHub, input: Input, entry: Entry): Promise<void> {
  const latest = new Map<string, { id: number; state: unknown; author: unknown }>()
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const { data } = await github.rest.repos.listCommitStatusesForRef({
      owner: input.owner,
      repo: input.repo,
      ref: entry.prHead,
      per_page: 100,
      page,
    })
    if (!Array.isArray(data)) throw new Error('Commit statuses unavailable')
    for (const status of data) {
      const context = field(status, 'context')
      if (context !== 'CLA' && context !== 'Screenshot review') continue
      const id = integer(field(status, 'id'))
      if (id > (latest.get(context)?.id ?? 0)) {
        latest.set(context, {
          id,
          state: field(status, 'state'),
          author: field(field(status, 'creator'), 'id'),
        })
      }
    }
    if (data.length < 100) {
      for (const context of CONTEXTS) {
        const status = latest.get(context)
        if (status?.state !== 'success' || status.author !== ACTIONS_BOT_ID) {
          throw new Error(`Current PR head lacks a trusted successful ${context} decision`)
        }
      }
      return
    }
  }
  throw new Error('Status pagination limit exceeded')
}

export async function evaluateMergeQueueGates(
  github: QueueGateGitHub,
  input: Input,
): Promise<void> {
  sha(input.headSha)
  sha(input.baseSha)
  if (!input.baseRef.startsWith('refs/heads/') || input.baseRef.length <= 'refs/heads/'.length) {
    throw new Error('Invalid merge group base ref')
  }
  const write = async (state: StatusWrite['state'], description: string): Promise<void> => {
    for (const context of CONTEXTS) {
      await github.rest.repos.createCommitStatus({
        owner: input.owner,
        repo: input.repo,
        sha: input.headSha,
        context,
        state,
        description,
      })
    }
  }
  try {
    await write('pending', 'Validating current pull request decisions for merge queue')
    const entry = await member(github, input)
    await verifyHead(github, input, entry)
    await verifyCommit(github, input, entry)
    await verifyStatuses(github, input, entry)
    const current = await member(github, input)
    if (
      current.id !== entry.id ||
      current.pr !== entry.pr ||
      current.prHead !== entry.prHead ||
      current.headSha !== entry.headSha ||
      current.baseSha !== entry.baseSha
    ) {
      throw new Error('Queue membership changed during validation')
    }
    await verifyHead(github, input, entry)
    await verifyCommit(github, input, entry)
    await verifyStatuses(github, input, entry)
    await write(
      'success',
      `PR #${String(entry.pr)} current-head CLA and screenshot decisions verified`,
    )
  } catch (error) {
    await write('error', 'Merge queue decisions could not be verified; see workflow log')
    throw error
  }
}
