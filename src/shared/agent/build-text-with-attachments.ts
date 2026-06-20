export interface FileAttachment {
  path: string
  content: string
}

export interface TextBlockAttachment {
  label: string
  content: string
}

/** Minimum pasted plain-text length to treat as an attachment instead of inline input. */
export const TEXT_BLOCK_MIN_CHARS = 200

export function isTextBlockAttachment(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return trimmed.includes('\n') || trimmed.length >= TEXT_BLOCK_MIN_CHARS
}

export function textBlockLabel(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? 'Pasted text'
  return firstLine.length > 48 ? `${firstLine.slice(0, 45)}…` : firstLine
}

export function buildTextWithAttachments(
  text: string,
  files: FileAttachment[],
  textBlocks: TextBlockAttachment[] = [],
): string {
  const blocks = [
    ...files.map((f) => `\`\`\`\n// ${f.path}\n${f.content}\n\`\`\``),
    ...textBlocks.map((b) => `\`\`\`\n// ${b.label}\n${b.content}\n\`\`\``),
  ]
  return [text, ...blocks].filter(Boolean).join('\n\n')
}
