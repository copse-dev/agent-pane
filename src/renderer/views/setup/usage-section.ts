import type { ApiClient } from '../../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { UsagePeriodSummary, UsageSummary } from '@shared/usage/aggregate-usage.ts'
import {
  formatPeriodHeadline,
  formatTokenCount,
  formatUsd,
} from '@shared/usage/format-usage-summary.ts'
import { qsRequired } from '../../dom/helpers.ts'
import { escapeHtml } from '../../markdown/escape.ts'

export type UsagePeriodKey = 'day' | 'month' | 'period90d' | 'allTime'

const PERIOD_LABELS: Record<UsagePeriodKey, string> = {
  day: 'Last 24 hours',
  month: 'Last 30 days',
  period90d: 'Last 90 days',
  allTime: 'All time',
}

function renderModelTable(
  host: HTMLElement,
  title: string,
  rows: UsagePeriodSummary['cloudModels'],
  emptyText: string,
): void {
  const section = document.createElement('div')
  section.className = 'usage-model-group'
  const heading = document.createElement('h4')
  heading.textContent = title
  section.append(heading)

  if (rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'usage-empty'
    empty.textContent = emptyText
    section.append(empty)
    host.append(section)
    return
  }

  const table = document.createElement('table')
  table.className = 'usage-table'
  table.innerHTML = `
    <thead>
      <tr>
        <th scope="col">Model</th>
        <th scope="col">Input</th>
        <th scope="col">Output</th>
        <th scope="col">Cache read</th>
        <th scope="col">Cache write</th>
        <th scope="col">Est. cost</th>
      </tr>
    </thead>
    <tbody></tbody>
  `
  const tbody = table.querySelector('tbody')
  if (!tbody) throw new Error('usage table is missing its tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    // "~" prefix flags counts we estimated locally because the agent (e.g. an ACP
    // client like Cursor) didn't report token usage.
    const approx = row.estimatedTokens ? '~' : ''
    // Escape the model id: for ACP it embeds a value the external agent supplied
    // (`acp:<id>#<model>`), so it's untrusted data going into innerHTML.
    const model = escapeHtml(row.model)
    const modelLabel = row.estimatedTokens
      ? `${model} <span class="usage-estimated" title="Estimated locally — agent did not report usage">(est.)</span>`
      : model
    tr.innerHTML = `
      <td><code>${modelLabel}</code></td>
      <td>${approx}${formatTokenCount(row.inputTokens)}</td>
      <td>${approx}${formatTokenCount(row.outputTokens)}</td>
      <td>${row.cacheReadTokens ? formatTokenCount(row.cacheReadTokens) : '—'}</td>
      <td>${row.cacheCreationTokens ? formatTokenCount(row.cacheCreationTokens) : '—'}</td>
      <td>${row.isLocal ? 'free (local)' : formatUsd(row.estimatedCostUsd)}</td>
    `
    tbody.append(tr)
  }
  section.append(table)
  host.append(section)
}

function renderPeriodSummary(
  host: HTMLElement,
  summary: UsagePeriodSummary,
  period: UsagePeriodKey,
  meta: Pick<UsageSummary, 'ledgerEventCount' | 'trackingStartedAt'>,
): void {
  host.replaceChildren()

  const headline = document.createElement('p')
  headline.className = 'usage-headline'
  headline.textContent = formatPeriodHeadline(summary)
  host.append(headline)

  const tokens = document.createElement('p')
  tokens.className = 'usage-token-total field-hint'
  tokens.textContent = `${formatTokenCount(summary.totalInputTokens)} input · ${formatTokenCount(summary.totalOutputTokens)} output tokens`
  host.append(tokens)

  if (period !== 'allTime') {
    const note = document.createElement('p')
    note.className = 'field-hint'
    const trackedSince =
      meta.trackingStartedAt !== null
        ? new Date(meta.trackingStartedAt).toLocaleString()
        : 'not yet'
    note.textContent =
      `Ledger: ${String(meta.ledgerEventCount)} event(s) tracked (since ${trackedSince}). ` +
      'Time windows include cloud and local models recorded on each agent turn. ' +
      'All-time totals come from saved threads and may include older usage.'
    host.append(note)
  }

  renderModelTable(
    host,
    'Cloud models',
    summary.cloudModels,
    'No cloud model usage in this period.',
  )
  renderModelTable(
    host,
    'Local models (free)',
    summary.localModels,
    'No local model usage in this period.',
  )
}

export function createUsageSection(
  api: ApiClient,
  store?: AppStore,
): {
  root: HTMLElement
  refresh: () => Promise<void>
  detach: () => void
} {
  const root = document.createElement('div')
  root.className = 'usage-section-root'
  root.innerHTML = `
    <div class="usage-period-tabs" role="tablist" aria-label="Usage period">
      <button type="button" class="usage-period-btn active" data-period="day" role="tab" aria-selected="true">Day</button>
      <button type="button" class="usage-period-btn" data-period="month" role="tab" aria-selected="false">Month</button>
      <button type="button" class="usage-period-btn" data-period="period90d" role="tab" aria-selected="false">90 days</button>
      <button type="button" class="usage-period-btn" data-period="allTime" role="tab" aria-selected="false">All time</button>
    </div>
    <div class="usage-period-label" id="usage-period-label">${PERIOD_LABELS.day}</div>
    <div class="usage-period-body" id="usage-period-body"></div>
  `

  const bodyEl = qsRequired(root, '#usage-period-body')
  const labelEl = qsRequired(root, '#usage-period-label')
  const tabBtns = root.querySelectorAll<HTMLButtonElement>('.usage-period-btn')
  let activePeriod: UsagePeriodKey = 'day'
  let cachedSummary: UsageSummary | null = null

  function showPeriod(period: UsagePeriodKey): void {
    activePeriod = period
    tabBtns.forEach((btn) => {
      const selected = btn.dataset['period'] === period
      btn.classList.toggle('active', selected)
      btn.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
    labelEl.textContent = PERIOD_LABELS[period]
    if (cachedSummary) {
      renderPeriodSummary(bodyEl, cachedSummary[period], period, {
        ledgerEventCount: cachedSummary.ledgerEventCount,
        trackingStartedAt: cachedSummary.trackingStartedAt,
      })
    }
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const period = btn.dataset['period'] as UsagePeriodKey | undefined
      if (period) showPeriod(period)
    })
  })

  async function refresh(): Promise<void> {
    bodyEl.textContent = 'Loading usage…'
    try {
      cachedSummary = await api.usage.getSummary()
      showPeriod(activePeriod)
    } catch (err) {
      bodyEl.textContent =
        err instanceof Error ? `Failed to load usage: ${err.message}` : 'Failed to load usage.'
    }
  }

  const unsubUsage = store?.on('usage_updated', () => {
    if (root.closest('.settings-section')?.classList.contains('active')) {
      void refresh()
    }
  })

  return { root, refresh, detach: () => unsubUsage?.() }
}
