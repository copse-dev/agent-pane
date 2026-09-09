import { z } from 'zod'
import type { GhPrActivity, GhPrComment } from '@shared/types/git.ts'

// Same bounded query for CLI and token backends. Include legacy status contexts
// as well as check runs, and pin the results to the PR's latest commit.
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
    headSha: '',
    commentsTruncated: false,
    checksTruncated: false,
    error: 'Could not load comments and checks. Refresh to retry or open on GitHub.',
  }
}

export function parsePrActivity(data: unknown): GhPrActivity {
  const parsed = activitySchema.safeParse(data)
  if (!parsed.success) return unavailablePrActivity()
  const pr = parsed.data.repository.pullRequest
  const comments: GhPrComment[] = []
  for (const item of [...pr.comments.nodes, ...pr.reviews.nodes]) {
    if (!item || !item.createdAt || item.state === 'PENDING') continue
    const comment: GhPrComment = {
      id: item.id,
      body: item.body,
      author: item.author?.login ?? 'ghost',
      createdAt: item.createdAt,
      url: item.url,
    }
    if (item.state) comment.reviewState = item.state
    comments.push(comment)
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
    headSha: pr.headRefOid,
    commentsTruncated: pr.comments.pageInfo.hasPreviousPage || pr.reviews.pageInfo.hasPreviousPage,
    checksTruncated: contexts?.pageInfo.hasNextPage ?? false,
  }
}
