/** Authorization and publication rules for comment-requested container edits. */
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'

const sha = z.string().regex(/^[a-f0-9]{40}$/)
const user = z.object({ id: z.number(), login: z.string(), type: z.string() })
export const commentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().max(65_536),
  user,
  updated_at: z.string(),
  issue_url: z.string(),
})
const repository = z.object({ id: z.number(), full_name: z.string(), default_branch: z.string() })
export const eventSchema = z.object({
  action: z.literal('created'),
  repository,
  sender: user,
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({ url: z.string() }),
  }),
  comment: commentSchema,
})
export const pullSchema = z.object({
  number: z.number(),
  state: z.literal('open'),
  user,
  head: z.object({ sha, ref: z.string(), repo: repository.nullable() }),
  base: z.object({ sha, ref: z.string(), repo: repository }),
  labels: z.array(z.object({ name: z.string() })),
})
export const requestSchema = z.object({
  pr: z.number().int().positive(),
  head: sha,
  base: sha,
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  commentId: z.number().int().positive(),
  commentUpdatedAt: z.string(),
  body: z.string(),
  instruction: z.string().min(1).max(8000),
  mode: z.enum(['fix', 'rebase']),
})
export type FollowUpRequest = z.infer<typeof requestSchema>
export const REPOSITORY = 'copse-dev/agent-pane'
export const REPOSITORY_ID = 1274237362
export const OWNER_ID = 338988
export const OWNER_LOGIN = 'jonathanKingston'

export function decode<T>(text: string, schema: z.ZodType<T>): T {
  const value = safeJsonParse(text, decodeWithSchema(schema))
  if (value === null) throw new Error('Invalid follow-up input')
  return value
}

export function command(body: string): { mode: 'fix' | 'rebase'; instruction: string } | null {
  const match = /^@copse-review[ \t]+(rebase|fix(?:[ \t]+[^\r\n]+))(?:\r?\n([\s\S]*))?$/i.exec(
    body.trim(),
  )
  if (!match?.[1]) return null
  const instruction = [match[1], match[2]].filter(Boolean).join('\n').trim()
  if (instruction.length > 8000) return null
  return { mode: match[1].toLowerCase() === 'rebase' ? 'rebase' : 'fix', instruction }
}

export function authorize(
  event: z.infer<typeof eventSchema>,
  pull: z.infer<typeof pullSchema>,
  comment: z.infer<typeof commentSchema>,
  triggeringActor: string,
): FollowUpRequest {
  const parsed = command(comment.body)
  if (
    !parsed ||
    event.repository.id !== REPOSITORY_ID ||
    event.repository.full_name !== REPOSITORY ||
    event.sender.id !== OWNER_ID ||
    event.sender.login !== OWNER_LOGIN ||
    event.sender.type !== 'User' ||
    triggeringActor !== OWNER_LOGIN ||
    comment.user.id !== OWNER_ID ||
    comment.user.login !== OWNER_LOGIN ||
    comment.user.type !== 'User' ||
    comment.id !== event.comment.id ||
    comment.body !== event.comment.body ||
    comment.updated_at !== event.comment.updated_at ||
    comment.issue_url !==
      `https://api.github.com/repos/${REPOSITORY}/issues/${String(event.issue.number)}` ||
    pull.number !== event.issue.number ||
    pull.user.id !== OWNER_ID ||
    pull.head.repo?.id !== REPOSITORY_ID ||
    pull.head.repo.full_name !== REPOSITORY ||
    pull.base.repo.id !== REPOSITORY_ID ||
    pull.base.repo.full_name !== REPOSITORY ||
    pull.head.ref === event.repository.default_branch ||
    pull.head.ref === pull.base.ref ||
    pull.labels.some((label) => label.name === 'copse-review-skip')
  ) {
    throw new Error(
      'Follow-up is not an unchanged owner request on an open same-repository owner PR',
    )
  }
  return {
    pr: pull.number,
    head: pull.head.sha,
    base: pull.base.sha,
    branch: pull.head.ref,
    baseBranch: pull.base.ref,
    commentId: comment.id,
    commentUpdatedAt: comment.updated_at,
    body: comment.body,
    ...parsed,
  }
}

export function assertCurrent(expected: FollowUpRequest, current: FollowUpRequest): void {
  if (!isDeepStrictEqual(expected, current))
    throw new Error('Request or PR changed; post a new command')
}

const reportSchema = z.object({
  carryIn: z.object({ sha, dirty: z.literal(false) }),
  carryOut: z.object({
    ref: z
      .string()
      .regex(/^refs\/copse\/runs\/[a-z0-9-]+$/i)
      .nullable(),
    error: z.null(),
  }),
  containerExit: z.literal(0),
  cleanupError: z.null(),
  teardown: z.enum(['removed', 'already-gone']),
  secretCanary: z.object({ present: z.literal(false) }),
  result: z.object({
    stopReason: z.literal('completed'),
    promptsAttempted: z.literal(0),
    deferrals: z.array(z.unknown()).length(0),
    containment: z.object({ declared: z.literal(true) }),
  }),
})
export function publicationRef(text: string, request: FollowUpRequest): string | null {
  const report = decode(text, reportSchema)
  if (report.carryIn.sha !== request.head) throw new Error('Container started from the wrong head')
  return report.carryOut.ref
}

/** Only an explicit rebase request permits rewriting the captured PR head. */
export function pushArgs(request: FollowUpRequest, commit: string): string[] {
  sha.parse(commit)
  return [
    'push',
    '--porcelain',
    `--force-with-lease=refs/heads/${request.branch}:${request.head}`,
    'origin',
    `${commit}:refs/heads/${request.branch}`,
  ]
}

/** Validate objects imported from the guest before any authenticated Git operation. */
export function validatePublication(
  request: FollowUpRequest,
  ref: string,
  git: (args: string[]) => string,
): string {
  const commit = sha.parse(git(['rev-parse', '--verify', `${ref}^{commit}`]))
  git([
    'merge-base',
    '--is-ancestor',
    request.mode === 'rebase' ? request.base : request.head,
    commit,
  ])
  const changed = git([
    'diff',
    '--name-only',
    request.mode === 'rebase' ? request.base : request.head,
    commit,
    '--',
    '.github/workflows',
    '.github/actions',
  ])
  if (changed)
    throw new Error('Follow-up publication cannot change GitHub Actions workflows or actions')
  return commit
}
