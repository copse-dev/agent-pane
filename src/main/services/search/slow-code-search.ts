import * as fs from 'node:fs/promises'
import { stat as fsStat, open as fsOpen } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import micromatch from 'micromatch'
import { toRelativePath } from '../workspace.ts'

export const SLOW_SEARCH_MAX_PATTERN_LEN = 256
const MAX_FILE_BYTES = 512 * 1024
const MAX_LINE_LEN = 8_192
const MAX_WALK_DEPTH = 48
const BINARY_PROBE_BYTES = 8192

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'vendor',
  'out',
  '.next',
])

export interface SlowCodeSearchOptions {
  searchRoot: string
  pattern: string
  maxResults: number
  fixedString?: boolean
  caseSensitive?: boolean
  fileGlob?: string | undefined
}

export type SlowSearchLineMatcher = (line: string) => boolean

export function compileSlowSearchMatcher(
  pattern: string,
  opts: Pick<SlowCodeSearchOptions, 'fixedString' | 'caseSensitive'>,
): { matcher: SlowSearchLineMatcher } | { error: string } {
  const trimmed = pattern.trim()
  if (!trimmed) return { error: 'Empty search pattern.' }
  if (trimmed.length > SLOW_SEARCH_MAX_PATTERN_LEN) {
    return { error: `Search pattern exceeds ${String(SLOW_SEARCH_MAX_PATTERN_LEN)} characters.` }
  }

  if (opts.fixedString) {
    const needle = opts.caseSensitive ? trimmed : trimmed.toLowerCase()
    return {
      matcher: (line): boolean => {
        const hay = opts.caseSensitive ? line : line.toLowerCase()
        return hay.includes(needle)
      },
    }
  }

  if (looksLikeRiskyRegex(trimmed)) {
    return {
      error:
        'Regex pattern looks unsafe (nested quantifiers). Use fixed_string: true or a simpler pattern.',
    }
  }

  try {
    const flags = opts.caseSensitive ? '' : 'i'
    const re = new RegExp(trimmed, flags)
    return {
      matcher: (line): boolean => {
        const slice = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) : line
        return re.test(slice)
      },
    }
  } catch {
    return { error: 'Invalid regular expression.' }
  }
}

/** Heuristic for patterns that often cause catastrophic backtracking in JS RegExp. */
export function looksLikeRiskyRegex(pattern: string): boolean {
  return /(\([^)]*[+*][^)]*\)[+*?{]|(\(\.\*\)|\(\.\+\))[+*?{])/.test(pattern)
}

type GitignoreMatcher = {
  isIgnored: (relativePath: string, isDirectory: boolean) => boolean
}

export async function loadGitignoreMatcher(workspaceRoot: string): Promise<GitignoreMatcher> {
  let patterns: string[] = []
  try {
    const raw = await fs.readFile(join(workspaceRoot, '.gitignore'), 'utf-8')
    patterns = parseGitignoreLines(raw)
  } catch {
    /* no .gitignore */
  }
  return createGitignoreMatcher(patterns)
}

function parseGitignoreLines(raw: string): string[] {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.split('#')[0]?.trim() ?? ''
    if (!trimmed || trimmed.startsWith('!')) continue
    out.push(trimmed)
  }
  return out
}

export function createGitignoreMatcher(patterns: string[]): GitignoreMatcher {
  const normalized = patterns.map((p) => {
    if (p.endsWith('/')) return `${p}**`
    return p.includes('/') ? p : `**/${p}`
  })
  return {
    isIgnored(relativePath: string, isDirectory: boolean): boolean {
      const path = relativePath.replace(/\\/g, '/')
      const withSlash = isDirectory && !path.endsWith('/') ? `${path}/` : path
      return normalized.some((pat) =>
        micromatch.isMatch(withSlash, pat, { dot: true, contains: true }),
      )
    },
  }
}

export async function slowCodeSearch(opts: SlowCodeSearchOptions): Promise<string> {
  const compiled = compileSlowSearchMatcher(opts.pattern, opts)
  if ('error' in compiled) return compiled.error

  const gitignore = await loadGitignoreMatcher(opts.searchRoot)
  const results: string[] = []
  const visited = new Set<string>()

  await walkSearch({
    searchRoot: opts.searchRoot,
    dir: opts.searchRoot,
    depth: 0,
    matcher: compiled.matcher,
    gitignore,
    results,
    max: opts.maxResults,
    visited,
    ...(opts.fileGlob !== undefined ? { fileGlob: opts.fileGlob } : {}),
  })

  return results.length
    ? results.join('\n') + '\n[Note: ripgrep not found — results may be slower and incomplete]'
    : 'No matches found.'
}

interface WalkSearchCtx {
  searchRoot: string
  dir: string
  depth: number
  matcher: SlowSearchLineMatcher
  gitignore: GitignoreMatcher
  fileGlob?: string
  results: string[]
  max: number
  visited: Set<string>
}

async function walkSearch(ctx: WalkSearchCtx): Promise<void> {
  if (ctx.results.length >= ctx.max || ctx.depth > MAX_WALK_DEPTH) return

  const relDir = pathRelativeToSearchRoot(ctx.searchRoot, ctx.dir)
  if (relDir && ctx.gitignore.isIgnored(relDir, true)) return

  const entries = await fs.readdir(ctx.dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (ctx.results.length >= ctx.max) return
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    if (DEFAULT_IGNORED_DIRS.has(e.name)) continue

    const full = join(ctx.dir, e.name)
    const rel = pathRelativeToSearchRoot(ctx.searchRoot, full)
    const displayPath = await toRelativePath(full)

    if (e.isDirectory()) {
      if (!ctx.gitignore.isIgnored(rel, true)) {
        await walkSearch({ ...ctx, dir: full, depth: ctx.depth + 1 })
      }
      continue
    }

    if (e.isSymbolicLink()) {
      const key = await inodeKey(full)
      if (key) {
        if (ctx.visited.has(key)) continue
        ctx.visited.add(key)
      }
    }

    if (ctx.fileGlob) {
      const glob = ctx.fileGlob.includes('/') ? ctx.fileGlob : `**/${ctx.fileGlob}`
      if (!micromatch.isMatch(rel, glob, { dot: true })) continue
    }
    if (ctx.gitignore.isIgnored(rel, false)) continue

    await scanFile(full, displayPath, ctx.matcher, ctx.results, ctx.max)
  }
}

async function inodeKey(path: string): Promise<string | null> {
  try {
    const st = await fsStat(path)
    return `${String(st.dev)}:${String(st.ino)}`
  } catch {
    return null
  }
}

function pathRelativeToSearchRoot(searchRoot: string, absPath: string): string {
  const rel = relative(resolve(searchRoot), resolve(absPath))
  return rel || '.'
}

async function scanFile(
  absPath: string,
  displayPath: string,
  matcher: SlowSearchLineMatcher,
  out: string[],
  max: number,
): Promise<void> {
  if (out.length >= max) return
  try {
    const st = await fsStat(absPath)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return

    const handle = await fsOpen(absPath, 'r')
    try {
      const probe = Buffer.alloc(BINARY_PROBE_BYTES)
      const { bytesRead } = await handle.read(probe, 0, BINARY_PROBE_BYTES, 0)
      if (probe.subarray(0, bytesRead).includes(0)) return
    } finally {
      await handle.close()
    }

    const content = await fs.readFile(absPath, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (out.length >= max) break
      const line = lines[i] ?? ''
      if (matcher(line)) out.push(`${displayPath}:${String(i + 1)}: ${line.trimEnd()}`)
    }
  } catch {
    /* unreadable */
  }
}
