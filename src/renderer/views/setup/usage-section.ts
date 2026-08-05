import type { ApiClient } from '../../../preload/api.d.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { UsagePeriodSummary, UsageSummary } from '@shared/usage/aggregate-usage.ts'
import {
  formatPeriodHeadline,
  formatTokenCount,
  formatUsd,
} from '@shared/usage/format-usage-summary.ts'
import type { PlanWorthItPayload } from '@shared/usage/plan-worth-it.ts'
import type { PlanUsageSnapshot, ProviderPlanResult } from '@copse/plan-usage'
import { qsRequired } from '../../dom/helpers.ts'
import { escapeHtml } from '@copse/streaming-markdown'
import {
  createIntellectFrontierPanel,
  setModelCardApi,
  type OpenRouterFrontierSource,
} from '../intellect-frontier-panel.ts'
import type { PlanCoverageMode } from '@shared/plan-inclusion.ts'

export type UsagePeriodKey = 'day' | 'month' | 'period90d' | 'allTime'

const PERIOD_LABELS: Record<UsagePeriodKey, string> = {
  day: 'Last 24 hours',
  month: 'Last 30 days',
  period90d: 'Last 90 days',
  allTime: 'All time',
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  huggingface: 'Hugging Face',
  cursor: 'Cursor',
}

/** Debounce ledger refreshes while usage streams in during active agent turns. */
const LEDGER_REFRESH_DEBOUNCE_MS = 400

function isAbortTimeoutMessage(message: string): boolean {
  return /aborted due to timeout|operation was aborted|aborterror|timeout/i.test(message)
}

/**
 * True when a Claude "unavailable" reason is a sign-in / credential problem a
 * fresh `claude /login` would fix — not an inherent limitation like a Console
 * API key that simply can't report plan windows. Exported for unit tests.
 */
export function claudeReasonNeedsLogin(reason: string): boolean {
  return /claude \/login|user:profile|rejected/i.test(reason)
}

/**
 * Build the "Sign in to Claude" click handler: close the settings modal so the
 * shell is visible, then launch `claude /login` in a fresh Shells terminal.
 * Returns `null` without a store to route the request through. Exported so the
 * emit + close wiring is unit-testable without standing up the whole section.
 */
export function createClaudeSignInHandler(
  store: AppStore | undefined,
  onRequestClose?: () => void,
): (() => void) | null {
  if (!store) return null
  return (): void => {
    onRequestClose?.()
    store.emit('request_terminal_command', 'claude /login')
  }
}

function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return 'reset unknown'
  const ms = Date.parse(resetsAt)
  if (!Number.isFinite(ms)) return 'reset unknown'
  const delta = ms - Date.now()
  if (delta <= 0) return 'resetting soon'
  const hours = Math.round(delta / (60 * 60 * 1000))
  if (hours < 48) return `resets in ${String(hours)}h`
  const days = Math.round(hours / 24)
  return `resets in ${String(days)}d`
}

function formatCreditCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

/** Exported for unit tests. */
export function renderPlanProvider(
  host: HTMLElement,
  result: ProviderPlanResult,
  onClaudeSignIn?: (() => void) | null,
): void {
  const card = document.createElement('div')
  card.className = 'usage-plan-provider'
  card.dataset['provider'] = result.provider
  card.dataset['status'] = result.status

  const title = document.createElement('h4')
  title.className = 'usage-plan-provider-title'
  title.textContent = PROVIDER_LABELS[result.provider] ?? result.provider
  card.append(title)

  if (result.status === 'unavailable') {
    const hint = document.createElement('p')
    hint.className = 'usage-plan-status field-hint'
    hint.textContent = result.reason
    card.append(hint)
    if (result.provider === 'claude' && onClaudeSignIn && claudeReasonNeedsLogin(result.reason)) {
      const signIn = document.createElement('button')
      signIn.type = 'button'
      signIn.className = 'usage-plan-signin-btn'
      signIn.textContent = 'Sign in to Claude'
      signIn.title = 'Open a terminal and run `claude /login`'
      signIn.addEventListener('click', () => {
        onClaudeSignIn()
      })
      card.append(signIn)
    }
    host.append(card)
    return
  }

  if (result.status === 'error') {
    const hint = document.createElement('p')
    hint.className = 'usage-plan-status usage-plan-status-error field-hint'
    const label = PROVIDER_LABELS[result.provider] ?? result.provider
    hint.textContent = isAbortTimeoutMessage(result.message)
      ? `Timed out while checking ${label} plan usage.`
      : `Couldn’t load ${label} plan usage: ${result.message}`
    card.append(hint)
    host.append(card)
    return
  }

  if (result.usage.plan) {
    const plan = document.createElement('p')
    plan.className = 'usage-plan-name field-hint'
    plan.textContent = result.usage.plan
    card.append(plan)
  }

  if (result.usage.creditGrant) {
    const credit = result.usage.creditGrant
    const usedPercent = Math.min(100, Math.max(0, (credit.usedCents / credit.totalCents) * 100))
    const row = document.createElement('div')
    row.className = 'usage-credit-grant'
    row.innerHTML = `
      <div class="usage-plan-window-meta">
        <span class="usage-plan-window-label">Credits</span>
        <span class="usage-plan-window-stats">${escapeHtml(formatCreditCents(credit.remainingCents))} remaining of ${escapeHtml(formatCreditCents(credit.totalCents))}</span>
      </div>
      <div class="usage-plan-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${String(Math.round(usedPercent))}" aria-label="Cursor credits ${escapeHtml(formatCreditCents(credit.usedCents))} used of ${escapeHtml(formatCreditCents(credit.totalCents))}">
        <div class="usage-plan-bar-fill" style="width: ${String(usedPercent)}%"></div>
      </div>
    `
    card.append(row)
  }

  for (const window of result.usage.windows) {
    const row = document.createElement('div')
    row.className = 'usage-plan-window'
    const used = Math.round(window.usedPercent)
    const severity =
      typeof window.severity === 'string' && window.severity.trim()
        ? window.severity.trim().toLowerCase()
        : null
    const severitySuffix = severity && severity !== 'normal' ? ` · ${severity}` : ''
    if (severity) row.dataset['severity'] = severity
    row.innerHTML = `
      <div class="usage-plan-window-meta">
        <span class="usage-plan-window-label">${escapeHtml(window.label)}</span>
        <span class="usage-plan-window-stats">${String(used)}% used · ${formatReset(window.resetsAt)}${escapeHtml(severitySuffix)}</span>
      </div>
      <div class="usage-plan-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${String(used)}" aria-label="${escapeHtml(window.label)} ${String(used)} percent used">
        <div class="usage-plan-bar-fill" style="width: ${String(Math.min(100, used))}%"></div>
      </div>
    `
    card.append(row)
  }

  host.append(card)
}

function renderPlanSection(
  host: HTMLElement,
  snapshot: PlanUsageSnapshot | null,
  error: string | null,
  onClaudeSignIn?: (() => void) | null,
): void {
  host.replaceChildren()

  const heading = document.createElement('h3')
  heading.className = 'usage-plan-heading'
  heading.textContent = 'Subscription plan limits'
  host.append(heading)

  const intro = document.createElement('p')
  intro.className = 'field-hint'
  intro.textContent =
    'Live plan windows for the accounts you are signed in to. If a plan cannot be read, the local ledger below still tracks this app’s usage.'
  host.append(intro)

  if (error) {
    const err = document.createElement('p')
    err.className = 'usage-plan-status usage-plan-status-error field-hint'
    err.textContent = error
    host.append(err)
    return
  }

  if (!snapshot) {
    const loading = document.createElement('p')
    loading.className = 'field-hint'
    loading.textContent = 'Loading plan usage…'
    host.append(loading)
    return
  }

  if (snapshot.error) {
    const err = document.createElement('p')
    err.className = 'usage-plan-status usage-plan-status-error field-hint'
    err.textContent = `Couldn’t load subscription plan usage: ${snapshot.error}`
    host.append(err)
    return
  }

  const list = document.createElement('div')
  list.className = 'usage-plan-providers'
  for (const provider of snapshot.providers) {
    renderPlanProvider(list, provider, onClaudeSignIn)
  }
  host.append(list)
}

const VERDICT_LABELS: Record<PlanWorthItPayload['worthIt']['verdict'], string> = {
  worth_it: 'Worth it vs inference',
  borderline: 'Close to break-even',
  not_worth_it: 'Inference may be cheaper',
  insufficient_history: 'Need more history',
  needs_fee: 'Enter your plan fee',
}

/**
 * Render the Claude plan worth-it card. Exported for unit tests.
 * `onShowInference` switches the value map to Inference prices.
 */
export function renderPlanWorthItSection(
  host: HTMLElement,
  payload: PlanWorthItPayload | null,
  error: string | null,
  opts: {
    onFeeChange: (fee: number | null) => void
    onShowInference: () => void
    busy?: boolean
  },
): void {
  host.replaceChildren()

  const heading = document.createElement('h3')
  heading.className = 'usage-worth-heading'
  heading.textContent = 'Is your plan worth it?'
  host.append(heading)

  const intro = document.createElement('p')
  intro.className = 'field-hint'
  intro.textContent =
    'Compares your Claude subscription’s account-wide weekly API-equivalent burn (from plan windows, including other apps and devices) to paying catalog inference rates. Copse’s local ledger is not used here.'
  host.append(intro)

  if (error) {
    const err = document.createElement('p')
    err.className = 'usage-plan-status usage-plan-status-error field-hint'
    err.textContent = error
    host.append(err)
    return
  }

  if (!payload) {
    const loading = document.createElement('p')
    loading.className = 'field-hint'
    loading.textContent = 'Loading plan worth-it…'
    host.append(loading)
    return
  }

  const { worthIt } = payload
  const card = document.createElement('div')
  card.className = 'usage-worth-card'
  card.dataset['verdict'] = worthIt.verdict

  const verdict = document.createElement('p')
  verdict.className = 'usage-worth-verdict'
  verdict.textContent = VERDICT_LABELS[worthIt.verdict]
  card.append(verdict)

  const reason = document.createElement('p')
  reason.className = 'usage-worth-reason field-hint'
  reason.textContent = worthIt.reason
  card.append(reason)

  const feeRow = document.createElement('div')
  feeRow.className = 'usage-worth-fee-row'
  const feeLabel = document.createElement('label')
  feeLabel.className = 'usage-worth-fee-label'
  feeLabel.htmlFor = 'usage-worth-fee-input'
  feeLabel.textContent = 'Claude plan monthly fee (USD)'
  const feeInput = document.createElement('input')
  feeInput.id = 'usage-worth-fee-input'
  feeInput.type = 'number'
  feeInput.min = '1'
  feeInput.max = '10000'
  feeInput.step = '1'
  feeInput.className = 'usage-worth-fee-input'
  feeInput.placeholder = worthIt.feeHint ? String(worthIt.feeHint.monthlyFeeUsd) : 'e.g. 100'
  if (worthIt.monthlyFeeUsd !== null) {
    feeInput.value = String(worthIt.monthlyFeeUsd)
  }
  if (worthIt.feeHint && worthIt.monthlyFeeUsd === worthIt.feeHint.monthlyFeeUsd) {
    feeInput.title = `Hinted from weekly limit (${worthIt.feeHint.label})`
  }
  feeInput.disabled = opts.busy === true
  feeInput.addEventListener('change', () => {
    const raw = feeInput.value.trim()
    if (!raw) {
      opts.onFeeChange(null)
      return
    }
    const n = Number(raw)
    opts.onFeeChange(Number.isFinite(n) && n > 0 ? n : null)
  })
  feeRow.append(feeLabel, feeInput)
  card.append(feeRow)

  if (worthIt.feeHint && worthIt.monthlyFeeUsd === null) {
    const hint = document.createElement('p')
    hint.className = 'field-hint'
    hint.textContent = `Suggested from weekly limit: ${worthIt.feeHint.label} (~$${String(worthIt.feeHint.monthlyFeeUsd)}/mo).`
    card.append(hint)
  }

  const actions = document.createElement('div')
  actions.className = 'usage-worth-actions'
  const inferenceBtn = document.createElement('button')
  inferenceBtn.type = 'button'
  inferenceBtn.className = 'usage-worth-inference-btn'
  inferenceBtn.textContent = 'Show inference prices on value map'
  inferenceBtn.title = 'Plot the cancel-the-plan frontier (catalog API $/MTok)'
  inferenceBtn.addEventListener('click', () => {
    opts.onShowInference()
  })
  actions.append(inferenceBtn)
  card.append(actions)

  host.append(card)
}

/**
 * Render one model-usage table. The Cloud and Local tables share an identical
 * `<colgroup>` under fixed layout so their columns line up even though they are
 * separate elements. Exported for unit tests.
 */
export function renderModelTable(
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
  // A shared column template (fixed layout, identical widths) so the Cloud and
  // Local tables line their columns up even though they are separate elements
  // with different content widths.
  table.innerHTML = `
    <colgroup>
      <col class="usage-col-model" />
      <col class="usage-col-num" />
      <col class="usage-col-num" />
      <col class="usage-col-num" />
      <col class="usage-col-num" />
      <col class="usage-col-num" />
    </colgroup>
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
      ? `${model} <span class="usage-estimated" title="Estimated locally, because the agent did not report usage">(est.)</span>`
      : model
    tr.innerHTML = `
      <td><code>${modelLabel}</code></td>
      <td>${approx}${formatTokenCount(row.inputTokens)}</td>
      <td>${approx}${formatTokenCount(row.outputTokens)}</td>
      <td>${row.cacheReadTokens ? formatTokenCount(row.cacheReadTokens) : '-'}</td>
      <td>${row.cacheCreationTokens ? formatTokenCount(row.cacheCreationTokens) : '-'}</td>
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
  onRequestClose?: () => void,
): {
  root: HTMLElement
  refresh: () => Promise<void>
  detach: () => void
} {
  const handleClaudeSignIn = createClaudeSignInHandler(store, onRequestClose)
  const root = document.createElement('div')
  root.className = 'usage-section-root'
  root.innerHTML = `
    <div class="usage-plan-section" id="usage-plan-section"></div>
    <div class="usage-worth-section" id="usage-worth-section"></div>
    <div class="usage-ledger-section">
      <h3 class="usage-ledger-heading">Local usage ledger</h3>
      <div class="usage-period-tabs" role="tablist" aria-label="Usage period">
        <button type="button" class="usage-period-btn active" data-period="day" role="tab" aria-selected="true">Day</button>
        <button type="button" class="usage-period-btn" data-period="month" role="tab" aria-selected="false">Month</button>
        <button type="button" class="usage-period-btn" data-period="period90d" role="tab" aria-selected="false">90 days</button>
        <button type="button" class="usage-period-btn" data-period="allTime" role="tab" aria-selected="false">All time</button>
      </div>
      <div class="usage-period-label" id="usage-period-label">${PERIOD_LABELS.day}</div>
      <div class="usage-period-body" id="usage-period-body"></div>
    </div>
  `

  // The model value map earns its place here too: usage is where spend is
  // visible, and the frontier is the "was that spend worth it" view.
  const loadOpenRouter = async (): Promise<OpenRouterFrontierSource> => {
    let available = false
    let zdrOnly = true
    let allowTraining = false
    try {
      available = (await api.settings.availableProviders())['openrouter'] === true
    } catch {
      /* unavailable */
    }
    try {
      zdrOnly = (await api.settings.get('openRouterZdrOnly')) !== false
      allowTraining = (await api.settings.get('openRouterAllowTraining')) === true
    } catch {
      /* keep privacy-preserving defaults */
    }
    let models: Awaited<ReturnType<ApiClient['openRouter']['models']>> = []
    if (available) {
      try {
        models = await api.openRouter.models()
      } catch {
        /* leave OpenRouter off the map when its catalog is unreachable */
      }
    }
    return { models, zdrOnly, allowTraining }
  }
  // The value map resolves each model's card link through the main process
  // (probe + cache). Without a bridge nothing resolves and no card links show.
  setModelCardApi(api.modelCards)
  const frontierPanel = createIntellectFrontierPanel(
    () => api.lmStudio.models(),
    () => api.settings.extraProviders(),
    () => api.intellect.liveModels(),
    () => api.usage.getPlanUsage(),
    loadOpenRouter,
  )
  root.append(frontierPanel.root)

  const planEl = qsRequired(root, '#usage-plan-section')
  const worthEl = qsRequired(root, '#usage-worth-section')
  const bodyEl = qsRequired(root, '#usage-period-body')
  const labelEl = qsRequired(root, '#usage-period-label')
  const tabBtns = root.querySelectorAll<HTMLButtonElement>('.usage-period-btn')
  let activePeriod: UsagePeriodKey = 'day'
  let cachedSummary: UsageSummary | null = null
  let cachedPlanSnapshot: PlanUsageSnapshot | null = null
  let ledgerRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let feeBusy = false

  async function persistPlanFee(fee: number | null): Promise<void> {
    feeBusy = true
    try {
      const next = await api.usage.setClaudePlanMonthlyFee(fee)
      applyWorthItPayload(next)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save Claude plan monthly fee.'
      renderPlanWorthItSection(worthEl, null, message, {
        onFeeChange: (): void => undefined,
        onShowInference: (): void => undefined,
      })
    } finally {
      feeBusy = false
    }
  }

  function applyWorthItPayload(payload: PlanWorthItPayload): void {
    const rates = new Map(
      payload.windowExhaustion.map((row) => [row.windowId, { hit: row.hit, total: row.total }]),
    )
    frontierPanel.setWindowExhaustion(rates)
    renderPlanWorthItSection(worthEl, payload, null, {
      busy: feeBusy,
      onFeeChange: (fee: number | null): void => {
        void persistPlanFee(fee)
      },
      onShowInference: (): void => {
        frontierPanel.setPlanCoverageMode('inference' satisfies PlanCoverageMode)
        frontierPanel.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      },
    })
  }

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
      const period = btn.dataset['period']
      if (
        period === 'day' ||
        period === 'month' ||
        period === 'period90d' ||
        period === 'allTime'
      ) {
        showPeriod(period)
      }
    })
  })

  async function refreshPlan(): Promise<void> {
    if (!cachedPlanSnapshot) {
      renderPlanSection(planEl, null, null, handleClaudeSignIn)
    }
    try {
      const snapshot = await api.usage.getPlanUsage()
      cachedPlanSnapshot = snapshot
      renderPlanSection(planEl, snapshot, null, handleClaudeSignIn)
    } catch (err) {
      // Plan usage is best-effort — never block the ledger on IPC failure.
      const message = err instanceof Error ? err.message : 'Failed to load subscription plan usage.'
      renderPlanSection(planEl, null, message, handleClaudeSignIn)
    }
  }

  async function refreshWorthIt(): Promise<void> {
    renderPlanWorthItSection(worthEl, null, null, {
      onFeeChange: () => undefined,
      onShowInference: () => undefined,
    })
    try {
      const payload = await api.usage.getPlanWorthIt()
      applyWorthItPayload(payload)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load plan worth-it.'
      renderPlanWorthItSection(worthEl, null, message, {
        onFeeChange: () => undefined,
        onShowInference: () => undefined,
      })
    }
  }

  async function refreshLedger(): Promise<void> {
    try {
      cachedSummary = await api.usage.getSummary()
      showPeriod(activePeriod)
    } catch (err) {
      bodyEl.textContent =
        err instanceof Error ? `Failed to load usage: ${err.message}` : 'Failed to load usage.'
    }
  }

  function scheduleLedgerRefresh(): void {
    if (ledgerRefreshTimer !== undefined) clearTimeout(ledgerRefreshTimer)
    ledgerRefreshTimer = setTimeout(() => {
      ledgerRefreshTimer = undefined
      void refreshLedger()
    }, LEDGER_REFRESH_DEBOUNCE_MS)
  }

  async function refresh(): Promise<void> {
    if (!cachedSummary) {
      bodyEl.textContent = 'Loading usage…'
    }
    // Plan fetch samples window history; worth-it must run after that sample lands.
    const planThenWorth = refreshPlan().then(() => refreshWorthIt())
    const frontierPromise = frontierPanel.refresh()
    try {
      cachedSummary = await api.usage.getSummary()
      showPeriod(activePeriod)
    } catch (err) {
      bodyEl.textContent =
        err instanceof Error ? `Failed to load usage: ${err.message}` : 'Failed to load usage.'
    }
    await planThenWorth
    await frontierPromise
  }

  const unsubUsage = store?.on('usage_updated', () => {
    if (root.closest('.settings-section')?.classList.contains('active')) {
      // Agent turns emit many usage deltas — only roll up the local ledger; plan
      // windows and the frontier chart stay on the main-process TTL cache.
      scheduleLedgerRefresh()
    }
  })

  return {
    root,
    refresh,
    detach: (): void => {
      unsubUsage?.()
      if (ledgerRefreshTimer !== undefined) clearTimeout(ledgerRefreshTimer)
    },
  }
}
