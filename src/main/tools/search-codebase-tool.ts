import { z } from 'zod'
import { defineTool } from '@shared/types'
import { classifySearchQuery, resolveSearchText } from '@shared/agent/search-routing.ts'
import {
  getWorkspaceRoot,
  resolveWorkspacePath,
  resolveReadablePath,
  toRelativePath,
} from '../services/workspace.ts'
import { isRgAvailable } from '../services/tool-availability.ts'
import { formatCodeSearchResults, searchCodeContent } from '../services/search/indexed-grep.ts'
import {
  executeSemanticSearch,
  semanticIndexBuildingNote,
} from '../services/search/semantic-search.ts'

export const searchCodebaseTool = defineTool({
  name: 'search_codebase',
  description:
    'Search the codebase by regex or by meaning. Auto mode picks regex for symbols/strings and native semantic search for conceptual questions.',
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe('Search text — regex pattern, symbol name, or natural-language question'),
    // Undocumented fallback: search_code uses `pattern`, and smaller models
    // routinely pass that name here. Accepted but deliberately not described.
    pattern: z.string().optional(),
    mode: z
      .enum(['auto', 'regex', 'semantic'])
      .optional()
      .default('auto')
      .describe(
        'auto: infer from query; regex: indexed grep/ripgrep; semantic: native gortex/vera',
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
    { query, pattern, mode, path, file_glob, fixed_string, case_sensitive, max_results },
    signal,
  ) {
    const root = getWorkspaceRoot()
    if (!root) return 'No workspace open.'

    const searchText = resolveSearchText(query, pattern)
    if (searchText === undefined) {
      return 'Provide a search query via `query` (its alias `pattern` also works).'
    }

    const resolvedMode = mode === 'auto' ? classifySearchQuery(searchText) : mode
    const filterPath = path ? toRelativePath(resolveWorkspacePath(path)) : undefined

    let semanticFallback: 'building' | 'unavailable' | null = null
    if (resolvedMode === 'semantic') {
      const semantic = await executeSemanticSearch(
        {
          query: searchText,
          maxResults: max_results,
          ...(filterPath ? { filterPath } : {}),
        },
        signal,
      )
      if (semantic.status === 'ok') {
        return `[native semantic search]\n${semantic.text}`
      }
      if (mode === 'semantic') {
        return semantic.status === 'building'
          ? semanticIndexBuildingNote()
          : 'Semantic search unavailable. Bundled gortex failed to install or ' +
              'gortex/vera is missing on PATH (see README.md), or retry with mode: regex.'
      }
      semanticFallback = semantic.status
    }

    if (!isRgAvailable()) {
      return 'Regex search unavailable: ripgrep (rg) not found on PATH.'
    }

    // Regex path resolves the read-only chat store too (#644); the semantic index
    // below stays workspace-only (chat-store discovery goes through catalog.jsonl).
    const searchRoot = path ? resolveReadablePath(path) : root
    const { lines, backend } = await searchCodeContent({
      pattern: searchText,
      searchRoot,
      fixedString: fixed_string,
      caseSensitive: case_sensitive,
      fileGlob: file_glob,
      maxResults: max_results,
      signal,
    })

    const header =
      semanticFallback === 'building'
        ? '[semantic index still building — regex fallback]\n'
        : semanticFallback === 'unavailable'
          ? '[semantic search unavailable — regex fallback]\n'
          : '[regex search]\n'
    return header + formatCodeSearchResults(lines, max_results, backend)
  },
})

export const semanticSearchTool = defineTool({
  name: 'semantic_search',
  description:
    'Search the codebase by meaning using a local semantic index (gortex or vera CLI). Use for conceptual questions.',
  parameters: z.object({
    query: z
      .string()
      .optional()
      .describe('Natural-language question about code behavior or architecture'),
    // Undocumented fallback: accepted but deliberately not described.
    pattern: z.string().optional(),
    path: z.string().optional().describe('Optional subdirectory scope'),
    max_results: z.number().int().min(1).max(100).optional().default(20),
  }),
  async execute({ query, pattern, path, max_results }, signal) {
    const root = getWorkspaceRoot()
    if (!root) return 'No workspace open.'

    const searchText = resolveSearchText(query, pattern)
    if (searchText === undefined) {
      return 'Provide a query via `query` (its alias `pattern` also works).'
    }

    const filterPath = path ? toRelativePath(resolveWorkspacePath(path)) : undefined
    const semantic = await executeSemanticSearch(
      {
        query: searchText,
        maxResults: max_results,
        ...(filterPath ? { filterPath } : {}),
      },
      signal,
    )
    if (semantic.status === 'building') {
      return semanticIndexBuildingNote()
    }
    if (semantic.status === 'unavailable') {
      return (
        'Semantic search unavailable. Bundled gortex failed to install or ' +
        'gortex/vera is missing on PATH (see README.md).'
      )
    }

    return `[native semantic search]\n${semantic.text}`
  },
})
