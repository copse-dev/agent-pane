import assert from 'node:assert/strict'
import { it } from 'node:test'
import { parsePlanDocument, REQUIRED_PLAN_SECTIONS } from '@copse/thread-store/plan-schema.ts'
import { roadmapPlanDraft } from './roadmap-plan.ts'

it('retains a structured document exactly when promoting it to a draft', () => {
  const body =
    '# **Goal**\nAn outcome\n\n# Constraints\nNone\n\n# Scope\nThe feature\n\n# Definition of done\n- Works with `two  spaces`.'
  assert.deepEqual(roadmapPlanDraft({ title: 'Feature', body, fields: {} }), {
    title: 'Feature',
    body,
  })
})

it('keeps arbitrary Markdown, notes and the issue as context without inventing approved criteria', () => {
  const draft = roadmapPlanDraft({
    title: 'Feature',
    body: '# Scope\nDo something\n\n# Definition of done\n- old idea',
    fields: { notes: 'Wait for #42', issue: '#43' },
  })
  const parsed = parsePlanDocument(draft.body)
  for (const section of REQUIRED_PLAN_SECTIONS) assert.ok(parsed.sections.get(section))
  assert.equal(parsed.criteria.length, 1)
  assert.match(parsed.criteria[0]?.label ?? '', /Replace this draft criterion/)
  assert.match(draft.body, /> # Definition of done/)
  assert.match(draft.body, /> Wait for #42/)
  assert.match(draft.body, /> Issue: #43/)
})
