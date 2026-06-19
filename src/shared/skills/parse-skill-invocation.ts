const LEADING_SKILL_RE = /^\/([a-z0-9][a-z0-9-]*)\b(?:\s+(.*))?$/s

/** Escape regex metacharacters so a skill name can be embedded in a pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Match a `/skill-name` token. Uses a negative lookahead for skill-name
 * characters as the trailing boundary so `/demo` does not match inside
 * `/demo-skill` (a plain `\b` would, since `-` is a word boundary).
 */
function skillTokenPattern(skillName: string): string {
  return `\\/${escapeRegExp(skillName)}(?![a-z0-9-])`
}

function stripSkillToken(text: string, skillName: string): string {
  return text
    .replace(new RegExp(skillTokenPattern(skillName)), '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse a leading `/skill-name` prefix from user input. */
export function parseSkillInvocation(
  text: string,
): { skillName: string; remainder: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(LEADING_SKILL_RE)
  if (!match) return null
  return {
    skillName: match[1]!,
    remainder: (match[2] ?? '').trim(),
  }
}

/**
 * Resolve a skill invocation from user input: leading `/skill` first, then an
 * inline `/skill-name` that matches a known registered skill (avoids false
 * positives on paths like `/Users/...`).
 */
export function resolveSkillInvocation(
  text: string,
  knownSkillNames: string[],
): { skillName: string; remainder: string } | null {
  const leading = parseSkillInvocation(text)
  if (leading) return leading

  const trimmed = text.trim()
  if (!trimmed || knownSkillNames.length === 0) return null

  const sorted = [...knownSkillNames].sort((a, b) => b.length - a.length)
  for (const name of sorted) {
    const re = new RegExp(`(?:^|\\s)${skillTokenPattern(name)}`)
    if (!re.test(trimmed)) continue
    return {
      skillName: name,
      remainder: stripSkillToken(trimmed, name),
    }
  }
  return null
}
