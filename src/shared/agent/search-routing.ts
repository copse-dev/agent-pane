export type SearchQueryMode = 'regex' | 'semantic'

const REGEX_METACHAR_RE = /[.*+?^${}()|[\]\\]/
const IDENTIFIER_RE = /^[A-Za-z_$][\w$.]*$/
const IMPORT_PATH_RE = /^[\w./-]+\.(ts|tsx|js|jsx|py|go|rs)$/

const QUESTION_STARTERS = [
  'where',
  'how',
  'what',
  'why',
  'when',
  'which',
  'find',
  'explain',
  'describe',
  'show me',
]

/** Classify a codebase search query for tool routing (regex vs semantic). */
export function classifySearchQuery(query: string): SearchQueryMode {
  const trimmed = query.trim()
  if (!trimmed) return 'regex'

  if (REGEX_METACHAR_RE.test(trimmed)) return 'regex'
  if (IDENTIFIER_RE.test(trimmed)) return 'regex'
  if (IMPORT_PATH_RE.test(trimmed)) return 'regex'
  if (trimmed.includes('import ') || trimmed.includes('from ')) return 'regex'

  const lower = trimmed.toLowerCase()
  const wordCount = trimmed.split(/\s+/).length
  if (wordCount >= 3 && QUESTION_STARTERS.some((q) => lower.startsWith(q))) return 'semantic'
  if (wordCount >= 4) return 'semantic'

  return 'regex'
}

export function buildSearchRoutingPromptBlock(nativeAvailable = false): string {
  const semanticLine = nativeAvailable
    ? '- Concept or behavior questions → search_codebase (auto/semantic) or semantic_search, then search_code for exact strings'
    : '- Concept or behavior questions → search_code with descriptive keywords, then read likely files'

  return `

## Code search routing

Match Cursor-style hybrid search: combine fast regex with semantic retrieval when available.

- Exact symbol, import, string, or filename → find_files / search_code (regex)
${semanticLine}
- After semantic results, follow up with search_code to trace references and confirm details
- Do not repeat the same search with minor variations`
}

export function buildExploreSearchRoutingAddon(nativeAvailable = false): string {
  return buildSearchRoutingPromptBlock(nativeAvailable).trim()
}
