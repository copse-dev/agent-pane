import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deferApproval, resolveDeferral } from '../services/security/deferred-approval-store.ts'
import { runWithThreadExecutionContext } from '../services/thread-execution-context.ts'
import { deferredApprovalStatusTool } from './deferred-approval-status-tool.ts'

function assertStatusText(value: unknown, pattern: RegExp): void {
  assert.equal(typeof value, 'string')
  if (typeof value === 'string') assert.match(value, pattern)
}

describe('deferred_approval_status', () => {
  it('shows only this thread its pending request and never treats approval as execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'copse-deferred-status-'))
    const previous = process.env['COPSE_WORKSPACE_DIR']
    process.env['COPSE_WORKSPACE_DIR'] = root
    try {
      const projectId = 'deferred-status-project'
      const entry = await deferApproval(
        {
          threadId: 'thread-1',
          kind: 'shell',
          title: 'Run outside sandbox?',
          subject: 'shell command (arguments omitted)',
        },
        { projectId },
      )
      const context = {
        projectId,
        threadId: 'thread-1',
        projectRoot: root,
        root,
        checkoutMode: 'shared' as const,
        branch: null,
      }
      const signal = new AbortController().signal
      const pending = await runWithThreadExecutionContext(context, () =>
        deferredApprovalStatusTool.execute({ id: entry.id }, signal),
      )
      assertStatusText(pending, /pending human review/)
      assertStatusText(pending, /has not run/)

      const other = await runWithThreadExecutionContext({ ...context, threadId: 'thread-2' }, () =>
        deferredApprovalStatusTool.execute({ id: entry.id }, signal),
      )
      assertStatusText(other, /belongs to this thread/)

      await resolveDeferral(entry.id, 'approved', { projectId })
      const approved = await runWithThreadExecutionContext(context, () =>
        deferredApprovalStatusTool.execute({ id: entry.id }, signal),
      )
      assertStatusText(approved, /not proof that the action ran/)
    } finally {
      if (previous === undefined) delete process.env['COPSE_WORKSPACE_DIR']
      else process.env['COPSE_WORKSPACE_DIR'] = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
})
