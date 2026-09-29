import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EDIT_TOOL_NAMES } from '@copse/agent/review-subagent.ts'
import {
  GATHER_SPECIALIST_EVIDENCE_TOOL_NAME,
  RUN_SPECIALIST_CHECK_TOOL_NAME,
} from '@copse/agent/specialist-checks.ts'
import {
  SPECIALIST_DIRECT_TOOL_NAMES,
  runApprovedEvidenceExploration,
  specialistCheckTool,
} from './specialist-check-runner.ts'

describe('specialist check capabilities', () => {
  it('offers the primary reviewer one generic specialist tool', () => {
    assert.equal(specialistCheckTool.name, RUN_SPECIALIST_CHECK_TOOL_NAME)
    assert.match(specialistCheckTool.description, /evidence only/i)
  })

  it('keeps direct specialist tools read-only and non-recursive', () => {
    const direct = new Set<string>(SPECIALIST_DIRECT_TOOL_NAMES)
    for (const edit of EDIT_TOOL_NAMES) assert.equal(direct.has(edit), false)
    assert.equal(direct.has('run_shell'), false)
    assert.equal(direct.has(RUN_SPECIALIST_CHECK_TOOL_NAME), false)
    assert.equal(direct.has(GATHER_SPECIALIST_EVIDENCE_TOOL_NAME), false)
  })
})

describe('specialist explorer spend approval', () => {
  it('does not run a paid explorer when its model is declined', async () => {
    let ran = false
    const result = await runApprovedEvidenceExploration({
      usageModel: 'paid-explorer',
      billable: true,
      ensureApproved: async () => false,
      run: async () => {
        ran = true
        return 'evidence'
      },
    })
    assert.equal(ran, false)
    assert.match(result, /paid-explorer.*not approved/)
  })

  it('runs an approved paid explorer', async () => {
    const result = await runApprovedEvidenceExploration({
      usageModel: 'paid-explorer',
      billable: true,
      ensureApproved: async () => true,
      run: async () => 'evidence',
    })
    assert.equal(result, 'evidence')
  })

  it('runs a free explorer without requesting approval', async () => {
    let approvalCalls = 0
    const result = await runApprovedEvidenceExploration({
      usageModel: 'local-explorer',
      billable: false,
      ensureApproved: async () => {
        approvalCalls += 1
        return false
      },
      run: async () => 'local evidence',
    })
    assert.equal(approvalCalls, 0)
    assert.equal(result, 'local evidence')
  })
})
