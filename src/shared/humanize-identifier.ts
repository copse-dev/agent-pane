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

function casedWord(word: string, leading: boolean): string {
  const canonical = CANONICAL_WORDS.get(word)
  if (canonical !== undefined) return canonical
  const hyphenated = word.split('-')
  if (hyphenated.length > 1) {
    return hyphenated.map((part, index) => casedWord(part, leading && index === 0)).join('-')
  }
  return leading ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

/**
 * Turn a machine identifier (`launch_gui_app`, `gh_pr_create`,
 * `copse.post-turn-review` minus its namespace, `getFileContents`) into a
 * sentence-case label: only the first word capitalised, known acronyms and
 * product names in their canonical spelling ("Launch GUI app", "GitHub PR
 * create"), and a trailing `md` read as the Markdown file it names
 * (`agents-md` → "AGENTS.md").
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
    } else if (previous !== undefined && word === 'md') {
      // Markdown instruction files are conventionally upper case: AGENTS.md, CLAUDE.md.
      merged[merged.length - 1] = `${previous.toUpperCase()}.md`
    } else {
      merged.push(word)
    }
  }
  return merged.map((word, index) => casedWord(word, index === 0)).join(' ')
}
