import { z } from 'zod'
import micromatch from 'micromatch'
import { defineTool } from '@shared/types'
import { resolveWorkspacePath, getWorkspaceRoot } from '../services/workspace.ts'
import { isRgAvailable } from '../services/tool-availability.ts'
import { getIndex } from '../services/file-index.ts'
import { formatCodeSearchResults, searchCodeContent } from '../services/indexed-grep.ts'
import { slowCodeSearch } from '../services/slow-code-search.ts'

export const searchCodeTool = defineTool({
  name: 'search_code',
  description:
    'Search for a text pattern or regex in the workspace. Uses a local content index when available (ig/trigrep), otherwise ripgrep (respects .gitignore). Without ripgrep, a bounded workspace walk applies .gitignore, glob, and case options. Returns matching lines with file:line format.',
  parameters: z.object({
    pattern: z.string().describe('Search pattern (regex by default)'),
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
    { pattern, path, file_glob, fixed_string, case_sensitive, max_results, context_lines },
    signal,
  ) {
    const root = getWorkspaceRoot()
    if (!root) return 'No workspace open.'
    const searchRoot = path ? resolveWorkspacePath(path) : root

    if (!isRgAvailable()) {
      return slowCodeSearch({
        searchRoot,
        pattern,
        maxResults: max_results,
        fixedString: fixed_string,
        caseSensitive: case_sensitive,
        fileGlob: file_glob,
      })
    }

    const { lines, backend } = await searchCodeContent({
      pattern,
      searchRoot,
      fixedString: fixed_string,
      caseSensitive: case_sensitive,
      fileGlob: file_glob,
      maxResults: max_results,
      contextLines: context_lines,
      signal,
    })

    return formatCodeSearchResults(lines, max_results, backend)
  },
})

export const findFilesTool = defineTool({
  name: 'find_files',
  description: 'Find files in the workspace by name or glob pattern. Fast — uses pre-built index.',
  parameters: z.object({
    pattern: z
      .string()
      .describe('Filename or glob. Examples: "*.ts", "package.json", "src/**/*service*"'),
    max_results: z.number().int().min(1).max(200).optional().default(50),
  }),
  execute({ pattern, max_results }) {
    const idx = getIndex()
    if (!idx) return 'File index not available. Try opening the workspace again.'
    // Take one extra so we can tell "exactly max_results total" from "more were dropped".
    const found = micromatch(idx.paths, pattern).slice(0, max_results + 1)
    if (found.length === 0) return `No files match: ${pattern}`
    const truncated = found.length > max_results
    const matches = truncated ? found.slice(0, max_results) : found
    return matches.join('\n') + (truncated ? `\n[Truncated at ${String(max_results)}]` : '')
  },
})
