// The Copse Reviewer findings card (docs/plans/copse-reviewer.md, Shell B):
// the thread's trailing card once a review has run. Findings, not prose —
// ranked, each one expandable to its verdict, the source it is anchored to,
// the evidence that was executed or cited and who raised, corroborated or
// challenged it, and each dismissible. A clean review is one line.
//
// Renders from `ThreadReviewReport` data only (never from live plugin
// registration), so a report on a thread keeps rendering after the plugin is
// disabled or replaced (hooks-and-feature-packs decision 17).
import { el, on } from '../dom/helpers.ts'
import { closeIcon, searchIcon } from '../dom/icons.ts'
import { createRetryButton } from './retry-button.ts'
import type { ReviewFindingEvidence, ReviewFindingRecord, ThreadReviewReport } from '@shared/types'
import { nonEmptyStringOr } from '@shared/unknown-value.ts'

export interface ReviewFindingsCardActions {
  /** Re-run the review; offered on a failed card. */
  onRetry?: () => void
  /** Remove a failed card outright. */
  onDismissCard?: () => void
  onDismissFinding?: (finding: ReviewFindingRecord) => void
  onRestoreFinding?: (finding: ReviewFindingRecord) => void
}

function statusLabel(report: ThreadReviewReport): string {
  switch (report.status) {
    case 'running':
      return 'Reviewing…'
    case 'error':
      return 'Review failed'
    default:
      return 'Review'
  }
}

/** `src/math.ts:12` / `src/math.ts:12–15` / `src/math.ts`. */
export function findingLocation(finding: ReviewFindingRecord): string {
  if (finding.startLine === undefined) return finding.path
  const end = finding.endLine !== undefined && finding.endLine !== finding.startLine
  return `${finding.path}:${String(finding.startLine)}${end ? `–${String(finding.endLine)}` : ''}`
}

function verdictLabel(finding: ReviewFindingRecord): string {
  switch (finding.verdict.status) {
    case 'confirmed':
      return finding.evidence.some((evidence) => evidence.kind === 'reproducer')
        ? 'confirmed by reproducer'
        : 'confirmed'
    case 'refuted':
      return 'refuted'
    default:
      return finding.challengedBy.length > 0 ? 'survived challenge' : 'unverified'
  }
}

function evidenceEl(evidence: ReviewFindingEvidence): HTMLElement {
  const item = el('li', { class: 'review-finding-evidence', 'data-kind': evidence.kind })
  switch (evidence.kind) {
    case 'command': {
      const exit = evidence.exitCode === null ? 'killed' : `exit ${String(evidence.exitCode)}`
      item.append(
        el('code', { class: 'review-finding-command' }, evidence.command),
        el('span', { class: 'review-finding-evidence-meta' }, ` on ${evidence.target}, ${exit}`),
      )
      if (evidence.excerpt.trim() !== '') {
        item.append(el('pre', { class: 'review-finding-excerpt' }, evidence.excerpt.trimEnd()))
      }
      return item
    }
    case 'reproducer': {
      const outcome = `${evidence.failsOnHead ? 'fails' : 'passes'} on head, ${evidence.passesOnBase ? 'passes' : 'fails'} on base`
      item.append(
        el('code', { class: 'review-finding-command' }, evidence.testPath),
        el('span', { class: 'review-finding-evidence-meta' }, ` — reproducer ${outcome}`),
      )
      return item
    }
    default: {
      const lines =
        evidence.startLine === evidence.endLine
          ? String(evidence.startLine)
          : `${String(evidence.startLine)}–${String(evidence.endLine)}`
      item.append(
        el('span', { class: 'review-finding-evidence-meta' }, 'cites '),
        el('code', { class: 'review-finding-command' }, `${evidence.path}:${lines}`),
      )
      return item
    }
  }
}

function provenanceEl(finding: ReviewFindingRecord): HTMLElement {
  const parts: string[] = [`Raised by ${finding.raisedBy.join(', ')}`]
  if (finding.corroboratedBy.length > 0) {
    parts.push(`corroborated by ${finding.corroboratedBy.join(', ')}`)
  }
  if (finding.challengedBy.length > 0) {
    parts.push(`challenged by ${finding.challengedBy.join(', ')}`)
  }
  return el('div', { class: 'review-finding-provenance' }, `${parts.join('; ')}.`)
}

function findingEl(finding: ReviewFindingRecord, actions: ReviewFindingsCardActions): HTMLElement {
  const item = el('li', {
    class: 'review-finding',
    'data-finding-id': finding.id,
    'data-severity': finding.severity,
    'data-verdict': finding.verdict.status,
    ...(finding.dismissed ? { 'data-dismissed': '' } : {}),
  })
  const details = el('details', { class: 'review-finding-details' })
  const summary = el('summary', { class: 'review-finding-summary' })
  summary.append(
    el('span', { class: 'review-finding-severity' }, finding.severity),
    el('span', { class: 'review-finding-class' }, finding.class),
    el('code', { class: 'review-finding-location' }, findingLocation(finding)),
    el('span', { class: 'review-finding-claim' }, finding.claim),
    el(
      'span',
      { class: 'review-finding-verdict', 'data-verdict': finding.verdict.status },
      verdictLabel(finding),
    ),
  )
  details.append(summary)

  const body = el('div', { class: 'review-finding-body' })
  body.append(el('p', { class: 'review-finding-reason' }, finding.verdict.reason))
  if (finding.anchoredText !== undefined && finding.anchoredText.trim() !== '') {
    body.append(el('pre', { class: 'review-finding-anchor' }, finding.anchoredText))
  }
  if (finding.evidence.length > 0) {
    const list = el('ul', { class: 'review-finding-evidence-list' })
    for (const evidence of finding.evidence) list.append(evidenceEl(evidence))
    body.append(list)
  }
  body.append(provenanceEl(finding))

  const footer = el('div', { class: 'review-finding-actions' })
  footer.append(
    el(
      'span',
      { class: 'review-finding-confidence' },
      `${finding.confidence} confidence · ${finding.id}`,
    ),
  )
  if (finding.dismissed) {
    if (actions.onRestoreFinding) {
      const restore = el('button', { type: 'button', class: 'review-finding-restore' }, 'Restore')
      on(restore, 'click', () => {
        restore.disabled = true
        actions.onRestoreFinding?.(finding)
      })
      footer.append(restore)
    }
  } else if (actions.onDismissFinding) {
    const dismiss = el(
      'button',
      {
        type: 'button',
        class: 'review-finding-dismiss',
        'data-tooltip': 'Hide this finding, here and in later reviews of the same lines',
      },
      'Dismiss',
    )
    on(dismiss, 'click', () => {
      dismiss.disabled = true
      actions.onDismissFinding?.(finding)
    })
    footer.append(dismiss)
  }
  body.append(footer)
  details.append(body)
  item.append(details)
  return item
}

function metaLine(report: ThreadReviewReport): string {
  const parts: string[] = []
  if (report.models.reviewer !== '') {
    parts.push(
      report.models.challenger !== null && report.models.challenger !== report.models.reviewer
        ? `${report.models.reviewer}, challenged by ${report.models.challenger}`
        : report.models.reviewer,
    )
  }
  if (report.baseRef !== '') {
    parts.push(
      report.dirtyWorkingTree
        ? `working tree against ${report.baseRef}`
        : `HEAD against ${report.baseRef}`,
    )
  }
  return parts.join(' · ')
}

/** One chip per Stage 0 check, plus what could not run and why. */
function groundEl(report: ThreadReviewReport): HTMLElement | null {
  if (report.status !== 'done') return null
  const ground = el('div', { class: 'review-report-ground' })
  if (!report.execution.executed) {
    ground.append(
      el(
        'span',
        { class: 'review-report-ground-note', 'data-executed': 'false' },
        `Read-only review — nothing was executed: ${report.execution.reason}`,
      ),
    )
    return ground
  }
  for (const check of report.checks) {
    const mark = check.verdict === 'clean' || check.verdict === 'fixed' ? '✓' : '✗'
    ground.append(
      el(
        'span',
        { class: 'review-report-check', 'data-verdict': check.verdict },
        `${check.kind} ${mark} ${check.verdict}`,
      ),
    )
  }
  for (const note of report.notChecked) {
    ground.append(el('span', { class: 'review-report-ground-note' }, `not checked: ${note}`))
  }
  return ground.childElementCount === 0 ? null : ground
}

function footerEl(
  report: ThreadReviewReport,
  dismissedCount: number,
  onToggleDismissed: (() => void) | null,
): HTMLElement | null {
  const parts: (string | HTMLElement)[] = []
  if (report.appendix > 0) {
    parts.push(`${String(report.appendix)} more below the cut`)
  }
  if (report.refuted > 0) {
    parts.push(`${String(report.refuted)} refuted by the challenger`)
  }
  if (report.verification !== null && report.verification.skipped > 0) {
    parts.push(`${String(report.verification.skipped)} left unverified`)
  }
  if (dismissedCount > 0 && onToggleDismissed) {
    const toggle = el(
      'button',
      { type: 'button', class: 'review-report-dismissed-toggle', 'aria-pressed': 'false' },
      `${String(dismissedCount)} dismissed`,
    )
    on(toggle, 'click', () => {
      const shown = toggle.getAttribute('aria-pressed') === 'true'
      toggle.setAttribute('aria-pressed', shown ? 'false' : 'true')
      onToggleDismissed()
    })
    parts.push(toggle)
  }
  if (parts.length === 0) return null
  const footer = el('div', { class: 'review-report-footer' })
  parts.forEach((part, index) => {
    if (index > 0) footer.append(el('span', { class: 'review-report-footer-sep' }, ' · '))
    footer.append(part)
  })
  return footer
}

function createDismissCardButton(onDismiss: () => void): HTMLButtonElement {
  const button = el(
    'button',
    {
      type: 'button',
      class: 'card-dismiss-button',
      'data-tooltip': 'Dismiss',
      'aria-label': 'Dismiss',
    },
    closeIcon('ui-icon ui-icon-sm'),
  )
  on(button, 'click', () => {
    button.disabled = true
    onDismiss()
  })
  return button
}

/** The findings card for a thread's Copse Reviewer report. */
export function createReviewFindingsCardEl(
  report: ThreadReviewReport,
  actions: ReviewFindingsCardActions = {},
): HTMLElement {
  const panel = el('div', {
    class: `review-report review-report-${report.status}`,
    'data-status': report.status,
  })

  const header = el('div', { class: 'review-report-header' })
  header.append(
    el(
      'span',
      { class: 'review-report-icon', 'aria-hidden': 'true' },
      searchIcon('ui-icon ui-icon-sm'),
    ),
    el('span', { class: 'review-report-title' }, statusLabel(report)),
  )
  const meta = metaLine(report)
  if (meta !== '') header.append(el('span', { class: 'review-report-meta' }, meta))
  if (report.cost !== undefined) {
    header.append(el('span', { class: 'review-report-cost' }, report.cost))
  }
  if (report.status === 'error' && actions.onRetry)
    header.append(createRetryButton(actions.onRetry))
  if (report.status === 'error' && actions.onDismissCard) {
    header.append(createDismissCardButton(actions.onDismissCard))
  }
  panel.append(header)

  if (report.status === 'running') return panel

  if (report.status === 'error') {
    panel.append(
      el(
        'div',
        { class: 'review-report-error message-text' },
        nonEmptyStringOr(report.error, 'Review failed.'),
      ),
    )
    return panel
  }

  const ground = groundEl(report)
  if (ground) panel.append(ground)

  const visible = report.findings.filter((finding) => !finding.dismissed)
  const dismissed = report.findings.filter((finding) => finding.dismissed)
  if (report.findings.length === 0) {
    panel.append(
      el('div', { class: 'review-report-clean' }, report.note ?? 'Clean.'),
    )
  } else {
    if (report.note !== undefined) {
      panel.append(el('div', { class: 'review-report-note' }, report.note))
    }
    const list = el('ol', { class: 'review-report-findings' })
    for (const finding of visible) list.append(findingEl(finding, actions))
    if (visible.length === 0) {
      panel.append(
        el('div', { class: 'review-report-clean' }, 'Nothing left: every finding is dismissed.'),
      )
    }
    panel.append(list)
    if (dismissed.length > 0) {
      const dismissedList = el('ol', { class: 'review-report-findings review-report-dismissed' })
      dismissedList.hidden = true
      for (const finding of dismissed) dismissedList.append(findingEl(finding, actions))
      panel.append(dismissedList)
      const footer = footerEl(report, dismissed.length, () => {
        dismissedList.hidden = !dismissedList.hidden
      })
      if (footer) panel.append(footer)
      return panel
    }
  }
  const footer = footerEl(report, 0, null)
  if (footer) panel.append(footer)
  return panel
}
