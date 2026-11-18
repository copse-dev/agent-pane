import * as fs from 'node:fs/promises'
import { stat as fsStat, open as fsOpen } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { boundedGlobMatcher, GLOB_TIMEOUT_HINT, type BoundedGlobMatcher } from './bounded-glob.ts'
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

interface GitignoreEntry {
  relativePath: string
  isDirectory: boolean
}

type GitignoreMatcher = {
  /** One result per entry, matched in a single bounded call. */
  ignoredEach: (entries: readonly GitignoreEntry[]) => boolean[]
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

/**
 * `.gitignore` lines come from the repository, so they are matched under a time
 * budget (see `bounded-glob.ts`): per call, and for the whole walk. Once the
 * patterns blow either, the matcher stops filtering for the rest of the walk:
 * the search reads more files instead of paying the budget again for every
 * directory.
 */
export function createGitignoreMatcher(patterns: string[]): GitignoreMatcher {
  const normalized = patterns.map((p) => {
    if (p.endsWith('/')) return `${p}**`
    return p.includes('/') ? p : `**/${p}`
  })
  if (normalized.length === 0) {
    return { ignoredEach: (entries) => entries.map(() => false), isIgnored: () => false }
  }
  const matches = boundedGlobMatcher(normalized, { dot: true, contains: true })
  let overBudget = false
  const ignoredEach = (entries: readonly GitignoreEntry[]): boolean[] => {
    const none = entries.map(() => false)
    if (overBudget) return none
    const result = matches(
      entries.map(({ relativePath, isDirectory }) => {
        const path = relativePath.replace(/\\/g, '/')
        return isDirectory && !path.endsWith('/') ? `${path}/` : path
      }),
    )
    if (result !== 'timeout') return result
    overBudget = true
    console.warn('[slow-code-search] .gitignore patterns ran past their budget — not applied')
    return none
  }
  return {
    ignoredEach,
    isIgnored: (relativePath, isDirectory) =>
      ignoredEach([{ relativePath, isDirectory }])[0] ?? false,
  }
}

export async function slowCodeSearch(opts: SlowCodeSearchOptions): Promise<string> {
  const compiled = compileSlowSearchMatcher(opts.pattern, opts)
  if ('error' in compiled) return compiled.error

  const gitignore = await loadGitignoreMatcher(opts.searchRoot)
  const results: string[] = []
  const visited = new Set<string>()
  const fileGlob = opts.fileGlob ? compileFileGlob(opts.fileGlob) : undefined

  try {
    await walkSearch({
      searchRoot: opts.searchRoot,
      dir: opts.searchRoot,
      depth: 0,
      matcher: compiled.matcher,
      gitignore,
      results,
      max: opts.maxResults,
      visited,
      ...(fileGlob !== undefined ? { fileGlob } : {}),
    })
  } catch (error) {
    if (error instanceof FileGlobTimeout) return GLOB_TIMEOUT_HINT
    throw error
  }

  return results.length
    ? results.join('\n') + '\n[Note: ripgrep not found — results may be slower and incomplete]'
    : 'No matches found.'
}

/** The model's `file_glob` blew its budget; the search stops with a hint. */
class FileGlobTimeout extends Error {}

function compileFileGlob(fileGlob: string): BoundedGlobMatcher {
  return boundedGlobMatcher(fileGlob.includes('/') ? fileGlob : `**/${fileGlob}`, { dot: true })
}

interface WalkSearchCtx {
  searchRoot: string
  dir: string
  depth: number
  matcher: SlowSearchLineMatcher
  gitignore: GitignoreMatcher
  fileGlob?: BoundedGlobMatcher
  results: string[]
  max: number
  visited: Set<string>
}

async function walkSearch(ctx: WalkSearchCtx): Promise<void> {
  if (ctx.results.length >= ctx.max || ctx.depth > MAX_WALK_DEPTH) return

  // Subdirectories were already checked against `.gitignore` by their parent.
  if (ctx.depth === 0) {
    const relDir = pathRelativeToSearchRoot(ctx.searchRoot, ctx.dir)
    if (relDir && ctx.gitignore.isIgnored(relDir, true)) return
  }

  const dirents = await fs.readdir(ctx.dir, { withFileTypes: true }).catch(() => [])
  const entries = dirents
    .filter(
      (e) =>
        !e.name.startsWith('.') && e.name !== 'node_modules' && !DEFAULT_IGNORED_DIRS.has(e.name),
    )
    .map((e) => {
      const full = join(ctx.dir, e.name)
      return { e, full, rel: pathRelativeToSearchRoot(ctx.searchRoot, full) }
    })
  // Match the whole directory in one call per matcher: each call starts a
  // watchdog, and both matchers also have a budget for the whole walk.
  const ignored = ctx.gitignore.ignoredEach(
    entries.map(({ e, rel }) => ({ relativePath: rel, isDirectory: e.isDirectory() })),
  )
  // `file_glob` only ever filters files, so directories are not matched.
  const fileRels = entries.flatMap(({ e, rel }) => (e.isDirectory() ? [] : [rel]))
  const globHits = ctx.fileGlob?.(fileRels)
  if (globHits === 'timeout') throw new FileGlobTimeout()
  const inGlob = globHits && new Set(fileRels.filter((_, i) => globHits[i]))

  for (const [index, { e, full, rel }] of entries.entries()) {
    if (ctx.results.length >= ctx.max) return

    if (e.isDirectory()) {
      if (!ignored[index]) {
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

    if (inGlob && !inGlob.has(rel)) continue
    if (ignored[index]) continue

    await scanFile(full, await toRelativePath(full), ctx.matcher, ctx.results, ctx.max)
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
