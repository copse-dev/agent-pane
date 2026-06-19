/** User-facing text sent to the model when a skill is invoked. */
export function buildSkillUserText(
  skillName: string,
  remainder: string,
  hasAttachments: boolean,
): string {
  const trimmed = remainder.trim()
  if (trimmed) return trimmed
  if (hasAttachments) {
    return (
      `The user invoked /${skillName}. Follow the skill instructions and apply them ` +
      `to the attached file(s) below.`
    )
  }
  return `The user invoked /${skillName}. Follow the skill instructions.`
}
