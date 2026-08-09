#!/usr/bin/env node

import { lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const DEFAULT_ARTIFACTS = ['node_modules', 'dist', 'dist-test', 'coverage', '.tmp']
let duAvailable = process.platform !== 'win32'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    if (options.check === false) return { status: 1, stdout: '', stderr: result.error.message }
    throw result.error
  }
  const status = result.status ?? 1
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (status !== 0 && options.check !== false) {
    throw new Error(stderr.trim() || `${commandName} exited ${String(status)}`)
  }
  return { status, stdout, stderr }
}

function git(repo, args, options = {}) {
  return command('git', ['-C', repo, ...args], options)
}

function parseArgs(argv) {
  const result = { repo: '.', base: null, paths: [], artifacts: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Usage: audit-worktrees.mjs [options]

Read-only JSON audit of registered Git worktrees.

Options:
  --repo <path>      Any path inside the repository (default: .)
  --base <ref>       Comparison ref (default: auto-detect)
  --path <path>      Exact registered worktree path; repeatable
  --artifact <name>  Top-level artifact name; repeatable
  -h, --help         Show this help
`)
      process.exit(0)
    }
    if (!['--repo', '--base', '--path', '--artifact'].includes(arg)) {
      fail(`Unknown argument: ${arg}`)
    }
    const value = argv[index + 1]
    if (!value) fail(`Missing value for ${arg}`)
    index += 1
    if (arg === '--repo') result.repo = value
    else if (arg === '--base') result.base = value
    else if (arg === '--path') result.paths.push(value)
    else result.artifacts.push(value)
  }
  return result
}

function parseWorktrees(output) {
  const records = []
  let record = {}
  for (const field of output.split('\0')) {
    if (field === '') {
      if (Object.keys(record).length > 0) records.push(record)
      record = {}
      continue
    }
    const separator = field.indexOf(' ')
    if (separator === -1) record[field] = true
    else record[field.slice(0, separator)] = field.slice(separator + 1)
  }
  if (Object.keys(record).length > 0) records.push(record)
  return records
}

function existingPath(path) {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function canonicalPath(path) {
  const absolute = resolve(path)
  if (!existingPath(absolute)) return absolute
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function pathBytes(path) {
  if (duAvailable) {
    const du = command('du', ['-sk', '--', path], { check: false })
    if (du.status === 0) {
      const kibibytes = Number.parseInt(du.stdout.trim().split(/\s+/, 1)[0] ?? '', 10)
      if (Number.isFinite(kibibytes)) return kibibytes * 1024
    }
    duAvailable = false
  }

  const stat = existingPath(path)
  if (!stat) return 0
  const ownBytes = typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size
  if (!stat.isDirectory() || stat.isSymbolicLink()) return ownBytes
  let total = ownBytes
  for (const entry of readdirSync(path)) total += pathBytes(resolve(path, entry))
  return total
}

function parseStatus(output) {
  const tokens = output.split('\0')
  const entries = []
  let staged = 0
  let unstaged = 0
  let untracked = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    const x = token[0] ?? ' '
    const y = token[1] ?? ' '
    let display = token
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const source = tokens[index + 1]
      if (source) {
        display = `${token} <- ${source}`
        index += 1
      }
    }
    entries.push(display)
    if (x === '?' && y === '?') untracked += 1
    else {
      if (x !== ' ') staged += 1
      if (y !== ' ') unstaged += 1
    }
  }
  return {
    dirty_entries: entries.length,
    staged_entries: staged,
    unstaged_entries: unstaged,
    untracked_entries: untracked,
    porcelain: entries,
  }
}

function validArtifacts(values) {
  const names = values.length > 0 ? values : DEFAULT_ARTIFACTS
  for (const name of names) {
    if (
      name === '.' ||
      name === '..' ||
      name.toLowerCase() === '.git' ||
      isAbsolute(name) ||
      basename(name) !== name
    ) {
      fail(`Artifact must be one top-level name: ${name}`)
    }
  }
  return [...new Set(names)]
}

function detectBase(repo, requested) {
  const candidates = []
  if (requested) candidates.push(requested)
  else {
    const remoteHead = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
      check: false,
    })
    if (remoteHead.status === 0 && remoteHead.stdout.trim())
      candidates.push(remoteHead.stdout.trim())
    candidates.push('origin/main', 'origin/master', 'main', 'master')
  }
  for (const candidate of [...new Set(candidates)]) {
    const verified = git(repo, ['rev-parse', '--verify', `${candidate}^{commit}`], { check: false })
    if (verified.status === 0) return { ref: candidate, sha: verified.stdout.trim() }
  }
  fail(requested ? `Unknown base ref: ${requested}` : 'Could not detect a main/default branch')
}

function artifactSummary(worktreePath, artifactNames) {
  const artifacts = []
  for (const name of artifactNames) {
    const path = resolve(worktreePath, name)
    const stat = existingPath(path)
    if (!stat) continue
    const ignored =
      git(worktreePath, ['check-ignore', '-q', '--', name], { check: false }).status === 0
    const item = {
      name,
      path,
      ignored,
      size_bytes: pathBytes(path),
      kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
    }
    if (stat.isSymbolicLink()) item.symlink_target = readlinkSync(path)
    artifacts.push(item)
  }
  return artifacts
}

function comparisonSummary(worktreePath, base) {
  const counts = git(worktreePath, ['rev-list', '--left-right', '--count', `${base}...HEAD`], {
    check: false,
  })
  const cherry = git(worktreePath, ['cherry', base, 'HEAD'], { check: false })
  const cherryLines = cherry.status === 0 ? cherry.stdout.trim().split('\n').filter(Boolean) : []
  const countParts = counts.status === 0 ? counts.stdout.trim().split(/\s+/) : []
  return {
    base_only_commits: countParts[0] ? Number.parseInt(countParts[0], 10) : null,
    head_only_commits: countParts[1] ? Number.parseInt(countParts[1], 10) : null,
    comparison_error: counts.status === 0 ? null : counts.stderr.trim(),
    patch_equivalent_commits: cherryLines.filter((line) => line.startsWith('-')).length,
    unique_patch_commits: cherryLines.filter((line) => line.startsWith('+')).length,
    cherry: cherryLines,
    cherry_error: cherry.status === 0 ? null : cherry.stderr.trim(),
  }
}

function inspectWorktree(record, base, currentRoot, artifactNames) {
  const worktreePath = canonicalPath(record.worktree)
  const stat = existingPath(worktreePath)
  const branchRef = typeof record.branch === 'string' ? record.branch : null
  const basic = {
    path: worktreePath,
    current: worktreePath === currentRoot,
    branch: branchRef?.replace(/^refs\/heads\//, '') ?? null,
    detached: branchRef === null,
    head: record.HEAD ?? null,
    locked: record.locked ?? false,
    prunable: record.prunable ?? false,
  }
  if (!stat?.isDirectory()) {
    return {
      ...basic,
      error: 'registered worktree path is missing',
      artifact_bytes: 0,
      artifacts: [],
    }
  }
  try {
    const fields = git(worktreePath, ['log', '-1', '--format=%H%x00%an%x00%aI%x00%s'])
      .stdout.replace(/\n$/, '')
      .split('\0')
    const artifacts = artifactSummary(worktreePath, artifactNames)
    return {
      ...basic,
      head_commit: {
        sha: fields[0] ?? '',
        author: fields[1] ?? '',
        authored_at: fields[2] ?? '',
        subject: fields[3] ?? '',
      },
      status: parseStatus(git(worktreePath, ['status', '--porcelain=v1', '-z', '-unormal']).stdout),
      comparison: comparisonSummary(worktreePath, base),
      artifacts,
      artifact_bytes: artifacts.reduce((total, artifact) => total + artifact.size_bytes, 0),
    }
  } catch (error) {
    return {
      ...basic,
      error: error instanceof Error ? error.message : String(error),
      artifact_bytes: 0,
      artifacts: [],
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoInput = resolve(args.repo)
  const top = git(repoInput, ['rev-parse', '--show-toplevel'], { check: false })
  if (top.status !== 0) fail(top.stderr.trim() || `Not a Git repository: ${repoInput}`)
  const currentRoot = canonicalPath(top.stdout.trim())
  const base = detectBase(currentRoot, args.base)
  const artifactNames = validArtifacts(args.artifacts)
  let records = parseWorktrees(git(currentRoot, ['worktree', 'list', '--porcelain', '-z']).stdout)

  const selected = new Set(args.paths.map((path) => canonicalPath(path)))
  const registered = new Set(records.map((record) => canonicalPath(record.worktree)))
  const missing = [...selected].filter((path) => !registered.has(path))
  if (missing.length > 0) fail(`Paths are not registered worktrees: ${missing.join(', ')}`)
  if (selected.size > 0) {
    records = records.filter((record) => selected.has(canonicalPath(record.worktree)))
  }

  const worktrees = records.map((record) =>
    inspectWorktree(record, base.ref, currentRoot, artifactNames),
  )
  const result = {
    repository: currentRoot,
    base: base.ref,
    base_sha: base.sha,
    worktree_count: worktrees.length,
    dirty_worktree_count: worktrees.filter((item) => (item.status?.dirty_entries ?? 0) > 0).length,
    error_worktree_count: worktrees.filter((item) => item.error).length,
    artifact_bytes: worktrees.reduce((total, item) => total + item.artifact_bytes, 0),
    worktrees,
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main()
