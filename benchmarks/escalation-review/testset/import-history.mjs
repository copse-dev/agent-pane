// Turn a private escalation-review extraction into an anonymised holdout slice.
//
//   node benchmarks/escalation-review/testset/import-history.mjs candidates <run-dir> --projects a,b
//   node benchmarks/escalation-review/testset/import-history.mjs finalize <run-dir> --slice <name>
//
// `candidates` reads <run-dir>/dataset.jsonl (from ../scripts/extract.mjs). It keeps rows
// whose project directory name is listed in --projects, meaning public repositories only,
// and skips any command an earlier slice already used. It moves every path, user, host,
// repository and address onto the anonymised machine and drops any row that still looks
// identifying or carries a secret. The result is <run-dir>/history-candidates.jsonl, mode
// 0600, never committed. Review it, and list ids to drop in <run-dir>/history-rejected.txt.
//
// `finalize` writes the surviving rows to sources/history-<name>.jsonl, which build.mjs
// always puts in the holdout split, and records their hashes in the private ledger so no
// later slice reuses them. The ledger is <COPSE_DIR or ~/.copse>/cache/escalation-review/
// sliced.txt, one sha256 of a raw command per line, and never leaves this machine.
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOME, TESTSET, WORKSPACE } from './paths.mjs'

const hash = (text) => createHash('sha256').update(text).digest('hex')

export function ledgerPath(env = process.env) {
  const copse = env.COPSE_DIR?.trim() || join(homedir(), '.copse')
  return join(copse, 'cache', 'escalation-review', 'sliced.txt')
}

function readLedger(path) {
  return new Set(existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [])
}

/** The project checkout a row belongs to: `.claude/worktrees/*` and Copse worktrees fold into it. */
function projectOf(row) {
  const root = row.projectRoot ?? row.cwd ?? ''
  return root.split('/.claude/worktrees/')[0]
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Rewrite one command onto the anonymised machine. The row's own workspace and project
 * become `/Users/dev/project`, the real home becomes `/Users/dev`, and every other
 * project directory under home keeps only its position (`/Users/dev/other-N`), whether
 * it is spelled with the real path, `~` or `$HOME`.
 */
export function anonymise(command, { realHome, workspace, project, user }) {
  let out = command
  const homeForms = [realHome, '${HOME}', '$HOME', '~']
  const inHome = (path, form) =>
    path?.startsWith(realHome) ? form + path.slice(realHome.length) : null
  const workspaces = []
  for (const path of [workspace, project]) {
    if (!path) continue
    for (const form of homeForms) {
      const spelled = form === realHome ? path : inHome(path, form)
      if (spelled) workspaces.push(spelled)
    }
  }
  // Longest first, so a worktree path is not half-rewritten by its project's prefix.
  for (const from of workspaces.sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(from, WORKSPACE)
  }
  const others = new Map()
  const prefix = homeForms.map(escape).join('|')
  out = out.replace(
    new RegExp(`(?<![\\w/])(${prefix})(/[^\\s'"\`;|&)]*)?`, 'g'),
    (match, form, rest = '') => {
      const home = form === realHome ? HOME : form
      if (form === '~' && rest === '' && match !== '~') return match
      if (!rest) return home
      const [first, ...tail] = rest.slice(1).split('/')
      // Dotfiles and well-known folders keep their names; project folders do not.
      if (/^(?:\.[\w.-]+|Library|Downloads|Desktop|Documents|go|bin)$/.test(first ?? '')) {
        return `${home}${rest}`
      }
      const key = `${first}/${tail[0] ?? ''}`
      if (!others.has(key)) others.set(key, `other-${others.size + 1}`)
      return `${home}/${others.get(key)}${tail.length > 1 ? `/${tail.slice(1).join('/')}` : ''}`
    },
  )
  return out
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      '00000000-0000-0000-0000-000000000000',
    )
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, (email) =>
      email.startsWith('git@') ? email : 'dev@example.com',
    )
    .replace(/(github\.com[/:])[\w.-]+\/[\w.-]+?(\.git)?(?=[\s'"/#]|$)/g, '$1o/r$2')
    .replace(/\brepos\/[\w.-]+\/[\w.-]+/g, 'repos/o/r')
    .replace(/(--repo(?:=|\s+)|-R\s+)[\w.-]+\/[\w.-]+/g, '$1o/r')
    .replace(new RegExp(`\\b${escape(user)}\\/[\\w.-]+`, 'gi'), 'o/r')
    .replace(/\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)(?:\.\d{1,3}){2,3}\b/g, '192.0.2.10')
    .replace(/\b[\w-]+\.local\b/gi, 'mini.local')
    .replace(PRIVATE_HOST, () => 'internal.example')
    .replace(new RegExp(`\\b${escape(user)}\\b`, 'gi'), 'dev')
}

/** Hosts on suffixes that only exist inside an organisation. */
const PRIVATE_HOST = /\b(?:[\w-]+\.)+(?:internal|corp|lan|home|intranet|private|localdomain)\b/gi

/**
 * Hosts a published command may name. Anything else is dropped until a reviewer
 * adds it here: an unknown host can be someone's infrastructure.
 */
const PUBLIC_HOSTS = new Set([
  'github.com',
  'githubusercontent.com',
  'github.io',
  'githubassets.com',
  'gitlab.com',
  'bitbucket.org',
  'crates.io',
  'docs.rs',
  'rust-lang.org',
  'rustup.rs',
  'npmjs.org',
  'npmjs.com',
  'yarnpkg.com',
  'pypi.org',
  'pythonhosted.org',
  'golang.org',
  'go.dev',
  'nodejs.org',
  'deno.land',
  'jsdelivr.net',
  'unpkg.com',
  'docker.com',
  'docker.io',
  'ghcr.io',
  'apple.com',
  'mozilla.org',
  'servo.org',
  'tauri.app',
  'w3.org',
  'whatwg.org',
  'wikipedia.org',
  'huggingface.co',
  'copse.dev',
  'example.com',
  'example.org',
  'example.net',
])
const RESERVED_SUFFIX =
  /(?:^|\.)(?:example|invalid|test|localhost)$|^localhost$|^(?:\d{1,3}\.){3}\d{1,3}$/

/** Hosts a command names in a URL, after `user@`, or as an ssh-family destination. */
export function namedHosts(command) {
  const hosts = []
  for (const match of command.matchAll(
    /[a-z][\w+.-]*:\/\/(?:[\w.%+-]*(?::[\w.%+-]*)?@)?(\[[\da-f:]+\]|[a-z0-9.-]+)/gi,
  )) {
    hosts.push(match[1])
  }
  for (const match of command.matchAll(/\b[\w.+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) {
    hosts.push(match[1])
  }
  // ssh, sftp and mosh take the host as their first operand; flags may take a value.
  const shell =
    /\b(?:ssh|sftp|mosh)\s+(?:-\S+\s+(?:\S+\s+)?)*(?:[\w.-]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?=[\s'"]|$)/gi
  for (const match of command.matchAll(shell)) hosts.push(match[1])
  // scp and rsync name a remote as `host:path`.
  if (/\b(?:scp|rsync)\b/.test(command)) {
    for (const match of command.matchAll(
      /(?:^|\s)(?:[\w.-]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)*):(?!\/\/)/gi,
    )) {
      hosts.push(match[1])
    }
  }
  return [...new Set(hosts.map((host) => host.toLowerCase().replace(/\.$/, '')))]
}

/** Single-word ssh aliases generic enough to name nobody's machine. */
const GENERIC_ALIASES = new Set([
  'mini',
  'host',
  'server',
  'remote',
  'bastion',
  'web',
  'box',
  'devbox',
  'buildbox',
  'prod',
  'staging',
  'localhost',
])

function isPublicHost(host) {
  if (RESERVED_SUFFIX.test(host)) return true
  if (!host.includes('.')) return GENERIC_ALIASES.has(host)
  const labels = host.split('.')
  for (let i = 0; i < labels.length - 1; i++) {
    if (PUBLIC_HOSTS.has(labels.slice(i).join('.'))) return true
  }
  return false
}

/** Why an anonymised command must not be published, or null. */
export function leakReason(command, { user, denied = [] }) {
  const checks = [
    [/\/Users\/(?!dev\b)[^/\s'"]+/, 'another home directory'],
    [new RegExp(escape(user), 'i'), 'the real user name'],
    [
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{10,}|eyJ[\w-]{20,}\.[\w-]{20,})/,
      'a token',
    ],
    [
      /(?:token|secret|password|passwd|api[_-]?key|authorization)\s*[:=]\s*['"]?[\w./+=-]{16,}/i,
      'an inline secret',
    ],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\b(?!git@)[\w.+-]+@(?!example\.com\b)[\w-]+(?:\.[\w-]+)+\b/, 'an email address'],
  ]
  for (const [pattern, reason] of checks) if (pattern.test(command)) return reason
  // Names of projects this slice excludes (private or someone else's) must not leak through.
  const lower = command.toLowerCase()
  const name = denied.find((word) => lower.includes(word.toLowerCase()))
  if (name) return 'an excluded project name'
  if (command.length > 1200) return 'too long to review'
  if (namedHosts(command).some((host) => !isPublicHost(host))) return 'an unrecognised hostname'
  return null
}

function jsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

/**
 * This machine's name and its ssh aliases (`Host` lines in ~/.ssh/config). A
 * command naming one of them names the user's own machines.
 */
function machineNames(realHome) {
  const names = [hostname().split('.')[0] ?? '']
  try {
    const config = readFileSync(join(realHome, '.ssh', 'config'), 'utf8')
    for (const match of config.matchAll(/^\s*Host\s+(.+)$/gim)) {
      names.push(...(match[1] ?? '').split(/\s+/).filter((alias) => !/[*?]/.test(alias)))
    }
  } catch {
    // No ssh config: nothing to add.
  }
  return names.filter((name) => name.length >= 4 && !GENERIC_ALIASES.has(name.toLowerCase()))
}

export function candidates(runDir, projects, env = process.env) {
  const realHome = env.HOME ?? homedir()
  const user = basename(realHome)
  const ledger = readLedger(ledgerPath(env))
  const allowed = new Set(projects)
  const rows = jsonl(join(runDir, 'dataset.jsonl'))
  const denied = [
    ...new Set(rows.map((row) => basename(projectOf(row))).filter((name) => name.length >= 4)),
  ]
    .filter((name) => !allowed.has(name))
    .concat(machineNames(realHome))
  const seen = new Set()
  const out = []
  const dropped = {}
  for (const row of rows) {
    const project = projectOf(row)
    if (!allowed.has(basename(project))) continue
    const rawHash = hash(row.command)
    if (ledger.has(rawHash) || seen.has(rawHash)) continue
    seen.add(rawHash)
    const command = anonymise(row.command, { realHome, workspace: row.cwd, project, user })
    const reason = leakReason(command, { user, denied })
    if (reason) {
      dropped[reason] = (dropped[reason] ?? 0) + 1
      continue
    }
    out.push({ id: rawHash.slice(0, 12), rawHash, project: basename(project), command })
  }
  const path = join(runDir, 'history-candidates.jsonl')
  writeFileSync(path, out.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
  // `mode` applies only when the file is created; a rerun must not keep a wider mode.
  chmodSync(path, 0o600)
  return { path, kept: out.length, dropped }
}

export function finalize(runDir, slice, env = process.env) {
  if (!/^[\w.-]+$/.test(slice)) throw new Error(`Slice names are [A-Za-z0-9_.-]: ${slice}`)
  const target = join(TESTSET, 'sources', `history-${slice}.jsonl`)
  if (existsSync(target)) throw new Error(`${target} exists; slices are append-only`)
  const rejectedPath = join(runDir, 'history-rejected.txt')
  const rejected = new Set(
    existsSync(rejectedPath) ? readFileSync(rejectedPath, 'utf8').split(/\s+/).filter(Boolean) : [],
  )
  const kept = jsonl(join(runDir, 'history-candidates.jsonl')).filter(
    (row) => !rejected.has(row.id),
  )
  const rows = kept.map((row, index) => ({
    id: `hist-${slice}-${String(index + 1).padStart(4, '0')}`,
    source: `history:${slice}`,
    command: row.command,
  }))
  writeFileSync(target, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  const ledger = ledgerPath(env)
  mkdirSync(dirname(ledger), { recursive: true })
  // Every candidate counts as used, rejected or not: a rejected command is not fresh either.
  const used = jsonl(join(runDir, 'history-candidates.jsonl')).map((row) => row.rawHash)
  appendFileSync(ledger, used.map((line) => `${line}\n`).join(''), { mode: 0o600 })
  chmodSync(ledger, 0o600)
  return { target, rows: rows.length, rejected: rejected.size }
}

export function main(argv = process.argv.slice(2)) {
  const [mode, runDir] = argv
  const flag = (name) => {
    const index = argv.indexOf(name)
    return index === -1 ? undefined : argv[index + 1]
  }
  if (mode === 'candidates' && runDir && flag('--projects')) {
    const result = candidates(runDir, (flag('--projects') ?? '').split(','))
    console.log(`${result.kept} candidates -> ${result.path}`, result.dropped)
    return 0
  }
  if (mode === 'finalize' && runDir && flag('--slice')) {
    const result = finalize(runDir, flag('--slice') ?? '')
    console.log(`${result.rows} rows (${result.rejected} rejected) -> ${result.target}`)
    return 0
  }
  console.error(
    'Usage: import-history.mjs candidates <run-dir> --projects a,b | finalize <run-dir> --slice <name>',
  )
  return 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main()
}
