const LEADING_SKILL_RE = /^\/([a-z0-9][a-z0-9-]*)\b(?:\s+(.*))?$/s

function stripSkillToken(text: string, skillName: string): string {
  return text
    .replace(new RegExp(`\\/${skillName}\\b`), '')
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
    const re = new RegExp(`(?:^|\\s)\\/${name}\\b`)
    if (!re.test(trimmed)) continue
    return {
      skillName: name,
      remainder: stripSkillToken(trimmed, name),
    }
  }
  return null
}
