export interface ReadFilePageMeta {
  path: string
  totalLines: number
  startLine: number
  endLine: number
  truncated: boolean
  nextStartLine: number | null
}

export function buildReadFilePageMeta(
  path: string,
  totalLines: number,
  startLine: number,
  endLine: number,
  truncated: boolean,
): ReadFilePageMeta {
  return {
    path,
    totalLines,
    startLine,
    endLine,
    truncated,
    nextStartLine: truncated && endLine < totalLines ? endLine + 1 : null,
  }
}

export function formatReadFilePageFooter(meta: ReadFilePageMeta, charTruncated: boolean): string {
  if (!meta.truncated && !charTruncated) return ''
  const lines: string[] = []
  if (meta.truncated) {
    lines.push(
      `[Showing lines ${meta.startLine}–${meta.endLine} of ${meta.totalLines}. Call read_file again with start_line=${meta.nextStartLine ?? meta.endLine + 1} to continue.]`,
    )
  }
  if (charTruncated) {
    lines.push(`[Output truncated by character limit. Use a narrower start_line/end_line range.]`)
  }
  lines.push(`[read_file_page ${JSON.stringify(meta)}]`)
  return `\n\n${lines.join('\n')}`
}
