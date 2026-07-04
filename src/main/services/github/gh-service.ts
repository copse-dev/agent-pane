import { runCommand } from '../command-runner.ts'
import { getWorkspaceRoot } from '../workspace.ts'
import { isGhAvailable } from '../tool-availability.ts'
import { safeJsonParse } from '@shared/safe-json.ts'

export interface GhPrListEntry {
  number: number
  title: string
  url: string
  state: string
  headRefName?: string
  author?: { login?: string }
  createdAt?: string
  updatedAt?: string
}

export interface GhPrViewDetails {
  state?: string
  number?: number
  title?: string
  url?: string
  body?: string
  headRefName?: string
  baseRefName?: string
  author?: { login?: string }
  mergeable?: string
  mergeStateStatus?: string
  additions?: number
  deletions?: number
  changedFiles?: number
  files?: Array<{
    path?: string
    additions?: number
    deletions?: number
    changeType?: string
  }>
  statusCheckRollup?: Array<{
    name?: string
    conclusion?: string
    state?: string
    status?: string
  }>
}

export interface GhRunEntry {
  databaseId?: number
  workflowName?: string
  name?: string
  displayTitle?: string
  headBranch?: string
  headSha?: string
  conclusion?: string
  status?: string
  event?: string
  createdAt?: string
  url?: string
}

/**
 * GitHub check/run conclusions that count as a CI failure. Shared so the
 * follow-up bubble detector and the CI run tools agree on what "failing" means.
 */
export const FAILING_CI_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT'])

export function isFailingConclusion(value: string | undefined | null): boolean {
  return FAILING_CI_CONCLUSIONS.has((value ?? '').toUpperCase())
}

function ghPathPrefix(): string {
  return process.platform === 'win32' ? '' : '/usr/bin:/bin:/exec-daemon:'
}

/**
 * Non-token GitHub env vars worth forwarding to gh regardless of which credential
 * it ends up using (host selection, config-dir location). These never shadow a
 * working `gh auth login` credential, so they are always passed through.
 */
const GH_CONFIG_ENV_KEYS = ['GH_HOST', 'GH_CONFIG_DIR'] as const

/**
 * Bearer-token env vars. gh authenticates from these *in preference to* its config
 * dir (`~/.config/gh`), so forwarding them unconditionally lets a stale/wrong-scope
 * local token shadow a working `gh auth login` credential — that is the #516
 * regression introduced by #521's unconditional forwarding. They are forwarded only
 * as a *fallback*, when gh has no usable config-dir credential of its own.
 */
const GH_TOKEN_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const

/**
 * Environment for the gh subprocess: a minimal PATH plus GitHub config vars, and —
 * only when `includeTokens` is set — the bearer-token vars from the parent env.
 *
 * Token forwarding is a deliberate *fallback*, not a default: gh prefers an env
 * token over its config dir, so an always-forwarded local `GITHUB_TOKEN` (often
 * present for unrelated tooling, expired, or wrong-scope) overrides a working
 * `gh auth login` and breaks `gh` (#516). When `includeTokens` is false we also
 * blank the token keys: runGh spawns via runCommand, which merges this env *on top
 * of* `process.env`, so an unset key would otherwise leak the parent's token
 * through. Setting them empty makes gh treat them as absent and fall back to its
 * config-dir credential. (#521 added the forwarding; #516 makes it conditional.)
 */
export function ghEnv(
  base: NodeJS.ProcessEnv = process.env,
  opts: { includeTokens?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = { PATH: `${ghPathPrefix()}${base['PATH'] ?? ''}` }
  for (const key of GH_CONFIG_ENV_KEYS) {
    const value = base[key]
    if (value) env[key] = value
  }
  for (const key of GH_TOKEN_ENV_KEYS) {
    const value = base[key]
    if (opts.includeTokens && value) env[key] = value
    // Blank (not omit) so the runCommand merge over process.env can't leak the
    // parent's token and shadow gh's own config-dir auth.
    else if (value) env[key] = ''
  }
  return env
}

/** True when any GitHub bearer token is present in the environment. */
function hasEnvToken(base: NodeJS.ProcessEnv = process.env): boolean {
  return GH_TOKEN_ENV_KEYS.some((key) => !!base[key])
}

/**
 * Pure decision for whether runGh should forward the environment's GitHub token.
 *
 * Forward only as a fallback: never when a token is absent, and never when gh's own
 * config-dir auth already works (forwarding then would let a stale/wrong local token
 * shadow the working `gh auth login` credential — the #516 regression). Forward when
 * a token is present and gh has no working config-dir auth of its own (#521).
 */
export function decideForwardEnvToken(opts: {
  hasToken: boolean
  configAuthWorks: boolean
}): boolean {
  if (!opts.hasToken) return false
  return !opts.configAuthWorks
}

/**
 * Cached decision: should runGh forward the environment's GitHub token to gh?
 *
 * Forwarding is only needed as a fallback when gh has no working config-dir
 * credential of its own. We probe `gh auth status` once with tokens *suppressed*
 * (so the probe reflects only `gh auth login` state). If that succeeds, gh is
 * already authenticated and we must NOT forward the env token — doing so would let
 * a stale/wrong local token shadow the working credential (#516). If it fails and a
 * token is present, we forward it so gh can still reach the API (#521).
 */
let forwardEnvTokenProbe: Promise<boolean> | null = null

export function resetGhEnvTokenProbeForTest(): void {
  forwardEnvTokenProbe = null
}

async function shouldForwardEnvToken(cwd: string, signal?: AbortSignal): Promise<boolean> {
  if (!hasEnvToken()) return false
  forwardEnvTokenProbe ??= (async (): Promise<boolean> => {
    const probeOpts: Parameters<typeof runCommand>[2] = {
      cwd,
      unsandboxed: true,
      env: ghEnv(process.env, { includeTokens: false }),
      timeout_ms: 10_000,
    }
    if (signal !== undefined) probeOpts.signal = signal
    try {
      const { code } = await runCommand('gh', ['auth', 'status'], probeOpts)
      // code 0 → gh has a working config-dir credential; keep using it (don't forward).
      // non-zero → no usable config-dir auth; fall back to the env token.
      return decideForwardEnvToken({ hasToken: true, configAuthWorks: code === 0 })
    } catch {
      // Probe failed to even run — fall back to forwarding so a token still gets a chance.
      return true
    }
  })()
  return forwardEnvTokenProbe
}

/** Run GitHub CLI outside the project sandbox so read-only API calls can reach GitHub. */
export async function runGh(
  args: string[],
  opts: { timeout_ms?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = getWorkspaceRoot()
  if (!cwd) return { stdout: '', stderr: 'No workspace open.', code: 1 }
  const includeTokens = await shouldForwardEnvToken(cwd, opts.signal)
  const commandOpts: Parameters<typeof runCommand>[2] = {
    cwd,
    unsandboxed: true,
    env: ghEnv(process.env, { includeTokens }),
  }
  if (opts.timeout_ms !== undefined) commandOpts.timeout_ms = opts.timeout_ms
  if (opts.signal !== undefined) commandOpts.signal = opts.signal
  const { stdout, stderr, code } = await runCommand('gh', args, commandOpts)
  return { stdout, stderr, code }
}

/**
 * Parse JSON stdout from `gh`, or null when empty/invalid.
 *
 * The `T` type parameter is a caller-supplied cast for the parsed value relied
 * on by call sites (e.g. `parseGhJson<GhPrView>(raw)`); removing it would change
 * this exported signature and break those callers, so the single-use type
 * parameter is intentional here.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function parseGhJson<T = unknown>(stdout: string): T | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  return safeJsonParse<T>(trimmed)
}

function formatGhError(stderr: string, code: number): string {
  const msg = stderr.trim()
  if (msg) return msg
  if (code === 127) return 'gh is not available on this system.'
  return `gh exited with code ${String(code)}`
}

export function formatGhPrList(entries: GhPrListEntry[]): string {
  if (entries.length === 0) return '(no pull requests)'
  return entries
    .map((pr) => {
      const head = pr.headRefName ? ` (${pr.headRefName})` : ''
      const author = pr.author?.login ? ` by ${pr.author.login}` : ''
      return `#${String(pr.number)} ${pr.title} — ${pr.state}${head}${author}\n  ${pr.url}`
    })
    .join('\n')
}

function formatCheckStatus(
  check: NonNullable<GhPrViewDetails['statusCheckRollup']>[number],
): string {
  const name = check.name ?? 'check'
  const status = (check.conclusion ?? check.state ?? check.status ?? 'unknown').toUpperCase()
  return `${name}: ${status}`
}

export function formatGhPrView(pr: GhPrViewDetails): string {
  if (!pr.number || !pr.url) return '(invalid PR data)'
  const lines = [
    `#${String(pr.number)} ${pr.title ?? '(no title)'}`,
    `State: ${pr.state ?? 'unknown'}`,
    `URL: ${pr.url}`,
  ]
  if (pr.headRefName || pr.baseRefName) {
    lines.push(`Branch: ${pr.headRefName ?? '?'} → ${pr.baseRefName ?? '?'}`)
  }
  if (pr.author?.login) lines.push(`Author: ${pr.author.login}`)
  if (pr.mergeable) lines.push(`Mergeable: ${pr.mergeable}`)
  if (pr.mergeStateStatus) lines.push(`Merge state: ${pr.mergeStateStatus}`)
  if (typeof pr.changedFiles === 'number') {
    lines.push(`Files changed: ${String(pr.changedFiles)}`)
  }
  if (typeof pr.additions === 'number' || typeof pr.deletions === 'number') {
    lines.push(`Diff: +${String(pr.additions ?? 0)} -${String(pr.deletions ?? 0)}`)
  }
  const checks = pr.statusCheckRollup ?? []
  if (checks.length > 0) {
    lines.push('Checks:')
    for (const check of checks) lines.push(`  - ${formatCheckStatus(check)}`)
  }
  if (pr.body?.trim()) {
    lines.push('', 'Description:', pr.body.trim())
  }
  return lines.join('\n')
}

export async function getGhPrListText(opts: {
  state: 'open' | 'closed' | 'merged' | 'all'
  limit: number
  head?: string | undefined
}): Promise<string> {
  if (!isGhAvailable()) return 'gh is not available on this system.'
  const args = [
    'pr',
    'list',
    '--state',
    opts.state,
    '--limit',
    String(opts.limit),
    '--json',
    'number,title,url,state,headRefName,author,createdAt,updatedAt',
  ]
  if (opts.head) args.push('--head', opts.head)
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) return formatGhError(stderr, code)
  const list = safeJsonParse<GhPrListEntry[]>(stdout.trim())
  if (!Array.isArray(list)) return stdout.trim() || '(no output)'
  return formatGhPrList(list)
}

async function currentGitBranch(): Promise<string | null> {
  const cwd = getWorkspaceRoot()
  if (!cwd) return null
  const pathPrefix = process.platform === 'win32' ? '' : '/usr/bin:/bin:'
  const { stdout, code } = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    env: { PATH: `${pathPrefix}${process.env['PATH'] ?? ''}` },
  })
  return code === 0 ? stdout.trim() || null : null
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '?'
}

export function formatGhRunList(entries: GhRunEntry[]): string {
  if (entries.length === 0) return '(no workflow runs)'
  return entries
    .map((run) => {
      const id = run.databaseId !== undefined ? `#${String(run.databaseId)}` : '(no id)'
      const workflow = run.workflowName ?? run.name ?? 'workflow'
      const outcome = (run.conclusion ?? run.status ?? 'unknown').toUpperCase()
      const where = `${run.headBranch ?? '?'} @ ${shortSha(run.headSha)}`
      const title = run.displayTitle ? ` — ${run.displayTitle}` : ''
      const url = run.url ? `\n  ${run.url}` : ''
      return `${id} ${workflow}: ${outcome} (${where})${title}${url}`
    })
    .join('\n')
}

/** Keep the last `maxChars` of a (potentially huge) log, noting how much was dropped. */
export function truncateLogTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const tail = text.slice(text.length - maxChars)
  const dropped = text.length - maxChars
  return `… [${String(dropped)} earlier characters truncated; showing the last ${String(maxChars)}]\n${tail}`
}

export async function getGhRunListText(opts: {
  branch?: string | undefined
  limit: number
  failedOnly?: boolean | undefined
}): Promise<string> {
  if (!isGhAvailable()) return 'gh is not available on this system.'
  const branch = opts.branch ?? (await currentGitBranch())
  const args = [
    'run',
    'list',
    '--limit',
    String(opts.limit),
    '--json',
    'databaseId,workflowName,name,displayTitle,headBranch,headSha,conclusion,status,event,createdAt,url',
  ]
  if (branch) args.push('--branch', branch)
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) return formatGhError(stderr, code)
  let list = safeJsonParse<GhRunEntry[]>(stdout.trim())
  if (!Array.isArray(list)) return stdout.trim() || '(no output)'
  if (opts.failedOnly) list = list.filter((run) => isFailingConclusion(run.conclusion))
  return formatGhRunList(list)
}

/** Default cap on returned log size to keep CI logs within the agent's context budget. */
export const GH_RUN_LOG_MAX_CHARS = 20_000

export async function getGhRunLogText(opts: {
  runId: number
  failedOnly?: boolean
  maxChars?: number
}): Promise<string> {
  if (!isGhAvailable()) return 'gh is not available on this system.'
  const args = [
    'run',
    'view',
    String(opts.runId),
    opts.failedOnly === false ? '--log' : '--log-failed',
  ]
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) return formatGhError(stderr, code)
  const log = stdout.trim()
  if (!log) return '(no log output — the run may still be in progress or have no failing steps)'
  return truncateLogTail(log, opts.maxChars ?? GH_RUN_LOG_MAX_CHARS)
}

export async function getGhPrViewText(opts: {
  number?: number | undefined
  includeChecks: boolean
}): Promise<string> {
  if (!isGhAvailable()) return 'gh is not available on this system.'
  const jsonFields = [
    'state',
    'number',
    'title',
    'url',
    'body',
    'headRefName',
    'baseRefName',
    'author',
    'mergeable',
    'mergeStateStatus',
    'additions',
    'deletions',
    'changedFiles',
  ]
  if (opts.includeChecks) jsonFields.push('statusCheckRollup')
  const args = ['pr', 'view', '--json', jsonFields.join(',')]
  if (opts.number !== undefined) args.push(String(opts.number))
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) return formatGhError(stderr, code)
  const pr = safeJsonParse<GhPrViewDetails>(stdout.trim())
  if (!pr) return stdout.trim() || '(no output)'
  return formatGhPrView(pr)
}

export function formatGhPrFiles(pr: GhPrViewDetails): string {
  if (!pr.number) return '(invalid PR data)'
  const files = pr.files ?? []
  const count = typeof pr.changedFiles === 'number' ? pr.changedFiles : files.length
  const header = `#${String(pr.number)} ${pr.title ?? '(no title)'} — ${String(count)} file${
    count === 1 ? '' : 's'
  } changed`
  if (files.length === 0) {
    return `${header}\n(no per-file list returned by gh)`
  }
  const lines = files.map((file) => {
    const path = file.path ?? '(unknown)'
    const change = (file.changeType ?? '').toLowerCase()
    const tag = change ? `${change.padEnd(8)} ` : ''
    return `  ${tag}${path} (+${String(file.additions ?? 0)} -${String(file.deletions ?? 0)})`
  })
  const totals = `Total: +${String(pr.additions ?? 0)} -${String(pr.deletions ?? 0)}`
  return [header, ...lines, totals].join('\n')
}

export async function getGhPrFilesText(opts: { number?: number | undefined }): Promise<string> {
  if (!isGhAvailable()) return 'gh is not available on this system.'
  const args = [
    'pr',
    'view',
    '--json',
    ['number', 'title', 'url', 'additions', 'deletions', 'changedFiles', 'files'].join(','),
  ]
  if (opts.number !== undefined) args.push(String(opts.number))
  const { stdout, stderr, code } = await runGh(args)
  if (code !== 0) return formatGhError(stderr, code)
  const pr = safeJsonParse<GhPrViewDetails>(stdout.trim())
  if (!pr) return stdout.trim() || '(no output)'
  return formatGhPrFiles(pr)
}
