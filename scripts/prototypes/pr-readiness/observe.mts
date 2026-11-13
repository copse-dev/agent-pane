import { z } from 'zod'
import { type ReadinessReceipt, type ReadinessSnapshot, type ReadinessTarget } from './model.mts'

// One bounded, revision-bearing read; a second identical read confirms that
// neither the target nor the visible evidence changed while collecting it.
// RequirableByPullRequest.isRequired comes from GitHub, not a check-name guess.
export const READINESS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    pullRequest(number: $number) {
      number url state isDraft headRefOid baseRefOid mergeable mergeStateStatus reviewDecision
      potentialMergeCommit { oid statusCheckRollup { state } }
      latestReviews(first: 100) {
        pageInfo { hasNextPage }
        nodes { state commit { oid } }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes { id isResolved }
      }
      commits(last: 1) { nodes { commit { oid statusCheckRollup {
        state
        contexts(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            __typename
            ... on CheckRun {
              id databaseId name status conclusion detailsUrl
              isRequired(pullRequestNumber: $number)
              checkSuite {
                id commit { oid } app { id }
                workflowRun { runNumber workflow { id } }
              }
            }
            ... on StatusContext {
              id context state targetUrl createdAt commit { oid }
              isRequired(pullRequestNumber: $number)
            }
          }
        }
      } } } }
    }
  }
}`

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const commitSchema = z.object({ oid: sha })
const pageSchema = z.object({ hasNextPage: z.boolean() })
const checkSchema = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    id: z.string(),
    databaseId: z.number().int().positive().nullable(),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable(),
    isRequired: z.boolean(),
    checkSuite: z.object({
      id: z.string(),
      commit: commitSchema,
      app: z.object({ id: z.string() }).nullable(),
      workflowRun: z
        .object({
          runNumber: z.number().int().positive(),
          workflow: z.object({ id: z.string().min(1) }),
        })
        .nullable(),
    }),
  }),
  z.object({
    __typename: z.literal('StatusContext'),
    id: z.string(),
    context: z.string(),
    state: z.string(),
    targetUrl: z.string().nullable(),
    createdAt: z.iso.datetime(),
    commit: commitSchema.nullable(),
    isRequired: z.boolean(),
  }),
])
const replySchema = z.object({
  errors: z.array(z.unknown()).optional(),
  data: z.object({
    repository: z.object({
      nameWithOwner: z.string(),
      pullRequest: z.object({
        number: z.number().int().positive(),
        url: z.string(),
        state: z.string(),
        isDraft: z.boolean(),
        headRefOid: sha,
        baseRefOid: sha,
        mergeable: z.string(),
        mergeStateStatus: z.string(),
        reviewDecision: z.string().nullable(),
        potentialMergeCommit: z
          .object({ oid: sha, statusCheckRollup: z.object({ state: z.string() }).nullable() })
          .nullable(),
        latestReviews: z.object({
          pageInfo: pageSchema,
          nodes: z.array(z.object({ state: z.string(), commit: commitSchema.nullable() })),
        }),
        reviewThreads: z.object({
          pageInfo: pageSchema,
          nodes: z.array(z.object({ id: z.string(), isResolved: z.boolean() })),
        }),
        commits: z.object({
          nodes: z
            .array(
              z.object({
                commit: z.object({
                  oid: sha,
                  statusCheckRollup: z
                    .object({
                      state: z.string(),
                      contexts: z.object({ pageInfo: pageSchema, nodes: z.array(checkSchema) }),
                    })
                    .nullable(),
                }),
              }),
            )
            .max(1),
        }),
      }),
    }),
  }),
})
type Reply = z.infer<typeof replySchema>
type Outcome = ReadinessReceipt['outcome']

export interface PrObservationRequest {
  repository: string
  number: number
}
export type ReadPrEvidence = (request: PrObservationRequest) => Promise<unknown>

function parseReply(raw: unknown, request: PrObservationRequest): Reply {
  const reply = replySchema.parse(raw)
  if (reply.errors?.length) throw new Error('GitHub returned partial GraphQL errors.')
  if (
    reply.data.repository.nameWithOwner.toLowerCase() !== request.repository.toLowerCase() ||
    reply.data.repository.pullRequest.number !== request.number
  )
    throw new Error('GitHub returned evidence for a different repository or PR.')
  return reply
}

function targetFromReply(reply: Reply): ReadinessTarget {
  const { repository } = reply.data
  return {
    repository: repository.nameWithOwner,
    number: repository.pullRequest.number,
    headSha: repository.pullRequest.headRefOid,
    baseSha: repository.pullRequest.baseRefOid,
  }
}

function checkOutcome(status: string, conclusion: string | null): Outcome {
  if (['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED'].includes(status))
    return 'pending'
  if (status !== 'COMPLETED') return 'unknown'
  if (conclusion === 'SUCCESS') return 'passed'
  if (
    ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(
      conclusion ?? '',
    )
  )
    return 'failed'
  if (conclusion === 'SKIPPED' || conclusion === 'NEUTRAL') return 'skipped'
  return 'unknown'
}

/** Read-only prototype. No cache, inferred historical passes, retries or writes.
 * Local/visual/runtime acceptance remains explicitly unknown in this adapter.
 */
export async function observePrReadiness(
  request: PrObservationRequest,
  read: ReadPrEvidence,
  now: () => number = Date.now,
): Promise<ReadinessSnapshot> {
  const observedAt = now()
  const first = parseReply(await read(request), request)
  const target = targetFromReply(first)
  const pr = first.data.repository.pullRequest
  const snapshot: ReadinessSnapshot = {
    target,
    confirmedTarget: null,
    observedAt,
    complete: true,
    problems: [],
    requirements: [],
    receipts: [],
  }
  const add = (
    key: string,
    label: string,
    actor: ReadinessSnapshot['requirements'][number]['actor'],
    outcome: Outcome,
    detail: string,
  ): void => {
    snapshot.requirements.push({ key, label, actor })
    snapshot.receipts.push({
      requirement: key,
      target,
      checkedSha: target.headSha,
      source: 'github',
      generation: 0,
      sequence: 0,
      outcome,
      detail,
      url: pr.url,
    })
  }
  add(
    'open',
    'Open pull request',
    'user',
    pr.state === 'OPEN'
      ? 'passed'
      : pr.state === 'CLOSED' || pr.state === 'MERGED'
        ? 'failed'
        : 'unknown',
    pr.state,
  )
  add(
    'draft',
    'Ready for review',
    'user',
    pr.isDraft ? 'failed' : 'passed',
    pr.isDraft ? 'The PR is a draft.' : 'The PR is not a draft.',
  )
  add(
    'mergeable',
    'Conflict evaluation',
    'agent',
    pr.mergeable === 'MERGEABLE' ? 'passed' : pr.mergeable === 'CONFLICTING' ? 'failed' : 'unknown',
    pr.mergeable,
  )
  add(
    'rules',
    'GitHub merge-rule evaluation',
    'ci',
    pr.mergeStateStatus === 'CLEAN'
      ? 'passed'
      : ['BEHIND', 'DIRTY', 'DRAFT'].includes(pr.mergeStateStatus)
        ? 'failed'
        : 'unknown',
    `${pr.mergeStateStatus}; this prototype does not enumerate repository rules or missing required checks.`,
  )
  const reviews = pr.latestReviews.nodes
  const review: Outcome =
    pr.reviewDecision === 'CHANGES_REQUESTED' ||
    reviews.some((item) => item.state === 'CHANGES_REQUESTED')
      ? 'failed'
      : pr.reviewDecision === 'REVIEW_REQUIRED'
        ? 'pending'
        : pr.reviewDecision === null ||
            (pr.reviewDecision === 'APPROVED' &&
              reviews.some(
                (item) => item.state === 'APPROVED' && item.commit?.oid === target.headSha,
              ))
          ? 'passed'
          : 'unknown'
  add(
    'reviews',
    'Required review',
    'user',
    review,
    `${pr.reviewDecision ?? 'No required review reported'}; an APPROVED verdict needs a current-head approval.`,
  )
  add(
    'threads',
    'Review discussions',
    'user',
    pr.reviewThreads.nodes.some((item) => !item.isResolved) ? 'failed' : 'passed',
    'Unresolved discussions remain blockers, including outdated threads.',
  )

  const commit = pr.commits.nodes[0]?.commit
  const contexts = commit?.statusCheckRollup?.contexts
  if (!commit || commit.oid !== target.headSha)
    snapshot.problems.push('The check-rollup commit does not match the PR head.')
  if (
    pr.latestReviews.pageInfo.hasNextPage ||
    pr.reviewThreads.pageInfo.hasNextPage ||
    contexts?.pageInfo.hasNextPage
  )
    snapshot.problems.push(
      'GitHub evidence exceeds the 100-item page limit; coverage is incomplete.',
    )
  if (pr.potentialMergeCommit?.statusCheckRollup)
    snapshot.problems.push(
      'Checks exist on a test-merge commit. Their applicability is outside this head-only prototype.',
    )

  for (const check of contexts?.nodes ?? []) {
    if (!check.isRequired) continue
    const isRun = check.__typename === 'CheckRun'
    const name = isRun ? check.name : check.context
    const workflowRun = isRun ? check.checkSuite.workflowRun : null
    // Workflow identity survives new suites on the same head. Providers without
    // workflow metadata keep separate suites: a shared display name is not proof
    // that a later suite supersedes another one.
    const source = isRun
      ? JSON.stringify([
          'check',
          check.checkSuite.app?.id,
          workflowRun ? ['workflow', workflowRun.workflow.id] : ['suite', check.checkSuite.id],
          name,
        ])
      : JSON.stringify(['status', name])
    const key = `check:${source}`
    if (!snapshot.requirements.some((item) => item.key === key))
      snapshot.requirements.push({ key, label: name, actor: 'ci' })
    const checkedSha = isRun ? check.checkSuite.commit.oid : check.commit?.oid
    const sequence = isRun ? check.databaseId : Date.parse(check.createdAt)
    if (checkedSha === undefined || sequence === null || (isRun && check.checkSuite.app === null)) {
      snapshot.problems.push(`Check ${name} has incomplete identity.`)
      continue
    }
    if (checkedSha !== target.headSha)
      snapshot.problems.push(`Check ${name} reports a commit outside the requested head.`)
    const outcome: Outcome = isRun
      ? checkOutcome(check.status, check.conclusion)
      : check.state === 'SUCCESS'
        ? 'passed'
        : check.state === 'FAILURE' || check.state === 'ERROR'
          ? 'failed'
          : check.state === 'PENDING' || check.state === 'EXPECTED'
            ? 'pending'
            : 'unknown'
    snapshot.receipts.push({
      requirement: key,
      target,
      checkedSha,
      source,
      generation: workflowRun?.runNumber ?? 0,
      sequence,
      outcome,
      detail: isRun ? `${check.status}/${check.conclusion ?? 'unknown'}` : check.state,
      url: isRun ? check.detailsUrl : check.targetUrl,
    })
  }
  add(
    'acceptance',
    'Local checks, visual/runtime acceptance and explicit holds',
    'agent',
    'unknown',
    'This adapter has not collected these requirements or their evidence. CI alone cannot establish PR readiness.',
  )
  try {
    const confirmed = parseReply(await read(request), request)
    snapshot.confirmedTarget = targetFromReply(confirmed)
    if (JSON.stringify(first) !== JSON.stringify(confirmed))
      snapshot.problems.push(
        'PR state or evidence changed during collection. Refresh before deciding.',
      )
  } catch {
    snapshot.problems.push(
      'Could not confirm the PR state after collection. Refresh before deciding.',
    )
  }
  snapshot.complete = snapshot.problems.length === 0
  // Start time deliberately bounds the age of the earliest part of the read.
  return snapshot
}
