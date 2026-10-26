/**
 * Extract bundle-relative file references from a skill's SKILL.md.
 *
 * A SKILL.md commonly points at sibling files under its own bundle —
 * `references/patterns.md`, `scripts/setup.sh`, `assets/logo.png` — either as a
 * markdown link or as a bare/backticked path in prose. Matching is limited to
 * the three directories `read_skill` itself documents (scripts/, references/,
 * assets/) plus `playbooks/` (the pstack layout), which keeps it deterministic
 * and free of false positives from unrelated slash-separated text.
 *
 * Only paths with a file extension are kept, so a prose mention of the
 * `references/` directory in general (no filename) is not treated as a
 * reference to a specific missing file.
 */

const REFERENCE_RE = /(?:^|[\s(`'"[])((?:references|scripts|assets|playbooks)\/[^\s)`'"\]]+)/g

/** Strip trailing sentence/markdown punctuation a bare-text match may have swept up. */
function trimTrailingPunctuation(path: string): string {
  return path.replace(/[.,;:!?)]+$/, '')
}

/** Globs and angle-bracket alternatives document a family of files, not one bundle member. */
function isTemplateReference(path: string): boolean {
  return /[*?{}<>|]/.test(path)
}

/** Fenced TSV audit records describe evidence; operational tables still name bundle files. */
export function skillSupportingReferenceText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replace(
      /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/g,
      (block: string, _start: string, _fence: string, body: string) => {
        const rows = body.split(/\r?\n/).filter((row) => row.trim().length > 0)
        const header = rows[0]?.split('\t') ?? []
        const columns = header.map((field) => field.toLowerCase())
        const auditLog =
          header.length >= 3 &&
          header.every((field) => /^[a-z][\w -]*$/i.test(field)) &&
          (columns.includes('ts') || columns.includes('timestamp')) &&
          columns.includes('evidence') &&
          columns.includes('result') &&
          rows.length > 1 &&
          rows.slice(1).every((row) => row.split('\t').length === header.length)
        return auditLog ? '\n' : block
      },
    )
}

/** Unique bundle-relative file paths referenced in the text, sorted. */
export function extractSkillFileReferences(text: string): string[] {
  const paths = new Set<string>()
  for (const match of skillSupportingReferenceText(text).matchAll(REFERENCE_RE)) {
    const raw = match[1]
    if (!raw) continue
    const trimmed = trimTrailingPunctuation(raw)
    if (!/\.[A-Za-z0-9]+$/.test(trimmed)) continue
    if (isTemplateReference(trimmed)) continue
    paths.add(trimmed)
  }
  return [...paths].sort()
}
