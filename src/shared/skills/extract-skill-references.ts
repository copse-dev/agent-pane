/**
 * Extract bundle-relative file references from a skill's SKILL.md.
 *
 * A SKILL.md commonly points at sibling files under its own bundle —
 * `references/patterns.md`, `scripts/setup.sh`, `assets/logo.png` — either as a
 * markdown link or as a bare/backticked path in prose. Those are the three
 * directories `read_skill` itself documents (scripts/, references/, assets/),
 * so matching on them keeps this deterministic and free of false positives
 * from unrelated slash-separated text.
 *
 * Only paths with a file extension are kept, so a prose mention of the
 * `references/` directory in general (no filename) is not treated as a
 * reference to a specific missing file.
 */

const REFERENCE_RE = /(?:^|[\s(`'"[])((?:references|scripts|assets)\/[^\s)`'"\]]+)/g

/** Strip trailing sentence/markdown punctuation a bare-text match may have swept up. */
function trimTrailingPunctuation(path: string): string {
  return path.replace(/[.,;:!?)]+$/, '')
}

/** Unique bundle-relative file paths referenced in the text, sorted. */
export function extractSkillFileReferences(text: string): string[] {
  const paths = new Set<string>()
  for (const match of text.matchAll(REFERENCE_RE)) {
    const raw = match[1]
    if (!raw) continue
    const trimmed = trimTrailingPunctuation(raw)
    if (!/\.[A-Za-z0-9]+$/.test(trimmed)) continue
    paths.add(trimmed)
  }
  return [...paths].sort()
}
