import { z } from 'zod'
import type { GitHubBackendKind, PrActionResult } from '@shared/types/git.ts'
import type { PrRef } from './backend.ts'

/**
 * Review-thread writes shared by the CLI and token backends. Each backend
 * supplies only how a GraphQL request is sent; the queries, the ownership
 * check and the result wording live here so both paths behave the same.
 */

/** Sends one GraphQL request; `errorMessage` is set when it failed. */
export type ReviewThreadGraphql = (
  query: string,
  variables: Record<string, string>,
) => Promise<{ data: unknown; errorMessage?: string | undefined }>

/** GitHub caps a comment body at 65,536 characters. */
export const REVIEW_REPLY_MAX_LENGTH = 65_536

const THREAD_OWNER_QUERY = `query($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread {
      isResolved
      pullRequest { number repository { nameWithOwner } }
    }
  }
}`

const REPLY_MUTATION = `mutation($id: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) {
    comment { id }
  }
}`

const RESOLVE_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`

const UNRESOLVE_MUTATION = `mutation($id: ID!) {
  unresolveReviewThread(input: { threadId: $id }) { thread { isResolved } }
}`

const threadOwnerSchema = z.object({
  node: z
    .object({
      __typename: z.literal('PullRequestReviewThread'),
      isResolved: z.boolean(),
      pullRequest: z.object({
        number: z.number().int(),
        repository: z.object({ nameWithOwner: z.string() }),
      }),
    })
    .nullable(),
})

const replySchema = z.object({
  addPullRequestReviewThreadReply: z.object({
    comment: z.object({ id: z.string() }),
  }),
})

const resolveSchema = z.object({
  resolveReviewThread: z.object({ thread: z.object({ isResolved: z.boolean() }) }),
})
const unresolveSchema = z.object({
  unresolveReviewThread: z.object({ thread: z.object({ isResolved: z.boolean() }) }),
})

/**
 * The renderer names the thread, so confirm it is a review thread on this
 * very PR before writing: a thread id from another repository must not be
 * replied to or resolved under this PR's action.
 */
async function threadOnPr(
  run: ReviewThreadGraphql,
  ref: PrRef,
  threadId: string,
): Promise<{ isResolved: boolean } | { error: string }> {
  const reply = await run(THREAD_OWNER_QUERY, { id: threadId })
  if (reply.errorMessage) return { error: reply.errorMessage }
  const parsed = threadOwnerSchema.safeParse(reply.data)
  const node = parsed.success ? parsed.data.node : null
  if (
    !node ||
    node.pullRequest.number !== ref.number ||
    node.pullRequest.repository.nameWithOwner.toLowerCase() !==
      `${ref.owner}/${ref.repo}`.toLowerCase()
  )
    return { error: `That review thread is not on PR #${String(ref.number)}.` }
  return { isResolved: node.isResolved }
}

export async function replyToReviewThread(
  run: ReviewThreadGraphql,
  backend: GitHubBackendKind,
  ref: PrRef,
  threadId: string,
  body: string,
): Promise<PrActionResult> {
  if (!body.trim()) return { ok: false, backend, message: 'Write a reply first.' }
  const owner = await threadOnPr(run, ref, threadId)
  if ('error' in owner) return { ok: false, backend, message: owner.error }
  // Not retried: after an uncertain response a second attempt could post twice.
  const reply = await run(REPLY_MUTATION, { id: threadId, body })
  if (reply.errorMessage) return { ok: false, backend, message: reply.errorMessage }
  const parsed = replySchema.safeParse(reply.data)
  if (!parsed.success)
    return {
      ok: false,
      backend,
      message: 'GitHub did not confirm the reply. Refresh to check before posting again.',
    }
  return { ok: true, backend, message: 'Reply posted.' }
}

export async function setReviewThreadResolved(
  run: ReviewThreadGraphql,
  backend: GitHubBackendKind,
  ref: PrRef,
  threadId: string,
  resolved: boolean,
): Promise<PrActionResult> {
  const owner = await threadOnPr(run, ref, threadId)
  if ('error' in owner) return { ok: false, backend, message: owner.error }
  const done = resolved ? 'Thread resolved.' : 'Thread reopened.'
  if (owner.isResolved === resolved) return { ok: true, backend, noop: true, message: done }
  const reply = await run(resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { id: threadId })
  if (reply.errorMessage) return { ok: false, backend, message: reply.errorMessage }
  const state = resolved
    ? resolveSchema.safeParse(reply.data).data?.resolveReviewThread.thread.isResolved
    : unresolveSchema.safeParse(reply.data).data?.unresolveReviewThread.thread.isResolved
  if (state !== resolved)
    return { ok: false, backend, message: 'GitHub did not confirm the change. Refresh to check.' }
  return { ok: true, backend, message: done }
}
