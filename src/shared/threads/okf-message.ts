/**
 * OKF (Open Knowledge Format) files for message prose: YAML frontmatter plus a
 * verbatim markdown body. Unlike {@link splitSkillMarkdown} in
 * `parse-skill-frontmatter.ts` — which normalizes CRLF and trims leading body
 * newlines — this split is **byte-preserving**: the body round-trips exactly, so
 * a message whose text contains `---` lines, YAML-shaped fences, CRLF, or leading
 * blank lines reconstructs 1:1 (a hard requirement, see issue #644).
 *
 * Fidelity relies on the serializer never emitting a bare `---` line inside the
 * frontmatter (all string values are quoted), so the first standalone `---` line
 * after the opening fence is always the real closing fence.
 */

export interface OkfMessageFields {
  /** OKF `type` — `Message` for conversation prose. */
  type: string
  role: string
  id: string
  createdAt: number
  threadId?: string
}

const FENCE = '---'

function yamlQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')}"`
}

function yamlUnquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  return v
}

/**
 * Serialize an OKF message file. The body is written verbatim after the closing
 * fence's newline, so it is recovered exactly by {@link parseOkfMessage}.
 */
export function serializeOkfMessage(fields: OkfMessageFields, body: string): string {
  const lines = [
    FENCE,
    `type: ${yamlQuote(fields.type)}`,
    `role: ${yamlQuote(fields.role)}`,
    `id: ${yamlQuote(fields.id)}`,
    `createdAt: ${String(fields.createdAt)}`,
    ...(fields.threadId !== undefined ? [`threadId: ${yamlQuote(fields.threadId)}`] : []),
    FENCE,
    '',
  ]
  return lines.join('\n') + body
}

export interface ParsedOkfMessage {
  fields: Record<string, string>
  body: string
}

/**
 * Split an OKF message file into frontmatter fields and the verbatim body.
 * Returns null when the leading fence is missing or unterminated.
 */
export function parseOkfMessage(raw: string): ParsedOkfMessage | null {
  const lines = raw.split('\n')
  if (lines[0] !== FENCE) return null

  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) return null

  const fields: Record<string, string> = {}
  for (const line of lines.slice(1, closeIndex)) {
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    if (key) fields[key] = yamlUnquote(line.slice(sep + 1))
  }

  // The body is everything after the newline that follows the closing fence.
  // `split('\n').join('\n')` is an identity, so this is byte-exact.
  const body = lines.slice(closeIndex + 1).join('\n')
  return { fields, body }
}
