import { z } from 'zod'
import type { ToolDefinition } from '@shared/types'
import { classifySearchQuery } from '@shared/agent/search-routing.ts'
import { getWorkspaceRoot, resolveWorkspacePath } from '../services/workspace.ts'
import { isRgAvailable } from '../services/tool-availability.ts'
import { formatCodeSearchResults, searchCodeContent } from '../services/indexed-grep.ts'
import { executeSemanticMcpSearch } from '../services/semantic-search.ts'
import type { ToolRegistry } from '../services/tool-registry.ts'

export function createSearchCodebaseTool(registry: ToolRegistry): ToolDefinition {
  return {
    name: 'search_codebase',
    description:
      'Search the codebase by regex or by meaning. Auto mode picks regex for symbols/strings and semantic MCP search for conceptual questions.',
    parameters: z.object({
      query: z
        .string()
        .describe('Search text — regex pattern, symbol name, or natural-language question'),
      mode: z
        .enum(['auto', 'regex', 'semantic'])
        .optional()
        .default('auto')
        .describe(
          'auto: infer from query; regex: indexed grep/ripgrep; semantic: MCP semantic index',
        ),
      path: z.string().optional().describe('Subdirectory to search in (regex mode only)'),
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

      if (resolvedMode === 'semantic') {
        const semantic = await executeSemanticMcpSearch(registry, query, signal)
        if (semantic !== null) {
          return `[semantic search]\n${semantic}`
        }
        if (mode === 'semantic') {
          return 'Semantic search unavailable. Install and enable a semantic MCP server (see mcp.json.example), or retry with mode: regex.'
        }
      }

      if (!isRgAvailable()) {
        return 'Regex search unavailable: ripgrep (rg) not found on PATH.'
      }

      const searchRoot = path ? resolveWorkspacePath(path) : root
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
  }
}
