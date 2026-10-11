import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@shared/safe-json.ts'
import { runGh } from '../github/gh-service.ts'

type Gh = typeof runGh

const sha = z.string().regex(/^[a-f0-9]{40}$/i)
const text = (max: number): z.ZodString => z.string().max(max)

/** Labels are interpolated into a `--jq` expression, so the alphabet excludes quotes and backslashes. */
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,49}$/

export const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  draft: z.boolean(),
  title: text(512),
  html_url: z.url(),
  updated_at: text(64),
  head: z.object({ sha, ref: text(256) }),
  author: text(128).nullable(),
})
export type PullRequestObservation = z.infer<typeof pullRequestSchema>

const pullRequestHeadSchema = z.object({
  state: z.string(),
  draft: z.boolean(),
  head: z.object({ sha, ref: text(256) }),
})
export type PullRequestHead = z.infer<typeof pullRequestHeadSchema>

export const labelEventSchema = z.object({
  id: z.number().int().positive(),
  created_at: text(64),
  label: text(100),
  actor: text(128).nullable(),
  issue: z.object({
    number: z.number().int().positive(),
    title: text(512),
    html_url: z.url(),
    state: z.string(),
  }),
})
export type LabelEventObservation = z.infer<typeof labelEventSchema>

const issueLabelStateSchema = z.object({ state: z.string(), labels: z.array(text(100)).max(100) })

async function ghJson<T>(
  root: string,
  gh: Gh,
  args: string[],
  schema: z.ZodType<T>,
  what: string,
): Promise<T> {
  const result = await gh(args, { cwd: root, timeout_ms: 15_000 })
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'GitHub request failed')
  const parsed = safeJsonParse(result.stdout, decodeWithSchema(schema))
  if (parsed === null) throw new Error(`GitHub returned invalid ${what} data`)
  return parsed
}

function split(repository: string): { host: string; slug: string } {
  const [host, owner, name] = repository.split('/')
  if (!host || !owner || !name) throw new Error('Invalid repository identity')
  return { host, slug: `${owner}/${name}` }
}

/** Open pull requests into `baseBranch`, most recently updated first. */
export async function readOpenPullRequests(
  root: string,
  repository: string,
  baseBranch: string,
  gh: Gh = runGh,
): Promise<PullRequestObservation[]> {
  const { host, slug } = split(repository)
  return ghJson(
    root,
    gh,
    [
      'api',
      `repos/${slug}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&sort=updated&direction=desc&per_page=50`,
      '--hostname',
      host,
      '--jq',
      '[.[] | {number, draft, title, html_url, updated_at, head: {sha: .head.sha, ref: .head.ref}, author: .user.login}]',
    ],
    z.array(pullRequestSchema).max(50),
    'pull request',
  )
}

export async function readPullRequestHead(
  root: string,
  repository: string,
  pullRequest: number,
  gh: Gh = runGh,
): Promise<PullRequestHead> {
  const { host, slug } = split(repository)
  return ghJson(
    root,
    gh,
    [
      'api',
      `repos/${slug}/pulls/${String(pullRequest)}`,
      '--hostname',
      host,
      '--jq',
      '{state, draft, head: {sha: .head.sha, ref: .head.ref}}',
    ],
    pullRequestHeadSchema,
    'pull request',
  )
}

/** Recent `labeled` events for one label on issues (not pull requests). Each event id is one transition. */
export async function readLabelEvents(
  root: string,
  repository: string,
  label: string,
  gh: Gh = runGh,
): Promise<LabelEventObservation[]> {
  if (!LABEL_PATTERN.test(label)) throw new Error('Choose a valid label name')
  const { host, slug } = split(repository)
  return ghJson(
    root,
    gh,
    [
      'api',
      `repos/${slug}/issues/events?per_page=100`,
      '--hostname',
      host,
      '--jq',
      `[.[] | select(.event == "labeled" and .label.name == "${label}" and (.issue.pull_request | not)) | {id, created_at, label: .label.name, actor: .actor.login, issue: {number: .issue.number, title: .issue.title, html_url: .issue.html_url, state: .issue.state}}]`,
    ],
    z.array(labelEventSchema).max(100),
    'issue',
  )
}

/** Whether `issue` is still open and still carries `label` — the freshness check before a run starts. */
export async function readIssueHasLabel(
  root: string,
  repository: string,
  issue: number,
  label: string,
  gh: Gh = runGh,
): Promise<boolean> {
  const { host, slug } = split(repository)
  const state = await ghJson(
    root,
    gh,
    [
      'api',
      `repos/${slug}/issues/${String(issue)}`,
      '--hostname',
      host,
      '--jq',
      '{state, labels: [.labels[].name]}',
    ],
    issueLabelStateSchema,
    'issue',
  )
  return state.state === 'open' && state.labels.includes(label)
}
