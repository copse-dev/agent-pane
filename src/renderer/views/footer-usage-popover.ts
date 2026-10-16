import type {
  FooterUsageTooltipModel,
  FooterUsageTooltipRow,
  FooterUsageTooltipRun,
} from '@shared/usage/footer-usage-tooltip.ts'
import {
  CLASSIFIER_SUBJECT_LABELS,
  type ClassifierUseRow,
  type ThreadClassifierUse,
} from '@shared/usage/classifier-use.ts'
import { formatTokenCount } from '@shared/usage/format-usage-summary.ts'
import { el } from '../dom/helpers.ts'

function row(entry: FooterUsageTooltipRow, className: string): HTMLElement {
  return el(
    'div',
    { class: className },
    el('span', { class: 'footer-usage-popover-name' }, entry.label),
    el('span', { class: 'footer-usage-popover-value' }, entry.value),
  )
}

/** One delegated run: a status dot on the name line, model + state beneath. */
function runRow(run: FooterUsageTooltipRun): HTMLElement {
  return el(
    'div',
    { class: 'footer-usage-popover-row is-run' },
    el('span', { class: `footer-usage-popover-dot is-${run.status}` }),
    el(
      'span',
      { class: 'footer-usage-popover-run' },
      el('span', { class: 'footer-usage-popover-name' }, run.label),
      el('span', { class: 'footer-usage-popover-meta' }, run.detail),
    ),
    el('span', { class: 'footer-usage-popover-value' }, run.value),
  )
}

/**
 * Append the usage sections (headline, in/out, cache and cost, subagents,
 * per-model rows, notes) to the context wheel's hover popover. The wheel owns
 * the popover itself — one anchor, one hover — so this only fills it.
 */
export function appendUsageSections(parent: HTMLElement, model: FooterUsageTooltipModel): void {
  parent.append(el('div', { class: 'footer-usage-popover-header' }, model.header))
  if (model.conversationLabel) {
    parent.append(el('div', { class: 'footer-usage-popover-section' }, model.conversationLabel))
  }
  for (const entry of model.rows) parent.append(row(entry, 'footer-usage-popover-row'))
  // Once subagents exist, cache/cost remain provider-reported whole-thread
  // figures. Keep them with the subagent and per-model accounting below an
  // explicit scope label instead of presenting them as part of the
  // subagent-excluded headline above.
  if (model.threadLabel) {
    parent.append(el('div', { class: 'footer-usage-popover-divider' }))
    parent.append(el('div', { class: 'footer-usage-popover-section' }, model.threadLabel))
    for (const entry of model.threadRows) parent.append(row(entry, 'footer-usage-popover-row'))
  } else {
    for (const entry of model.threadRows) parent.append(row(entry, 'footer-usage-popover-row'))
    if (model.subagentRow || model.modelRows.length > 0) {
      parent.append(el('div', { class: 'footer-usage-popover-divider' }))
    }
  }
  if (model.subagentRow) {
    parent.append(row(model.subagentRow, 'footer-usage-popover-row is-subagents'))
    for (const run of model.subagentRuns) parent.append(runRow(run))
    if (model.subagentRunsOverflow > 0) {
      parent.append(
        el(
          'div',
          { class: 'footer-usage-popover-meta' },
          `+${String(model.subagentRunsOverflow)} more`,
        ),
      )
    }
  }
  // The per-model rows are a separate accounting from the runs above them;
  // without a rule they read as more subagent runs.
  if (model.subagentRuns.length > 0 && model.modelRows.length > 0) {
    parent.append(el('div', { class: 'footer-usage-popover-divider' }))
  }
  for (const entry of model.modelRows) {
    parent.append(row(entry, 'footer-usage-popover-row is-model'))
  }
  if (model.note) parent.append(el('div', { class: 'footer-usage-popover-note' }, model.note))
  if (model.freeNote) {
    parent.append(el('div', { class: 'footer-usage-popover-note' }, model.freeNote))
  }
}

/** Verdicts that mean the classifier found nothing to worry about. */
const REASSURING_VERDICTS: ReadonlySet<string> = new Set(['sandbox', 'safe', 'read', 'local-write'])

function formatLatency(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}

function classifierRow(row: ClassifierUseRow): HTMLElement {
  const details = [row.engine]
  if (row.averageLatencyMs !== null) details.push(`${formatLatency(row.averageLatencyMs)} avg`)
  if (row.inputTokens > 0 || row.outputTokens > 0) {
    details.push(
      `${formatTokenCount(row.inputTokens)} in / ${formatTokenCount(row.outputTokens)} out`,
    )
  }
  const pills = el('span', { class: 'footer-usage-popover-pills' })
  for (const verdict of row.verdicts) {
    pills.append(
      el(
        'span',
        {
          class: `footer-usage-popover-pill ${REASSURING_VERDICTS.has(verdict.label) ? 'is-ok' : 'is-warn'}`,
        },
        `${String(verdict.count)} ${verdict.label}`,
      ),
    )
  }
  if (row.noVerdict > 0) {
    pills.append(
      el('span', { class: 'footer-usage-popover-pill' }, `${String(row.noVerdict)} no verdict`),
    )
  }
  return el(
    'div',
    { class: 'footer-usage-popover-row is-classifier' },
    el(
      'span',
      { class: 'footer-usage-popover-run' },
      el('span', { class: 'footer-usage-popover-name' }, CLASSIFIER_SUBJECT_LABELS[row.subject]),
      el('span', { class: 'footer-usage-popover-meta' }, details.join(' · ')),
      pills,
    ),
    el(
      'span',
      { class: 'footer-usage-popover-value' },
      `${String(row.calls)} ${row.calls === 1 ? 'call' : 'calls'}`,
    ),
  )
}

/** Append what the classifiers did for this thread; nothing when none was asked. */
export function appendClassifierSection(parent: HTMLElement, use: ThreadClassifierUse): void {
  if (use.calls === 0) return
  parent.append(el('div', { class: 'footer-usage-popover-divider' }))
  parent.append(
    el(
      'div',
      { class: 'footer-usage-popover-section' },
      `Classifiers · ${String(use.calls)} ${use.calls === 1 ? 'call' : 'calls'}`,
    ),
  )
  for (const row of use.rows) parent.append(classifierRow(row))
}
