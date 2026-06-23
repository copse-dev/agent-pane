import { runCommand } from './command-runner.ts'
import { getWorkspaceRoot } from './workspace.ts'
import { isGhAvailable } from './tool-availability.ts'
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
  statusCheckRollup?: Array<{
    name?: string
    conclusion?: string
    state?: string
    status?: string
  }>
}

function ghPathPrefix(): string {
  return process.platform === 'win32' ? '' : '/usr/bin:/bin:/exec-daemon:'
}

/** Run GitHub CLI outside the project sandbox so read-only API calls can reach GitHub. */
export async function runGh(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = getWorkspaceRoot()
  if (!cwd) return { stdout: '', stderr: 'No workspace open.', code: 1 }
  return runCommand('gh', args, {
    cwd,
    unsandboxed: true,
    env: { PATH: `${ghPathPrefix()}${process.env.PATH ?? ''}` },
  })
}

function formatGhError(stderr: string, code: number): string {
  const msg = stderr.trim()
  if (msg) return msg
  if (code === 127) return 'gh is not available on this system.'
  return `gh exited with code ${code}`
}

export function formatGhPrList(entries: GhPrListEntry[]): string {
  if (entries.length === 0) return '(no pull requests)'
  return entries
    .map((pr) => {
      const head = pr.headRefName ? ` (${pr.headRefName})` : ''
      const author = pr.author?.login ? ` by ${pr.author.login}` : ''
      return `#${pr.number} ${pr.title} — ${pr.state}${head}${author}\n  ${pr.url}`
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
    `#${pr.number} ${pr.title ?? '(no title)'}`,
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
    lines.push(`Files changed: ${pr.changedFiles}`)
  }
  if (typeof pr.additions === 'number' || typeof pr.deletions === 'number') {
    lines.push(`Diff: +${pr.additions ?? 0} -${pr.deletions ?? 0}`)
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
  head?: string
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

export async function getGhPrViewText(opts: {
  number?: number
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
