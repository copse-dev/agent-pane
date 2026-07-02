/** Decode entities introduced when mermaid source is embedded in HTML. */
export function decodeMermaidHtmlEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export function normalizeMermaidTypography(source: string): string {
  return source
    .replace(/\u201c|\u201d/g, '"')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\r\n/g, '\n')
}

/** True when Mermaid needs a quoted `[...]` label (common LLM output). */
function labelNeedsQuotes(label: string): boolean {
  if (/[()]/.test(label)) return true
  if (/[+/:,&#|]/.test(label)) return true
  if (/[^\w \t.-]/.test(label)) return true
  return false
}

/**
 * Quote square-bracket labels that break Mermaid's lexer. LLMs often emit
 * `Node[Renderer (20+ modules)]`, `md[markdown/mermaid]`, etc.
 * Skips stadium/subroutine shapes like `A[(text)]` where `[` is followed by `(`.
 */
export function stabilizeMermaidSource(source: string): string {
  return source.replace(
    /^(\s*(?:subgraph\s+)?[\w-]+)\[([^\]"(][^\]]*)\]/gm,
    (match, prefix: string, label: string) => {
      if (label.startsWith('(')) return match
      if (!labelNeedsQuotes(label)) return match
      const safe = label.replace(/"/g, "'")
      return `${prefix}["${safe}"]`
    },
  )
}

/** Last-resort: quote every unquoted `[label]` except stadium nodes. */
export function stabilizeMermaidSourceAggressive(source: string): string {
  return source.replace(
    /^(\s*(?:subgraph\s+)?[\w-]+)\[([^\]"(][^\]]*)\]/gm,
    (match, prefix: string, label: string) => {
      if (label.startsWith('(')) return match
      const safe = label.replace(/"/g, "'")
      return `${prefix}["${safe}"]`
    },
  )
}

export function prepareMermaidSource(raw: string): string {
  const normalized = normalizeMermaidTypography(decodeMermaidHtmlEntities(raw).trimEnd())
  return stabilizeMermaidSource(normalized)
}

export function mermaidSourceCandidates(raw: string): string[] {
  const normalized = normalizeMermaidTypography(decodeMermaidHtmlEntities(raw).trimEnd())
  const gentle = stabilizeMermaidSource(normalized)
  const aggressive = stabilizeMermaidSourceAggressive(stabilizeMermaidSource(normalized))
  return [...new Set([gentle, aggressive].filter(Boolean))]
}
