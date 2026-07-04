import { z } from 'zod'
import { defineTool } from '@shared/types'
import { classifySearchQuery } from '@shared/agent/search-routing.ts'
import {
  getWorkspaceRoot,
  resolveWorkspacePath,
  resolveReadablePath,
  toRelativePath,
} from '../services/workspace.ts'
import { isRgAvailable } from '../services/tool-availability.ts'
import { formatCodeSearchResults, searchCodeContent } from '../services/indexed-grep.ts'
import { executeSemanticSearch } from '../services/semantic-search.ts'

export const searchCodebaseTool = defineTool({
  name: 'search_codebase',
  description:
    'Search the codebase by regex or by meaning. Auto mode picks regex for symbols/strings and native semantic search for conceptual questions.',
  parameters: z.object({
    query: z
      .string()
      .describe('Search text — regex pattern, symbol name, or natural-language question'),
    mode: z
      .enum(['auto', 'regex', 'semantic'])
      .optional()
      .default('auto')
      .describe(
        'auto: infer from query; regex: indexed grep/ripgrep; semantic: native codesearch/vera',
      ),
    path: z
      .string()
      .optional()
      .describe('Subdirectory scope (regex root or semantic filter prefix)'),
    file_glob: z.string().optional().describe('Glob filter, e.g. "*.ts" (regex mode only)'),
    fixed_string: z
      .boolean()
      .optional()
      .default(false)
      .describe('Treat query as literal text (regex mode only)'),
    case_sensitive: z
      .boolean()
      .optional()
      .default(false)
      .describe('Case-sensitive match (regex mode)'),
    max_results: z.number().int().min(1).max(500).optional().default(50),
  }),
  async execute(
    { query, mode, path, file_glob, fixed_string, case_sensitive, max_results },
    signal,
  ) {
    const root = getWorkspaceRoot()
    if (!root) return 'No workspace open.'

    const resolvedMode = mode === 'auto' ? classifySearchQuery(query) : mode
    const filterPath = path ? toRelativePath(resolveWorkspacePath(path)) : undefined

    if (resolvedMode === 'semantic') {
      const semantic = await executeSemanticSearch(
        {
          query,
          maxResults: max_results,
          ...(filterPath ? { filterPath } : {}),
        },
        signal,
      )
      if (semantic !== null) {
        return `[native semantic search]\n${semantic.text}`
      }
      if (mode === 'semantic') {
        return (
          'Semantic search unavailable. Bundled codesearch failed to install or vera/codesearch ' +
          'is missing on PATH (see README.md), or retry with mode: regex.'
        )
      }
    }

    if (!isRgAvailable()) {
      return 'Regex search unavailable: ripgrep (rg) not found on PATH.'
    }

    // Regex path resolves the read-only chat store too (#644); the semantic index
    // below stays workspace-only (chat-store discovery goes through catalog.jsonl).
    const searchRoot = path ? resolveReadablePath(path) : root
    const { lines, backend } = await searchCodeContent({
      pattern: query,
      searchRoot,
      fixedString: fixed_string,
      caseSensitive: case_sensitive,
      fileGlob: file_glob,
      maxResults: max_results,
      signal,
    })

    const header =
      resolvedMode === 'semantic'
        ? '[semantic search unavailable — regex fallback]\n'
        : '[regex search]\n'
    return header + formatCodeSearchResults(lines, max_results, backend)
  },
})

export const semanticSearchTool = defineTool({
  name: 'semantic_search',
  description:
    'Search the codebase by meaning using a local semantic index (codesearch or vera CLI). Use for conceptual questions.',
  parameters: z.object({
    query: z.string().describe('Natural-language question about code behavior or architecture'),
    path: z.string().optional().describe('Optional subdirectory scope'),
    max_results: z.number().int().min(1).max(100).optional().default(20),
  }),
  async execute({ query, path, max_results }, signal) {
    const root = getWorkspaceRoot()
    if (!root) return 'No workspace open.'

    const filterPath = path ? toRelativePath(resolveWorkspacePath(path)) : undefined
    const semantic = await executeSemanticSearch(
      {
        query,
        maxResults: max_results,
        ...(filterPath ? { filterPath } : {}),
      },
      signal,
    )
    if (semantic === null) {
      return (
        'Semantic search unavailable. Bundled codesearch failed to install or vera/codesearch ' +
        'is missing on PATH (see README.md).'
      )
    }

    return `[native semantic search]\n${semantic.text}`
  },
})
