import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { runGh } from './gh-service.ts'
import type { PrRef } from './backend/backend.ts'
import { chooseAutoMergeStrategy } from './backend/merge-strategy.ts'

const repoSchema = z.object({
  allow_squash_merge: z.boolean(),
  allow_merge_commit: z.boolean(),
  allow_rebase_merge: z.boolean(),
})
// `gh pr view --json latestReviews` leaves each review's commit oid empty, so
// readiness is read over GraphQL, which reports the commit each review covers.
const prReadinessSchema = z.object({
  isDraft: z.boolean(),
  headRefOid: z.string(),
  reviewDecision: z.string().nullable(),
  latestReviews: z.object({
    nodes: z.array(
      z.object({ state: z.string(), commit: z.object({ oid: z.string() }).nullable() }),
    ),
  }),
})
const prReadinessReplySchema = z.object({
  data: z.object({
    repository: z.object({ pullRequest: prReadinessSchema.nullable() }),
  }),
})

/**
 * Why a merge must not be requested, or null when it may be. Green checks are
 * not enough for an unattended merge: it needs a non-draft PR still at the
 * observed head, with an approving review of that exact commit and no
 * outstanding change request.
 */
function mergeRefusal(
  pr: z.infer<typeof prReadinessSchema>,
  expectedHeadSha: string,
): string | null {
  if (pr.isDraft) return 'the pull request is a draft.'
  if (pr.headRefOid.toLowerCase() !== expectedHeadSha.toLowerCase())
    return `the head is now ${pr.headRefOid.slice(0, 9)}, not ${expectedHeadSha.slice(0, 9)}. Re-review the new head.`
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'a reviewer has requested changes.'
  const approvedHead = pr.latestReviews.nodes.some(
    (review) =>
      review.state === 'APPROVED' &&
      review.commit?.oid.toLowerCase() === expectedHeadSha.toLowerCase(),
  )
  if (!approvedHead) return 'no approving review covers the current head commit.'
  return null
}

const reviewThreadSchema = z.object({
  data: z.object({
    node: z.object({
      __typename: z.literal('PullRequestReviewThread'),
      isResolved: z.boolean(),
      pullRequest: z.object({
        number: z.number().int().positive(),
        repository: z.object({ nameWithOwner: z.string() }),
      }),
    }),
  }),
})

const resolutionSchema = z.object({
  data: z.object({
    resolveReviewThread: z.object({ thread: z.object({ isResolved: z.literal(true) }) }),
  }),
})

type GhReply = Awaited<ReturnType<typeof runGh>>

export interface PrMaintenanceService {
  merge(ref: PrRef, expectedHeadSha: string): Promise<string>
  comment(ref: PrRef, body: string): Promise<string>
  resolveReviewThread(ref: PrRef, threadId: string): Promise<string>
}

/** Narrow CLI operations; injected command boundary keeps tests off the network. */
export function createPrMaintenanceService(run: typeof runGh = runGh): PrMaintenanceService {
  const target = (ref: PrRef): string[] => ['-R', `${ref.owner}/${ref.repo}`, String(ref.number)]
  const result = (reply: GhReply, success: string): string =>
    reply.code === 0 ? success : `Failed: ${reply.stderr.trim() || 'GitHub CLI operation failed.'}`
  return {
    async merge(ref: PrRef, expectedHeadSha: string): Promise<string> {
      if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha)) return 'Failed: expected a full head SHA.'
      const view = await run([
        'api',
        'graphql',
        '-f',
        'query=query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { isDraft headRefOid reviewDecision latestReviews(first: 100) { nodes { state commit { oid } } } } } }',
        '-f',
        `owner=${ref.owner}`,
        '-f',
        `repo=${ref.repo}`,
        '-F',
        `number=${String(ref.number)}`,
      ])
      if (view.code !== 0) return result(view, '')
      const pr = safeJsonParse(view.stdout, decodeWithSchema(prReadinessReplySchema))?.data
        .repository.pullRequest
      if (!pr) return 'Failed: could not read pull request review state.'
      const refusal = mergeRefusal(pr, expectedHeadSha)
      if (refusal) return `Failed: not merging PR #${String(ref.number)}: ${refusal}`
      const response = await run(['api', `repos/${ref.owner}/${ref.repo}`])
      if (response.code !== 0) return result(response, '')
      const repo = safeJsonParse(response.stdout, decodeWithSchema(repoSchema))
      if (!repo) return 'Failed: could not read repository merge policy.'
      const strategy = chooseAutoMergeStrategy({
        squash: repo.allow_squash_merge,
        merge: repo.allow_merge_commit,
        rebase: repo.allow_rebase_merge,
      })
      if (!strategy) return 'Failed: no repository merge method is enabled.'
      return result(
        await run([
          'pr',
          'merge',
          ...target(ref),
          `--${strategy}`,
          '--match-head-commit',
          expectedHeadSha,
        ]),
        `Merge requested for PR #${String(ref.number)} at ${expectedHeadSha}; re-read PR state to confirm merge or queue status.`,
      )
    },
    async comment(ref: PrRef, body: string): Promise<string> {
      return result(
        await run(['pr', 'comment', ...target(ref), '--body', body]),
        `Comment posted on PR #${String(ref.number)}.`,
      )
    },
    async resolveReviewThread(ref: PrRef, threadId: string): Promise<string> {
      const response = await run([
        'api',
        'graphql',
        '-f',
        'query=query($id: ID!) { node(id: $id) { __typename ... on PullRequestReviewThread { isResolved pullRequest { number repository { nameWithOwner } } } } }',
        '-f',
        `id=${threadId}`,
      ])
      if (response.code !== 0) return result(response, '')
      const parsed = safeJsonParse(response.stdout, decodeWithSchema(reviewThreadSchema))
      const thread = parsed?.data.node
      if (
        !thread ||
        thread.pullRequest.number !== ref.number ||
        thread.pullRequest.repository.nameWithOwner.toLowerCase() !==
          `${ref.owner}/${ref.repo}`.toLowerCase()
      ) {
        return 'Failed: review thread does not belong to the requested repository and PR.'
      }
      if (thread.isResolved) return 'Review thread is already resolved.'
      const mutation = await run([
        'api',
        'graphql',
        '-f',
        'query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }',
        '-f',
        `id=${threadId}`,
      ])
      if (mutation.code !== 0) return result(mutation, '')
      return safeJsonParse(mutation.stdout, decodeWithSchema(resolutionSchema))
        ? `Resolved review thread on PR #${String(ref.number)}.`
        : 'Failed: GitHub did not confirm review-thread resolution.'
    },
  }
}
