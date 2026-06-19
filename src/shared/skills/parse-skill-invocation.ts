const SKILL_PREFIX_RE = /^\/([a-z0-9][a-z0-9-]*)\b(?:\s+(.*))?$/s

/** Parse a leading `/skill-name` prefix from user input. */
export function parseSkillInvocation(
  text: string,
): { skillName: string; remainder: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(SKILL_PREFIX_RE)
  if (!match) return null
  return {
    skillName: match[1]!,
    remainder: (match[2] ?? '').trim(),
  }
}
