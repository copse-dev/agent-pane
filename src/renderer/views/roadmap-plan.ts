import { parsePlanDocument, REQUIRED_PLAN_SECTIONS } from '@copse/thread-store/plan-schema.ts'

/** Keep an already structured plan byte-for-byte; otherwise retain the brief as context. */
export function roadmapPlanDraft(item: {
  title: string
  body: string
  fields: Record<string, string>
}): { title: string; body: string } {
  const parsed = parsePlanDocument(item.body)
  const title = item.title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Implementation plan'
  if (
    REQUIRED_PLAN_SECTIONS.every((section) => parsed.sections.get(section)?.trim()) &&
    parsed.criteria.length > 0
  )
    return { title, body: item.body }
  const quote = (text: string): string =>
    text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')
  const context = [
    item.body,
    item.fields['notes'],
    item.fields['issue'] ? `Issue: ${item.fields['issue']}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    title,
    body: `# Goal\nImplement: ${title}\n\n# Constraints\nTo be clarified during planning.\n\n# Scope\nRoadmap brief:\n\n${quote(context)}\n\n# Definition of done\n- Replace this draft criterion with observable acceptance criteria before approval.`,
  }
}
