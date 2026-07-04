import { runCommand } from '../exec/command-runner.ts'
import { toRelativePath } from '../workspace.ts'
import { safeJsonParse } from '@shared/safe-json.ts'

export type IndexedGrepBackend = 'ig' | 'trigrep' | 'instant-grep' | 'rg'

export interface CodeContentSearchOptions {
  pattern: string
  searchRoot: string
  fixedString?: boolean
  caseSensitive?: boolean
  fileGlob?: string | undefined
  maxResults: number
  /** Lines of surrounding context to show around each match (rg -C). */
  contextLines?: number
  signal?: AbortSignal
}

let activeBackend: IndexedGrepBackend = 'rg'

export function getIndexedGrepBackend(): IndexedGrepBackend {
  return activeBackend
}

export async function probeIndexedGrepBackends(): Promise<IndexedGrepBackend> {
  const candidates: Array<{ cmd: string; backend: IndexedGrepBackend; args: string[] }> = [
    { cmd: 'ig', backend: 'ig', args: ['--version'] },
    { cmd: 'trigrep', backend: 'trigrep', args: ['--version'] },
    { cmd: 'instant-grep', backend: 'instant-grep', args: ['--version'] },
  ]

  for (const { cmd, backend, args } of candidates) {
    if (await probe(cmd, args)) {
      activeBackend = backend
      return backend
    }
  }

  activeBackend = 'rg'
  return 'rg'
}

/** Test hook — force backend without probing the PATH. */
export function setIndexedGrepBackendForTest(backend: IndexedGrepBackend | null): void {
  activeBackend = backend ?? 'rg'
}

async function probe(cmd: string, args: string[]): Promise<boolean> {
  try {
    await runCommand(cmd, args)
    return true
  } catch {
    return false
  }
}

export async function searchCodeContent(
  opts: CodeContentSearchOptions,
): Promise<{ lines: string[]; backend: IndexedGrepBackend }> {
  const backend = activeBackend
  if (backend === 'rg') {
    const lines = await searchWithRipgrep(opts)
    return { lines, backend }
  }

  try {
    const lines = await searchWithIndexedCli(backend, opts)
    return { lines, backend }
  } catch {
    const lines = await searchWithRipgrep(opts)
    return { lines, backend: 'rg' }
  }
}

async function searchWithIndexedCli(
  backend: Exclude<IndexedGrepBackend, 'rg'>,
  opts: CodeContentSearchOptions,
): Promise<string[]> {
  const args = buildIndexedCliArgs(backend, opts)
  const { stdout } = await runCommand(backend, args, opts.signal ? { signal: opts.signal } : {})
  return parseGrepStdout(stdout, opts.maxResults)
}

function buildIndexedCliArgs(
  backend: Exclude<IndexedGrepBackend, 'rg'>,
  opts: CodeContentSearchOptions,
): string[] {
  const common = [
    ...(opts.fixedString ? ['-F'] : []),
    ...(opts.caseSensitive ? [] : ['-i']),
    ...(opts.fileGlob ? ['--glob', opts.fileGlob] : []),
  ]

  switch (backend) {
    case 'ig':
      return [
        'search',
        ...common,
        '-n',
        '--no-heading',
        '--max-count',
        String(opts.maxResults),
        opts.pattern,
        opts.searchRoot,
      ]
    case 'trigrep':
      return [
        'search',
        ...common,
        '-n',
        '--max-count',
        String(opts.maxResults),
        opts.pattern,
        opts.searchRoot,
      ]
    case 'instant-grep':
      return [
        ...common,
        '-n',
        '--no-heading',
        '--max-count',
        String(opts.maxResults),
        opts.pattern,
        opts.searchRoot,
      ]
  }
}

async function searchWithRipgrep(opts: CodeContentSearchOptions): Promise<string[]> {
  const args = [
    '--line-number',
    '--no-heading',
    '--with-filename',
    '--max-count',
    String(opts.maxResults),
    '--json',
    ...(opts.contextLines && opts.contextLines > 0 ? ['--context', String(opts.contextLines)] : []),
    ...(opts.fixedString ? ['--fixed-strings'] : []),
    ...(opts.caseSensitive ? [] : ['--ignore-case']),
    ...(opts.fileGlob ? ['--glob', opts.fileGlob] : []),
    '--',
    opts.pattern,
    opts.searchRoot,
  ]

  const { stdout } = await runCommand('rg', args, opts.signal ? { signal: opts.signal } : {})
  return parseRipgrepJson(stdout, opts.maxResults)
}

export function parseRipgrepJson(stdout: string, maxResults: number): string[] {
  const entries = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => safeJsonParse<Record<string, unknown>>(line))
    .filter((entry): entry is Record<string, unknown> => entry !== null)

  // Context lines (rg --context) arrive as separate `context` events; render
  // them with a `-` separator (like rg's own output) so the model sees the
  // surrounding code, and cap by the number of *matches* rather than total
  // lines so context never eats the result budget (#122).
  const out: string[] = []
  let matchCount = 0
  for (const entry of entries) {
    const type = entry['type']
    if (type !== 'match' && type !== 'context') continue
    const data = entry['data'] as {
      path: { text: string }
      line_number: number
      lines: { text: string }
    }
    if (type === 'match') {
      if (matchCount >= maxResults) break
      matchCount++
      out.push(
        `${toRelativePath(data.path.text)}:${String(data.line_number)}: ${data.lines.text.trimEnd()}`,
      )
    } else {
      out.push(
        `${toRelativePath(data.path.text)}-${String(data.line_number)}- ${data.lines.text.trimEnd()}`,
      )
    }
  }

  return out
}

export function parseGrepStdout(stdout: string, maxResults: number): string[] {
  const lines: string[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (!line) continue
    const normalized = normalizeGrepLine(line)
    if (normalized) lines.push(normalized)
    if (lines.length >= maxResults) break
  }
  return lines
}

function normalizeGrepLine(line: string): string | null {
  const match = line.match(/^(.+?):(\d+)(?::\d+)?:\s?(.*)$/)
  if (!match) return null
  const [, file, lineNo, content] = match
  if (!file || !lineNo) return null
  return `${toRelativePath(file)}:${lineNo}: ${content ?? ''}`
}

export function formatCodeSearchResults(
  lines: string[],
  maxResults: number,
  backend: IndexedGrepBackend,
): string {
  if (lines.length === 0) return 'No matches found.'
  // Context lines (rendered with a `-N-` separator) must not count toward the
  // result cap, otherwise a few matches with context look "truncated" (#122).
  const matchLineCount = lines.filter((l) => /:\d+: /.test(l)).length || lines.length
  const suffix =
    matchLineCount >= maxResults
      ? `\n[Truncated at ${String(maxResults)} results. Narrow your search.]`
      : ''
  const backendNote = backend === 'rg' ? '' : `\n[Searched via indexed ${backend} backend.]`
  return lines.join('\n') + suffix + backendNote
}
