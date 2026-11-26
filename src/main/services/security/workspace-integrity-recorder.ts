/**
 * Records a reverted contained change (`project-sandbox/workspace-integrity.ts`)
 * as a decision line on the thread that ran the command. Paths and git config
 * keys only: config values can hold URLs with credentials.
 */
import {
  describeIntegrityFindings,
  type IntegrityOwner,
  type IntegrityReport,
} from '../../project-sandbox/workspace-integrity.ts'
import { recordDecision } from './decision-log-store.ts'

const WORKSPACE_INTEGRITY_DECISION_KIND = 'workspace-integrity'

export function recordWorkspaceIntegrityReport(
  report: IntegrityReport,
  owner: IntegrityOwner | null,
): void {
  if (report.findings.length === 0) return
  recordDecision({
    ...(owner ? { projectId: owner.projectId, threadId: owner.threadId } : {}),
    kind: WORKSPACE_INTEGRITY_DECISION_KIND,
    actor: 'system',
    verdict: report.findings.every((finding) => finding.restored) ? 'blocked' : 'observed',
    subject: 'contained change to host-run configuration',
    scope: 'sandbox',
    reasons: describeIntegrityFindings(report.findings),
  })
}
