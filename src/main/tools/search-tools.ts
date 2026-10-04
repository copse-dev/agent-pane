import { z } from 'zod'
import micromatch from 'micromatch'
import { defineTool } from '@shared/types'
import { resolveSearchText } from '@copse/agent/search-routing.ts'
import { resolveReadablePathWithinRoot } from '../services/workspace.ts'
import { getAgentExecutionRoot } from '../services/execution-root.ts'
import { isRgAvailableForTarget } from '../services/tool-availability.ts'
import { getIndex, whenFileIndexReady } from '../services/search/file-index.ts'
import { formatCodeSearchResults, searchCodeContent } from '../services/search/indexed-grep.ts'
import { slowCodeSearch } from '../services/search/slow-code-search.ts'
import { isActiveSshWorkspace } from '../services/ssh-workspace/execution-target.ts'

export const searchCodeTool = defineTool({
  name: 'search_code',
  clampNumericRangeArgs: true,
  description:
    'Search for a text pattern or regex in the workspace. Uses a local content index when available (ig/trigrep), otherwise ripgrep (respects .gitignore). Without ripgrep, a bounded workspace walk applies .gitignore, glob, and case options. Returns matching lines with file:line format.',
  parameters: z.object({
    pattern: z.string().optional().describe('Search pattern (regex by default)'),
    // Undocumented fallback: search_codebase uses `query`, and smaller models
    // routinely pass that name here. Accepted but deliberately not described, so
    // the tool surface stays lean — see resolveSearchText below.
    query: z.string().optional(),
    path: z.string().optional().describe('Subdirectory to search in. Defaults to workspace root.'),
    file_glob: z.string().optional().describe('Glob to filter files, e.g. "*.ts"'),
    fixed_string: z.boolean().optional().default(false).describe('Treat pattern as literal string'),
    case_sensitive: z.boolean().optional().default(false),
    max_results: z.number().int().min(1).max(500).optional().default(50),
    context_lines: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .default(0)
      .describe('Lines of surrounding context to show before and after each match (like rg -C)'),
  }),
  async execute(
    { pattern, query, path, file_glob, fixed_string, case_sensitive, max_results, context_lines },
    signal,
  ) {
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    const searchPattern = resolveSearchText(pattern, query)
    if (searchPattern === undefined) {
      return 'Provide a search pattern via `pattern` (its alias `query` also works).'
    }
    const searchRoot = path ? await resolveReadablePathWithinRoot(path, root) : root

    if (!(await isRgAvailableForTarget()) && !isActiveSshWorkspace()) {
      return slowCodeSearch({
        searchRoot,
        pattern: searchPattern,
        maxResults: max_results,
        fixedString: fixed_string,
        caseSensitive: case_sensitive,
        fileGlob: file_glob,
      })
    }

    const { lines, backend } = await searchCodeContent({
      pattern: searchPattern,
      searchRoot,
      fixedString: fixed_string,
      caseSensitive: case_sensitive,
      fileGlob: file_glob,
      maxResults: max_results,
      contextLines: context_lines,
      displayRoot: root,
      signal,
    })

    if (lines.length === 0 && file_glob) {
      return explainEmptyGlobResult({
        fileGlob: file_glob,
        pattern: searchPattern,
        searchRoot,
        displayRoot: root,
        fixedString: fixed_string,
        caseSensitive: case_sensitive,
        signal,
      })
    }

    return formatCodeSearchResults(lines, max_results, backend)
  },
})

const GLOB_PROBE_MAX_RESULTS = 5

/**
 * An empty result under `file_glob` is ambiguous: the pattern may be absent, or
 * the glob may have filtered out every file that contains it. Agents read the
 * bare "No matches found." as "absent" and move on, so say which it is. The
 * probe is best-effort; a failing probe falls back to the plain message.
 */
async function explainEmptyGlobResult(opts: {
  fileGlob: string
  pattern: string
  searchRoot: string
  displayRoot: string
  fixedString: boolean
  caseSensitive: boolean
  signal: AbortSignal
}): Promise<string> {
  const lines: string[] = [`No matches found within file_glob "${opts.fileGlob}".`]
  // `|` is not alternation in a glob (brace sets are), so a `*a*|*b*` glob matches no file.
  if (opts.fileGlob.includes('|') && !opts.fileGlob.includes('{')) {
    lines.push(
      'file_glob is a glob, not a regex: `|` does not mean "or". Use braces, e.g. "{*a*,*b*}".',
    )
  }
  try {
    const probe = await searchCodeContent({
      pattern: opts.pattern,
      searchRoot: opts.searchRoot,
      fixedString: opts.fixedString,
      caseSensitive: opts.caseSensitive,
      maxResults: GLOB_PROBE_MAX_RESULTS,
      displayRoot: opts.displayRoot,
      signal: opts.signal,
    })
    const files = [
      ...new Set(
        probe.lines.flatMap((line) => {
          const match = /^(.+?):\d+: /.exec(line)
          return match?.[1] ? [match[1]] : []
        }),
      ),
    ]
    if (files.length > 0) {
      lines.push(
        `The pattern does match outside that glob (e.g. ${files.join(', ')}); retry without file_glob or widen it.`,
      )
    }
  } catch {
    // Best-effort diagnostics only.
  }
  return lines.join('\n')
}

export const findFilesTool = defineTool({
  name: 'find_files',
  clampNumericRangeArgs: true,
  description: 'Find files in the workspace by name or glob pattern. Fast — uses pre-built index.',
  parameters: z.object({
    pattern: z
      .string()
      .describe('Filename or glob. Examples: "*.ts", "package.json", "src/**/*service*"'),
    max_results: z.number().int().min(1).max(200).optional().default(50),
  }),
  async execute({ pattern, max_results }) {
    const root = getAgentExecutionRoot()
    if (!root) return 'No workspace open.'
    // Workspace/worktree open schedules the index build without blocking —
    // ride any in-flight build instead of failing during the boot window.
    await whenFileIndexReady(root)
    const idx = getIndex(root)
    if (!idx) return 'File index not available. Try opening the workspace again.'
    // Take one extra so we can tell "exactly max_results total" from "more were dropped".
    const found = micromatch(idx.paths, pattern, { basename: !pattern.includes('/') }).slice(
      0,
      max_results + 1,
    )
    if (found.length === 0) return `No files match: ${pattern}`
    const truncated = found.length > max_results
    const matches = truncated ? found.slice(0, max_results) : found
    return matches.join('\n') + (truncated ? `\n[Truncated at ${String(max_results)}]` : '')
  },
})
