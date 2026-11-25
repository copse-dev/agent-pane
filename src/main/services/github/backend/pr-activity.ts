import { z } from 'zod'
import type { GhPrActivity, GhPrComment, GhPrReviewThread } from '@shared/types/git.ts'

// Same bounded query for CLI and token backends. Include legacy status contexts
// as well as check runs, and pin the results to the PR's latest commit. Review
// threads are the first 100 (GitHub returns them oldest first), each with its
// first 20 comments; truncation is reported rather than hidden.
export const PR_ACTIVITY_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      headRefOid
      comments(last: 50) {
        pageInfo { hasPreviousPage }
        nodes { id body author { login } createdAt url }
      }
      reviews(last: 50) {
        pageInfo { hasPreviousPage }
        nodes { id body author { login } createdAt: submittedAt url state }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id path line isResolved isOutdated
          comments(first: 20) {
            totalCount
            nodes { id body author { login } createdAt url }
          }
        }
      }
      commits(last: 1) {
        nodes { commit { statusCheckRollup { contexts(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            ... on CheckRun { name status conclusion detailsUrl }
            ... on StatusContext { context state targetUrl }
          }
        } } } }
      }
    }
  }
}`

const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.object({ login: z.string() }).nullable(),
  createdAt: z.string().nullable(),
  url: z.string(),
  state: z.string().optional(),
})
const commentsSchema = z.object({
  pageInfo: z.object({ hasPreviousPage: z.boolean() }),
  nodes: z.array(commentSchema.nullable()),
})
const reviewThreadsSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean() }),
  nodes: z.array(
    z
      .object({
        id: z.string(),
        path: z.string(),
        line: z.number().int().nullable(),
        isResolved: z.boolean(),
        isOutdated: z.boolean(),
        comments: z.object({
          totalCount: z.number().int(),
          nodes: z.array(commentSchema.nullable()),
        }),
      })
      .nullable(),
  ),
})
const checksSchema = z.object({
  pageInfo: z.object({ hasNextPage: z.boolean() }),
  nodes: z.array(
    z
      .union([
        z.object({
          name: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          detailsUrl: z.string().nullable(),
        }),
        z.object({ context: z.string(), state: z.string(), targetUrl: z.string().nullable() }),
      ])
      .nullable(),
  ),
})
const activitySchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      headRefOid: z.string(),
      comments: commentsSchema,
      reviews: commentsSchema,
      reviewThreads: reviewThreadsSchema,
      commits: z.object({
        nodes: z.array(
          z.object({
            commit: z.object({
              statusCheckRollup: z.object({ contexts: checksSchema }).nullable(),
            }),
          }),
        ),
      }),
    }),
  }),
})

export function unavailablePrActivity(): GhPrActivity {
  return {
    comments: [],
    checks: [],
    reviewThreads: [],
    reviewThreadsTruncated: false,
    headSha: '',
    commentsTruncated: false,
    checksTruncated: false,
    error: 'Could not load comments and checks. Refresh to retry or open on GitHub.',
  }
}

function toComment(item: z.infer<typeof commentSchema>, createdAt: string): GhPrComment {
  const comment: GhPrComment = {
    id: item.id,
    body: item.body,
    author: item.author?.login ?? 'ghost',
    createdAt,
    url: item.url,
  }
  if (item.state) comment.reviewState = item.state
  return comment
}

function parseReviewThreads(threads: z.infer<typeof reviewThreadsSchema>): GhPrReviewThread[] {
  return threads.nodes.flatMap((thread) => {
    if (!thread) return []
    const comments = thread.comments.nodes.flatMap((item) =>
      item?.createdAt ? [toComment(item, item.createdAt)] : [],
    )
    // A thread whose comments were all deleted has nothing to show or address.
    if (!comments.length) return []
    return [
      {
        id: thread.id,
        path: thread.path,
        line: thread.line,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        comments,
        commentsTruncated: thread.comments.totalCount > thread.comments.nodes.length,
      },
    ]
  })
}

export function parsePrActivity(data: unknown): GhPrActivity {
  const parsed = activitySchema.safeParse(data)
  if (!parsed.success) return unavailablePrActivity()
  const pr = parsed.data.repository.pullRequest
  const comments: GhPrComment[] = []
  for (const item of [...pr.comments.nodes, ...pr.reviews.nodes]) {
    if (!item || !item.createdAt || item.state === 'PENDING') continue
    comments.push(toComment(item, item.createdAt))
  }
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts
  return {
    comments,
    checks: (contexts?.nodes ?? []).flatMap((item) => {
      if (!item) return []
      if ('name' in item)
        return [
          {
            name: item.name,
            state: item.status === 'COMPLETED' ? (item.conclusion ?? 'UNKNOWN') : item.status,
            url: item.detailsUrl,
          },
        ]
      return [{ name: item.context, state: item.state, url: item.targetUrl }]
    }),
    reviewThreads: parseReviewThreads(pr.reviewThreads),
    reviewThreadsTruncated: pr.reviewThreads.pageInfo.hasNextPage,
    headSha: pr.headRefOid,
    commentsTruncated: pr.comments.pageInfo.hasPreviousPage || pr.reviews.pageInfo.hasPreviousPage,
    checksTruncated: contexts?.pageInfo.hasNextPage ?? false,
  }
}
