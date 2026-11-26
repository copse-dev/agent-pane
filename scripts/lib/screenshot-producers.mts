/**
 * Which reference-screenshot filenames a source file can produce.
 *
 * The rule is deliberately lenient: any quoted PNG literal counts, so a spec
 * that builds the path through a helper or a join() still owns its shot. A
 * template literal counts by its static parts (pane-popout-${mode}.png owns
 * every pane-popout-<x>.png). A template with no static prefix (${NAME}.png)
 * would own everything, so it instead owns <literal>.png for each plain string
 * literal in the same file; the env-selected markdown-ordered-list-{before,
 * after} captures resolve that way. (The examples stay unquoted: the producer
 * check scans scripts/ too.)
 *
 * scripts/screenshot-producers.test.ts holds every committed shot to it, and the
 * test oracle uses it for browser demo specs, whose local capture helpers and
 * per-theme template names extractSpecScreenshots cannot read.
 */

/** Quoted string literals on one line, in source order. */
function stringLiterals(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/(['"`])((?:(?!\1)[^\n\\])*)\1/g)) {
    if (m[2] !== undefined) out.push(m[2])
  }
  return out
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Filename patterns a source file can produce (see the module comment). */
export function producerPatterns(src: string): RegExp[] {
  const literals = stringLiterals(src)
  const patterns: RegExp[] = []
  // This helper writes the named first view and at most seven continuation
  // views. Only its actual filename argument owns these bounded suffixes;
  // importing the helper must not grant ownership to unrelated PNG literals.
  for (const m of src.matchAll(
    /\bsaveSettingsSection\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`|[A-Z][A-Z0-9_]*)\s*,\s*['"`]([\w-]+)\.png['"`]/g,
  )) {
    if (m[1] !== undefined) patterns.push(new RegExp(`^${escapeRegExp(m[1])}-page-[2-8]\\.png$`))
  }
  let ownsFileLiterals = false
  for (const literal of literals) {
    if (!literal.endsWith('.png')) continue
    const name = literal.slice(literal.lastIndexOf('/') + 1)
    const parts = name.split(/\$\{[^}]*\}/)
    if (parts[0] === '') {
      ownsFileLiterals = true
      continue
    }
    patterns.push(new RegExp(`^${parts.map(escapeRegExp).join('[\\w.-]+')}$`))
  }
  if (ownsFileLiterals) {
    for (const literal of literals) {
      if (/^[\w-]+$/.test(literal)) patterns.push(new RegExp(`^${escapeRegExp(literal)}\\.png$`))
    }
  }
  return patterns
}
