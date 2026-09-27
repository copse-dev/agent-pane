/**
 * Words with a canonical spelling that sentence casing must not flatten —
 * acronyms, initialisms, and product names. Keys are lower case.
 */
const CANONICAL_WORDS: ReadonlyMap<string, string> = new Map([
  ['acp', 'ACP'],
  ['api', 'API'],
  ['ci', 'CI'],
  ['cli', 'CLI'],
  ['css', 'CSS'],
  ['devtools', 'DevTools'],
  ['gh', 'GitHub'],
  ['github', 'GitHub'],
  ['gui', 'GUI'],
  ['html', 'HTML'],
  ['http', 'HTTP'],
  ['id', 'ID'],
  ['ids', 'IDs'],
  ['json', 'JSON'],
  ['llm', 'LLM'],
  ['macos', 'macOS'],
  ['mcp', 'MCP'],
  ['okf', 'OKF'],
  ['pdf', 'PDF'],
  ['pii', 'PII'],
  ['pr', 'PR'],
  ['prs', 'PRs'],
  ['sdk', 'SDK'],
  ['ssh', 'SSH'],
  ['ui', 'UI'],
  ['url', 'URL'],
  ['urls', 'URLs'],
  ['vnc', 'VNC'],
])

/**
 * Adjacent words that form one hyphenated compound in prose. An identifier
 * cannot say whether its separator was a hyphen or a space, so the compounds
 * user copy spells with a hyphen are listed here (`post-turn-review` →
 * "Post-turn review", matching how its description reads).
 */
const HYPHENATED_COMPOUNDS: ReadonlySet<string> = new Set([
  'built-in',
  'follow-up',
  'long-horizon',
  'post-turn',
  'pre-turn',
  'read-only',
  'sign-in',
])

/**
 * Stems of the Markdown instruction files an identifier can name, which are
 * conventionally upper case (`agents-md` → "AGENTS.md"). Only these merge with a
 * following `md`, so an ordinary word before it (`get_md`) stays a word.
 */
const MARKDOWN_FILE_STEMS: ReadonlySet<string> = new Set(['agents', 'claude'])

function casedWord(word: string, leading: boolean): string {
  const canonical = CANONICAL_WORDS.get(word)
  if (canonical !== undefined) return canonical
  // Punctuation around a word (`mcp:` in "MCP: tool") must not hide it from
  // the canonical spellings.
  const [, before = '', core = '', after = ''] =
    /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(word) ?? []
  if (core && (before || after)) return `${before}${casedWord(core, leading)}${after}`
  for (const separator of ['-', ':']) {
    const parts = word.split(separator)
    if (parts.length > 1) {
      return parts.map((part, index) => casedWord(part, leading && index === 0)).join(separator)
    }
  }
  return leading ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

/**
 * Turn a machine identifier (`launch_gui_app`, `gh_pr_create`,
 * `copse.post-turn-review` minus its namespace, `getFileContents`) into a
 * sentence-case label: only the first word capitalised, known acronyms and
 * product names in their canonical spelling ("Launch GUI app", "GitHub PR
 * create"), and a known instruction-file stem followed by `md` read as the
 * Markdown file it names (`agents-md` → "AGENTS.md").
 */
export function humanizeIdentifier(identifier: string): string {
  const words = identifier
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
  if (words.length === 0) return identifier

  const merged: string[] = []
  for (const word of words) {
    const previous = merged.at(-1)
    if (previous !== undefined && HYPHENATED_COMPOUNDS.has(`${previous}-${word}`)) {
      merged[merged.length - 1] = `${previous}-${word}`
    } else if (previous !== undefined && word === 'md' && MARKDOWN_FILE_STEMS.has(previous)) {
      merged[merged.length - 1] = `${previous.toUpperCase()}.md`
    } else {
      merged.push(word)
    }
  }
  return merged.map((word, index) => casedWord(word, index === 0)).join(' ')
}
