// The "model value map": a small scatter of every intellect-scored model on
// intellect (y, canonical Intelligence Index scale) vs cost (x), with the
// Pareto frontier drawn through the undominated points. Cost defaults to
// blended $/MTok at the 80/20 mix; a toggle switches X to Artificial
// Analysis cost-per-Intelligence-Index-task (verbosity-aware). Answers
// "which models are worth their price" at a glance; each point's native
// tooltip carries the full derivation (measurement, citation, any
// equating/quant adjustment) from `explainIntellectScore` so no number is
// unexplained.
//
// Composite-scored local models (copse-intellect scale) are deliberately NOT
// plotted · their scale is not the canonical index scale, and mixing scales
// would fake a comparison. They are listed beneath the chart instead.
//
// Rendering notes: one series with an emphasis state (accent = on frontier,
// neutral = dominated, hollow = estimated), direct labels because the point
// count is small, text/grid on theme tokens so light/dark both work, no
// second y-axis ever.

import {
  blendedPricePerMTok,
  blendedRate,
  computeParetoFrontier,
  frontierForKnownModels,
  projectOntoCostAxis,
  type FrontierCandidate,
  type FrontierCostAxis,
  type FrontierPoint,
} from '@copse/llm/pareto-frontier.ts'
import {
  extraProviderFrontierCandidates,
  localFrontierCandidates,
  openRouterFrontierCandidates,
  type OpenRouterPricedModel,
} from '@copse/llm/frontier-candidates.ts'
import { TRACKED_MODELS, getModelInfo } from '@copse/llm/model-catalog.ts'
import { parseModelSelection } from '@copse/llm/model-selection.ts'

import {
  getIntellectScore,
  listIntellectScoredModelIds,
  resolveIntellectModelId,
  INTELLECT_ATTRIBUTION,
} from '@copse/llm/model-intellect.ts'
import { liveIntellectCandidates, type LiveAaModel } from '@copse/llm/live-intellect.ts'
import type { ExtraProvider } from '@copse/llm/extra-providers.ts'
import { compositeIntellect } from '@copse/llm/composite-intellect.ts'
import { getLocalModelCapability } from '@copse/llm/local-model-catalog.ts'
import { isNoTrainingModelPath, isZeroRetentionModelPath } from '@copse/llm/data-policies.ts'
import type { PlanUsageSnapshot } from '@copse/plan-usage'
import {
  applyPlanCoverage,
  resolvePlanInclusion,
  type PlanCoverageMode,
} from '@shared/plan-inclusion.ts'
import { planAcpFrontierCandidates } from '@shared/plan-frontier-candidates.ts'
import type { AcpAgentConfig } from '@shared/types/acp.ts'
import { el } from '../dom/helpers.ts'
import {
  renderChart,
  renderCompositeStrip,
  renderBandedModelList,
  renderProviderGroupedList,
  renderFrontierKey,
  UNSCORED_ROW_LIMIT,
  type CanonicalScoredModel,
  type CompositeScoredModel,
  type FrontierGutters,
} from './intellect-frontier-chart.ts'
import {
  createTooltipLayer,
  displayModelLabel,
  requestFrontierModelCards,
  type FrontierTooltip,
} from './intellect-frontier-tooltip.ts'
export {
  renderCompositeStrip,
  renderFrontierSvg,
  renderBandedModelList,
  renderProviderGroupedList,
  renderFrontierKey,
  UNSCORED_ROW_LIMIT,
  UNPRICED_GUTTER_LIMIT,
} from './intellect-frontier-chart.ts'
export type {
  CanonicalScoredModel,
  CompositeScoredModel,
  FrontierGutters,
  FrontierLabelMode,
  BandedRow,
} from './intellect-frontier-chart.ts'
export {
  createTooltipLayer,
  displayModelLabel,
  pointTooltipContent,
  positionFrontierTooltip,
  TOOLTIP_HIDE_GRACE_MS,
  unpricedTooltipContent,
  unscoredTooltipContent,
  setModelCardApi,
} from './intellect-frontier-tooltip.ts'
export type { FrontierTooltip, ModelCardResolveApi } from './intellect-frontier-tooltip.ts'

/** Card links warmed per render. Matches the `model-cards:resolve` batch cap. */
const MAX_CARD_PREFETCH = 128

export type { OpenRouterPricedModel }
export { extraProviderFrontierCandidates, localFrontierCandidates, openRouterFrontierCandidates }

export interface OpenRouterFrontierSource {
  models: readonly OpenRouterPricedModel[]
  zdrOnly: boolean
  allowTraining: boolean
}

/** Local models whose only capability number is the composite (own scale). */
export function compositeScoredLocalModels(
  localModelIds: readonly string[],
): CompositeScoredModel[] {
  const out: CompositeScoredModel[] = []
  for (const id of localModelIds) {
    const cap = getLocalModelCapability(id)
    if (!cap || cap.benchmarks['aa-intelligence']) continue
    const composite = compositeIntellect(cap)
    if (composite) out.push({ id, composite })
  }
  return out
}

/** Drop frontier annotations so a point can be re-projected onto another cost axis. */
function asFrontierCandidate(p: FrontierPoint): FrontierCandidate {
  const { onFrontier: _onFrontier, dominatedBy: _dominatedBy, ...candidate } = p
  return candidate
}

/**
 * Canonical-scored models with no cost coordinate: curated measurements whose
 * model isn't plotted anywhere (no catalog/provider pricing), plus live-scored
 * unpriced models. They share the main chart's scale, so they get a one-axis
 * strip rather than being dropped to a footnote · position on intellect only.
 */
export function unpricedCanonicalModels(
  plottedIds: ReadonlySet<string>,
  liveHintOnly: readonly { id: string; intellect: number }[],
): CanonicalScoredModel[] {
  const out: CanonicalScoredModel[] = []
  for (const id of listIntellectScoredModelIds()) {
    if (plottedIds.has(id)) continue
    const score = getIntellectScore(id)
    if (!score) continue
    out.push({
      id,
      intellect: score.value,
      estimated: score.estimated === true,
    })
  }
  for (const live of liveHintOnly) {
    out.push({ id: live.id, intellect: live.intellect, estimated: true })
  }
  return out.sort((a, b) => b.intellect - a.intellect || a.id.localeCompare(b.id))
}

/**
 * Priced models with no sourced score: tracked cloud models whose measurement
 * is absent, plus priced extra-provider models nothing resolves for. They get
 * the bottom "no score" gutter at their true price.
 */
export function unscoredPricedModels(
  extraProviders: readonly ExtraProvider[],
): Array<{ id: string; costPerMTok: number }> {
  const out: Array<{ id: string; costPerMTok: number }> = []
  for (const id of TRACKED_MODELS) {
    const info = getModelInfo(id)
    if (!info || getIntellectScore(id)) continue
    out.push({ id, costPerMTok: blendedPricePerMTok(info) })
  }
  for (const provider of extraProviders) {
    for (const m of provider.models) {
      if (typeof m.inputPricePerMTok !== 'number' || getIntellectScore(m.id)) continue
      out.push({
        id: `${provider.id}:${m.id}`,
        costPerMTok: blendedRate(m.inputPricePerMTok, m.outputPricePerMTok ?? m.inputPricePerMTok),
      })
    }
  }
  return out.sort((a, b) => a.costPerMTok - b.costPerMTok || a.id.localeCompare(b.id))
}

/**
 * The two "below the chart" disclosures: scored-but-unpriced models in intellect
 * bands, and priced-but-unscored models grouped by provider. Shared so the
 * pop-out shows the same lists the inline panel does (its gutter only overlays
 * the top few on the chart itself).
 */
function buildAuxLists(
  unpricedList: readonly CanonicalScoredModel[],
  unscoredList: readonly { id: string; costPerMTok: number }[],
): HTMLElement[] {
  const out: HTMLElement[] = []
  if (unpricedList.length > 0) {
    out.push(
      el(
        'details',
        { class: 'field-hint frontier-unpriced-list' },
        el('summary', {}, `${String(unpricedList.length)} scored models with no price data yet`),
        renderBandedModelList(
          unpricedList.map((u) => ({
            id: u.id,
            intellect: u.intellect,
            estimated: u.estimated,
          })),
        ),
      ),
    )
  }
  if (unscoredList.length > UNSCORED_ROW_LIMIT) {
    out.push(
      el(
        'details',
        { class: 'field-hint frontier-unscored-list' },
        el(
          'summary',
          {},
          `${String(unscoredList.length)} priced models without an intellect score`,
        ),
        renderProviderGroupedList([...unscoredList]),
      ),
    )
  }
  return out
}

export interface IntellectFrontierPanel {
  root: HTMLFieldSetElement
  refresh: (signal?: AbortSignal) => Promise<void>
  /** Switch plan re-pricing for the value map (Plan / Inference / Expected). */
  setPlanCoverageMode: (mode: PlanCoverageMode) => void
  getPlanCoverageMode: () => PlanCoverageMode
  /** Feed completed-window exhaustion rates for Expected plan mode. */
  setWindowExhaustion: (rates: ReadonlyMap<string, { hit: number; total: number }>) => void
}

/**
 * The settings panel: chart + composite footnotes, refreshed with the loaded
 * local models so on-device options appear as they become available. Renders a
 * quiet placeholder when nothing has a sourced score yet · never an invented
 * point.
 */
export interface LiveModelsFetch {
  ok: boolean
  models: LiveAaModel[]
  /** Index version the feed declared (e.g. "4.1"); gate input when present. */
  indexVersion?: string | number
  error?: string
}

export function createIntellectFrontierPanel(
  loadLocalModels: () => Promise<string[]>,
  loadExtraProviders?: () => Promise<readonly ExtraProvider[]>,
  loadLiveModels?: () => Promise<LiveModelsFetch>,
  loadPlanUsage?: () => Promise<PlanUsageSnapshot>,
  loadOpenRouter?: () => Promise<OpenRouterFrontierSource>,
  /**
   * The model selections the real picker currently offers. Absent preserves
   * the standalone/test helper's catalog-wide behaviour; production supplies
   * this so the default map never advertises an unavailable route.
   */
  loadRoutableModelSelections?: () => Promise<readonly string[]>,
  /** Configured ACP agents, used to attach subscription billing to exact routes. */
  loadAcpAgents?: () => Promise<readonly AcpAgentConfig[]>,
): IntellectFrontierPanel {
  const chartHost = el('div', { class: 'frontier-chart' })
  const liveNotes = el('div', { class: 'field-hint frontier-live-notes' })
  const compositeHost = el('div', { class: 'frontier-composite-strip' })
  let lastPoints: FrontierPoint[] = []
  let lastGutters: FrontierGutters = {}
  // Fetched inputs, cached so the Discover toggle re-renders without refetching.
  let state: {
    localIds: string[]
    extraProviders: readonly ExtraProvider[]
    live: ReturnType<typeof liveIntellectCandidates>
    liveFetch: LiveModelsFetch
    planUsage: PlanUsageSnapshot | null
    openRouter: OpenRouterFrontierSource
    routableSelections: readonly string[] | null
    acpAgents: readonly AcpAgentConfig[]
  } | null = null
  let discover = false
  let showUnpriced = false
  let zdrOnly = false
  let noTrainingOnly = false
  let costAxis: FrontierCostAxis = 'blended'
  let planCoverageMode: PlanCoverageMode = 'plan'
  let windowExhaustion: ReadonlyMap<string, { hit: number; total: number }> = new Map()
  let historyAvailable = false
  let expandPlanCoverageGroup: HTMLElement | null = null
  // The full lists behind the chart, cached so the pop-out can show the same
  // "below the chart" content the inline panel does.
  let lastUnpriced: readonly CanonicalScoredModel[] = []
  let lastUnscored: readonly { id: string; costPerMTok: number }[] = []
  // The open pop-out's chart host + tooltip + toggle buttons (null when closed).
  // render() repaints these in place so the pop-out's own Discover / Show
  // unpriced toggles behave exactly like the inline chart's.
  let expandChartHost: HTMLElement | null = null
  let expandTooltip: FrontierTooltip | null = null
  let expandDiscoverBtn: HTMLButtonElement | null = null
  let expandUnpricedBtn: HTMLButtonElement | null = null
  let expandZdrBtn: HTMLButtonElement | null = null
  let expandNoTrainingBtn: HTMLButtonElement | null = null
  let expandCostAxisGroup: HTMLElement | null = null

  function toggleDiscover(): void {
    discover = !discover
    render()
  }
  function toggleUnpriced(): void {
    showUnpriced = !showUnpriced
    render()
  }
  function toggleZdrOnly(): void {
    zdrOnly = !zdrOnly
    render()
  }
  function toggleNoTrainingOnly(): void {
    noTrainingOnly = !noTrainingOnly
    render()
  }
  function setCostAxis(next: FrontierCostAxis): void {
    if (costAxis === next) return
    costAxis = next
    render()
  }
  function setPlanCoverageMode(next: PlanCoverageMode): void {
    if (planCoverageMode === next) return
    planCoverageMode = next
    render()
  }
  function setWindowExhaustion(rates: ReadonlyMap<string, { hit: number; total: number }>): void {
    windowExhaustion = rates
    render()
  }

  function syncZdrBtn(btn: HTMLButtonElement | null): void {
    if (!btn) return
    btn.textContent = 'ZDR only'
    btn.classList.toggle('active', zdrOnly)
    btn.setAttribute('aria-pressed', zdrOnly ? 'true' : 'false')
    btn.title =
      'Show only models on zero-data-retention paths (local, Fireworks, Together, OpenRouter ZDR routing, HF partner tags). Matches the Settings privacy badge · not enterprise-contract ZDR.'
  }

  function syncNoTrainingBtn(btn: HTMLButtonElement | null): void {
    if (!btn) return
    btn.textContent = 'No training'
    btn.classList.toggle('active', noTrainingOnly)
    btn.setAttribute('aria-pressed', noTrainingOnly ? 'true' : 'false')
    btn.title =
      'Show only routes known not to train on prompts. Includes local, ZDR, and retained-but-no-training providers; unknown policies are hidden.'
  }

  function makeCostAxisGroup(): HTMLElement {
    const group = el('span', {
      class: 'frontier-cost-axis',
      role: 'group',
      'aria-label': 'Cost axis',
    })
    const blendedBtn = el(
      'button',
      {
        type: 'button',
        class: 'frontier-btn frontier-cost-axis-btn',
        'data-cost-axis': 'blended',
      },
      '$/MTok',
    )
    const taskBtn = el(
      'button',
      {
        type: 'button',
        class: 'frontier-btn frontier-cost-axis-btn',
        'data-cost-axis': 'perTask',
        hidden: true,
        disabled: true,
      },
      '$/task',
    )
    blendedBtn.addEventListener('click', () => {
      setCostAxis('blended')
    })
    taskBtn.addEventListener('click', () => {
      setCostAxis('perTask')
    })
    group.append(blendedBtn, taskBtn)
    return group
  }

  function makePlanCoverageGroup(): HTMLElement {
    const group = el('span', {
      class: 'frontier-cost-axis frontier-plan-coverage',
      role: 'group',
      'aria-label': 'Plan cost basis',
    })
    const modes: Array<{
      mode: PlanCoverageMode
      label: string
      title: string
    }> = [
      {
        mode: 'plan',
        label: 'Plan',
        title: 'Re-price subscription-included models at $0 while their window has headroom',
      },
      {
        mode: 'inference',
        label: 'Inference',
        title: 'Ignore the plan · plot every cloud model at catalog API $/MTok',
      },
      {
        mode: 'expected',
        label: 'Expected',
        title:
          'Use prior window history: if a binding window usually hits its limit, plot at API price',
      },
    ]
    for (const { mode, label, title } of modes) {
      const btn = el(
        'button',
        {
          type: 'button',
          class: 'frontier-btn frontier-cost-axis-btn',
          'data-plan-coverage': mode,
          hidden: mode === 'expected',
          title,
        },
        label,
      )
      btn.addEventListener('click', () => {
        setPlanCoverageMode(mode)
      })
      group.append(btn)
    }
    return group
  }

  function syncPlanCoverageGroup(group: HTMLElement | null): void {
    if (!group) return
    for (const btn of group.querySelectorAll<HTMLButtonElement>('[data-plan-coverage]')) {
      const mode = btn.dataset['planCoverage']
      btn.hidden = mode === 'expected' && !historyAvailable
      const active = mode === planCoverageMode
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    }
  }

  function makeDiscoverButton(): HTMLButtonElement {
    const button = el(
      'button',
      {
        type: 'button',
        class: 'frontier-btn frontier-discover',
      },
      el(
        'span',
        { class: 'frontier-discover-label', 'data-discover-label': 'inactive' },
        'Discover models',
      ),
      el(
        'span',
        {
          class: 'frontier-discover-label',
          'data-discover-label': 'active',
          'aria-hidden': 'true',
        },
        'Hide discoverable',
      ),
    )
    button.addEventListener('click', toggleDiscover)
    return button
  }

  const discoverBtn = makeDiscoverButton()
  const unpricedBtn = el('button', {
    type: 'button',
    class: 'frontier-btn frontier-unpriced-toggle',
  })
  unpricedBtn.addEventListener('click', toggleUnpriced)
  const zdrBtn = el('button', {
    type: 'button',
    class: 'frontier-btn frontier-zdr-toggle',
  })
  zdrBtn.addEventListener('click', toggleZdrOnly)
  const noTrainingBtn = el('button', {
    type: 'button',
    class: 'frontier-btn frontier-no-training-toggle',
  })
  noTrainingBtn.addEventListener('click', toggleNoTrainingOnly)
  const costAxisGroup = makeCostAxisGroup()
  const planCoverageGroup = makePlanCoverageGroup()
  const expandBtn = el(
    'button',
    { type: 'button', class: 'frontier-btn frontier-expand' },
    'Expand',
  )
  expandBtn.addEventListener('click', () => {
    if (lastPoints.length === 0) return
    const dialog = el('dialog', { class: 'frontier-expand-dialog' })
    const close = el('button', { type: 'button', class: 'frontier-btn' }, 'Close')
    expandDiscoverBtn = makeDiscoverButton()
    expandUnpricedBtn = el('button', {
      type: 'button',
      class: 'frontier-btn frontier-unpriced-toggle',
    })
    expandUnpricedBtn.addEventListener('click', toggleUnpriced)
    expandZdrBtn = el('button', {
      type: 'button',
      class: 'frontier-btn frontier-zdr-toggle',
    })
    expandZdrBtn.addEventListener('click', toggleZdrOnly)
    expandNoTrainingBtn = el('button', {
      type: 'button',
      class: 'frontier-btn frontier-no-training-toggle',
    })
    expandNoTrainingBtn.addEventListener('click', toggleNoTrainingOnly)
    expandCostAxisGroup = makeCostAxisGroup()
    expandPlanCoverageGroup = makePlanCoverageGroup()
    const bigChart = el('div', {
      class: 'frontier-chart frontier-expand-chart',
    })
    expandChartHost = bigChart
    expandTooltip = createTooltipLayer(dialog)
    const closeDialog = (): void => {
      expandChartHost = null
      expandTooltip?.dismiss()
      expandTooltip = null
      expandDiscoverBtn = null
      expandUnpricedBtn = null
      expandZdrBtn = null
      expandNoTrainingBtn = null
      expandCostAxisGroup = null
      expandPlanCoverageGroup = null
      dialog.remove()
    }
    close.addEventListener('click', closeDialog)
    // Esc on a modal dialog fires `cancel`, not a click on Close.
    dialog.addEventListener('cancel', closeDialog)
    dialog.append(
      el(
        'div',
        { class: 'frontier-expand-controls' },
        expandCostAxisGroup,
        expandPlanCoverageGroup,
        expandZdrBtn,
        expandNoTrainingBtn,
        expandDiscoverBtn,
        expandUnpricedBtn,
        close,
      ),
      bigChart,
    )
    fieldset.append(dialog)
    // Paint the pop-out (and sync its toggle buttons) from current state.
    render()
    // jsdom (tests) lacks showModal; the open attribute is the fallback.
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
  })
  const fieldset = el(
    'fieldset',
    { class: 'frontier-fieldset' },
    el('legend', {}, 'Model value map'),
    el(
      'p',
      { class: 'settings-fieldset-desc' },
      'Compare model scores and prices. Models on the line offer the best value at their level. Hover for details, or click a model to keep its details open.',
    ),
    el(
      'div',
      { class: 'frontier-controls' },
      el('span', { class: 'frontier-control-group' }, costAxisGroup),
      el('span', { class: 'frontier-control-group' }, planCoverageGroup),
      el('span', { class: 'frontier-control-group' }, zdrBtn, noTrainingBtn),
      el('span', { class: 'frontier-control-group' }, discoverBtn, unpricedBtn, expandBtn),
    ),
    chartHost,
    renderFrontierKey(),
    liveNotes,
    compositeHost,
  )
  const panelTooltip = createTooltipLayer(fieldset)

  async function refresh(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    signal?.addEventListener(
      'abort',
      () => {
        panelTooltip.dismiss()
        expandTooltip?.dismiss()
      },
      { once: true },
    )
    let localIds: string[]
    if (signal?.aborted) return
    try {
      localIds = await loadLocalModels()
    } catch {
      localIds = []
    }
    let extraProviders: readonly ExtraProvider[]
    if (signal?.aborted) return
    try {
      extraProviders = (await loadExtraProviders?.()) ?? []
    } catch {
      extraProviders = []
    }
    let liveFetch: LiveModelsFetch
    if (signal?.aborted) return
    try {
      liveFetch = (await loadLiveModels?.()) ?? { ok: true, models: [] }
    } catch {
      liveFetch = { ok: true, models: [] }
    }
    let planUsage: PlanUsageSnapshot | null
    if (signal?.aborted) return
    try {
      planUsage = (await loadPlanUsage?.()) ?? null
    } catch {
      planUsage = null
    }
    let openRouter: OpenRouterFrontierSource
    if (signal?.aborted) return
    try {
      openRouter = (await loadOpenRouter?.()) ?? {
        models: [],
        zdrOnly: true,
        allowTraining: false,
      }
    } catch {
      openRouter = { models: [], zdrOnly: true, allowTraining: false }
    }
    let routableSelections: readonly string[] | null = null
    if (loadRoutableModelSelections) {
      if (signal?.aborted) return
      try {
        routableSelections = await loadRoutableModelSelections()
      } catch {
        // Fail closed: a picker load failure must not turn the static catalog
        // into a list of models that only look available.
        routableSelections = []
      }
    }
    let acpAgents: readonly AcpAgentConfig[] = []
    if (signal?.aborted) return
    try {
      acpAgents = (await loadAcpAgents?.()) ?? []
    } catch {
      // Missing settings should remove plan routes, never broaden them.
    }
    // The gate: live models join ONLY when the feed's declared index version
    // matches the canonical one (when declared) AND its values agree with our
    // curated anchors · a renormalised feed must never share the axis.
    if (signal?.aborted) return
    const live = liveIntellectCandidates(liveFetch.models, liveFetch.indexVersion)
    state = {
      localIds,
      extraProviders,
      live,
      liveFetch,
      planUsage,
      openRouter,
      routableSelections,
      acpAgents,
    }
    if (signal?.aborted) return
    render()
  }

  // Fill the open pop-out with a large chart plus the same lists the inline
  // panel shows below its chart (so its "in the list below" gutter note is
  // accurate). A no-op when no pop-out is open.
  function paintExpanded(): void {
    if (!expandChartHost) return
    expandChartHost.replaceChildren(
      renderChart(
        lastPoints,
        lastGutters,
        expandTooltip ?? undefined,
        {
          width: 1200,
          height: 680,
        },
        costAxis,
        'all',
      ),
      ...buildAuxLists(lastUnpriced, lastUnscored),
    )
  }

  function syncCostAxisGroup(group: HTMLElement | null, taskCostAvailable: boolean): void {
    if (!group) return
    group.querySelectorAll<HTMLButtonElement>('button.frontier-cost-axis-btn').forEach((btn) => {
      const axis = btn.dataset['costAxis'] === 'perTask' ? 'perTask' : 'blended'
      btn.classList.toggle('active', axis === costAxis)
      btn.setAttribute('aria-pressed', axis === costAxis ? 'true' : 'false')
      if (axis === 'perTask') {
        btn.hidden = !taskCostAvailable
        btn.disabled = !taskCostAvailable
        btn.title = taskCostAvailable
          ? 'Plot Artificial Analysis cost per Intelligence Index task'
          : 'Needs Artificial Analysis live data with cost-per-task'
      } else {
        btn.disabled = false
        btn.title = 'Plot blended $/MTok (80% input / 20% output)'
      }
    })
  }

  function render(): void {
    if (!state) return
    const {
      localIds,
      extraProviders,
      live,
      liveFetch,
      planUsage,
      openRouter,
      routableSelections,
      acpAgents,
    } = state
    const liveNoteParts: Array<string | HTMLElement> = []
    if (liveFetch.models.length > 0 && live.verification.verified) {
      const stale = live.verification.mismatches
      liveNoteParts.push(
        `Live scores from Artificial Analysis, checked against ${String(live.verification.agreeingAnchors)} reviewed measurements. ${INTELLECT_ATTRIBUTION}.`,
      )
      if (stale.length > 0) {
        // Keep measurement differences explainable without exposing development commands.
        liveNoteParts.push(
          el(
            'details',
            { class: 'frontier-stale-anchors' },
            el(
              'summary',
              {},
              `${String(stale.length)} reviewed measurement${stale.length === 1 ? '' : 's'} differ${stale.length === 1 ? 's' : ''} from the live source`,
            ),
            el(
              'p',
              {},
              `${stale
                .map(
                  (m) =>
                    `${displayModelLabel(m.modelId)} (map ${String(m.canonical)}, live ${String(m.live)})`,
                )
                .join('; ')}.`,
            ),
          ),
        )
      }
    } else if (liveFetch.models.length > 0) {
      // Keep incompatible measurements out of the comparison and explain why.
      const v = live.verification
      const detail: Array<string | HTMLElement> = [
        v.versionMismatch
          ? el(
              'p',
              {},
              `Live scores use benchmark version ${v.reportedVersion ?? '?'}, which differs from this chart. Showing reviewed measurements keeps the comparison consistent.`,
            )
          : el(
              'p',
              {},
              'The feed disagrees with the reviewed scores this map is anchored to, which usually means Artificial Analysis renormalised its index or measures a different model configuration.',
            ),
      ]
      if (v.mismatches.length > 0) {
        detail.push(
          el(
            'p',
            {},
            `Measurements that differ: ${v.mismatches
              .map(
                (m) =>
                  `${displayModelLabel(m.modelId)} (map ${String(m.canonical)}, live ${String(m.live)})`,
              )
              .join('; ')}.`,
          ),
        )
      }
      liveNoteParts.push(
        el(
          'details',
          {},
          el('summary', {}, 'Some live model scores cannot be compared with this chart'),
          ...detail,
        ),
      )
    } else if (liveFetch.error) {
      liveNoteParts.push(`Live Artificial Analysis data unavailable: ${liveFetch.error}`)
    }
    // A verified feed can also PRICE curated models we couldn't plot before
    // (curated score wins, feed contributes the cost) · but never where a
    // catalog or provider price already covers the model.
    const pricedRoutes = [
      ...extraProviderFrontierCandidates(extraProviders),
      ...openRouterFrontierCandidates(openRouter.models),
    ]
    const baseCandidates = [
      ...localFrontierCandidates(localIds),
      ...pricedRoutes,
      ...planAcpFrontierCandidates(acpAgents, pricedRoutes),
    ]
    const exactRoutes = routableSelections === null ? null : new Set(routableSelections)
    const delegatedModelIds = new Set<string>()
    const routableModelIds = new Set<string>()
    for (const selection of routableSelections ?? []) {
      const resolved = resolveIntellectModelId(selection)
      if (resolved !== null) routableModelIds.add(resolved)
      const namespace = parseModelSelection(selection).namespace
      if (namespace !== 'acp' && namespace !== 'remote-agent' && namespace !== 'plugin-model') {
        continue
      }
      if (resolved !== null) delegatedModelIds.add(resolved)
    }
    const modelIdentityHasRoute = (id: string): boolean => {
      if (exactRoutes === null) return true
      const resolved = resolveIntellectModelId(id) ?? id
      return routableModelIds.has(resolved)
    }
    const isTrackedCloudCandidate = (candidate: FrontierCandidate): boolean =>
      TRACKED_MODELS.some((id) => id === candidate.id)
    const candidateHasRoute = (candidate: FrontierCandidate): boolean => {
      if (exactRoutes === null) return true
      if (exactRoutes.has(candidate.id)) return true
      if (candidate.local === true && exactRoutes.has(`lmstudio:${candidate.id}`)) return true
      if (!isTrackedCloudCandidate(candidate)) return false
      const resolved = resolveIntellectModelId(candidate.id) ?? candidate.id
      return delegatedModelIds.has(resolved)
    }
    const routableBaseCandidates = baseCandidates.filter(candidateHasRoute)
    const coveredResolved = new Set(
      routableBaseCandidates.map((c) => resolveIntellectModelId(c.id) ?? c.id),
    )
    const livePricedCurated = live.pricedCurated.filter(
      (c) => !coveredResolved.has(c.id) && getModelInfo(c.id) === null,
    )
    // A reviewed score does not make a model routable. The full AA sync curates
    // hundreds of measurements, so a priced curated row with no catalog or
    // configured-provider route is still a discovery opportunity. Keeping it
    // behind the same toggle prevents historical/configuration variants from
    // flooding the default map; dominated discoveries collapse below, so an
    // expensive legacy model cannot stretch the price axis either.
    const liveDiscoverableCandidates: FrontierCandidate[] = [
      ...live.candidates,
      ...livePricedCurated.map((candidate) => ({
        ...candidate,
        discovery: true,
      })),
    ]
    const trackedDiscoverableCandidates: FrontierCandidate[] = []
    if (exactRoutes !== null) {
      for (const id of TRACKED_MODELS) {
        const info = getModelInfo(id)
        const score = getIntellectScore(id)
        if (!info || !score) continue
        const candidate: FrontierCandidate = {
          id,
          intellect: score.value,
          intellectEstimated: score.estimated === true,
          costPerMTok: blendedPricePerMTok(info),
          discovery: true,
        }
        if (!candidateHasRoute(candidate)) trackedDiscoverableCandidates.push(candidate)
      }
    }
    const discoverableCandidates = [...liveDiscoverableCandidates, ...trackedDiscoverableCandidates]
    const applyDiscover = (btn: HTMLButtonElement | null): void => {
      if (!btn) return
      btn.hidden = discoverableCandidates.length === 0
      for (const label of btn.querySelectorAll<HTMLElement>('[data-discover-label]')) {
        const labelIsActive = label.dataset['discoverLabel'] === 'active'
        label.setAttribute('aria-hidden', labelIsActive === discover ? 'false' : 'true')
      }
      btn.classList.toggle('active', discover)
      btn.setAttribute('aria-pressed', discover ? 'true' : 'false')
    }
    applyDiscover(discoverBtn)
    applyDiscover(expandDiscoverBtn)
    // Discovery models join the frontier computation only when requested · by
    // default the map shows models the user can actually route to.
    // Tracked catalog models are already supplied by frontierForKnownModels;
    // only live/feed discoveries need to join the extra-candidate list here.
    const discoveryCandidates = discover ? liveDiscoverableCandidates : []
    // Live AA cost-per-task attaches to curated catalog models too (the feed
    // otherwise only prices models missing from the catalog).
    const costPerTaskById = new Map<string, number>()
    for (const m of liveFetch.models) {
      if (typeof m.costPerTask !== 'number' || !(m.costPerTask > 0)) continue
      const key = resolveIntellectModelId(m.id) ?? m.id
      if (!costPerTaskById.has(key)) costPerTaskById.set(key, m.costPerTask)
    }
    const enrichTaskCost = (c: FrontierCandidate): FrontierCandidate => {
      if (typeof c.costPerTask === 'number' && c.costPerTask > 0) return c
      const key = resolveIntellectModelId(c.id) ?? c.id
      const task = costPerTaskById.get(key)
      return typeof task === 'number' ? { ...c, costPerTask: task } : c
    }
    // Re-price each model against the live plan snapshot: a plan-covered model
    // drops to $0 (best price → wins the frontier) with a plan badge; a model
    // whose plan window is spent keeps its real price and carries a
    // limit-reached note. Applied before identity grouping so the free ACP
    // route wins over paid routes to the same weights.
    const allRouteCandidates = [...baseCandidates, ...discoveryCandidates]
    const trackedCandidateIsDiscovery = (candidate: FrontierCandidate): boolean =>
      exactRoutes !== null && isTrackedCloudCandidate(candidate) && !candidateHasRoute(candidate)
    const candidateIsIncluded = (candidate: FrontierCandidate): boolean =>
      candidateHasRoute(candidate) ||
      candidate.discovery === true ||
      (discover && trackedCandidateIsDiscovery(candidate))
    historyAvailable = allRouteCandidates.some((candidate) => {
      if (
        !planUsage ||
        !candidate.planAccess ||
        candidate.discovery ||
        !candidateIsIncluded(candidate)
      )
        return false
      const inclusion = resolvePlanInclusion(
        candidate.planAccess.provider,
        candidate.planAccess.modelId,
        planUsage,
      )
      return inclusion !== null && (windowExhaustion.get(inclusion.windowId)?.total ?? 0) > 0
    })
    const adjustCandidate = (candidate: FrontierCandidate): FrontierCandidate => {
      const surfaced = trackedCandidateIsDiscovery(candidate)
        ? { ...candidate, discovery: true }
        : candidate
      const enriched = enrichTaskCost(surfaced)
      // A setup opportunity is not covered by a route the user owns today,
      // even if a broad subscription snapshot mentions the same family.
      return enriched.discovery === true
        ? enriched
        : applyPlanCoverage(enriched, planUsage, {
            mode: planCoverageMode,
            windowExhaustion,
          })
    }
    const routePolicy = {
      providers: extraProviders,
      openRouterZdrOnly: openRouter.zdrOnly,
      openRouterAllowTraining: openRouter.allowTraining,
    }
    const routeAllowed = (candidate: FrontierCandidate): boolean => {
      const local = candidate.local === true
      if (
        zdrOnly &&
        !isZeroRetentionModelPath(candidate.id, {
          ...routePolicy,
          ...(local ? { local: true } : {}),
        })
      ) {
        return false
      }
      return (
        !noTrainingOnly ||
        isNoTrainingModelPath(candidate.id, {
          ...routePolicy,
          ...(local ? { local: true } : {}),
        })
      )
    }
    if (planCoverageMode === 'expected' && !historyAvailable) planCoverageMode = 'plan'
    const unfilteredBlendedPoints = frontierForKnownModels(
      allRouteCandidates,
      adjustCandidate,
      candidateIsIncluded,
    )
    const privacyBlendedPoints =
      zdrOnly || noTrainingOnly
        ? frontierForKnownModels(
            allRouteCandidates,
            adjustCandidate,
            (candidate) => candidateIsIncluded(candidate) && routeAllowed(candidate),
          )
        : unfilteredBlendedPoints
    const hiddenByZdr = zdrOnly
      ? unfilteredBlendedPoints.length -
        frontierForKnownModels(
          allRouteCandidates,
          adjustCandidate,
          (candidate) =>
            candidateIsIncluded(candidate) &&
            isZeroRetentionModelPath(candidate.id, {
              ...routePolicy,
              ...(candidate.local === true ? { local: true } : {}),
            }),
        ).length
      : 0
    const hiddenByNoTraining = noTrainingOnly
      ? unfilteredBlendedPoints.length -
        frontierForKnownModels(
          allRouteCandidates,
          adjustCandidate,
          (candidate) =>
            candidateIsIncluded(candidate) &&
            isNoTrainingModelPath(candidate.id, {
              ...routePolicy,
              ...(candidate.local === true ? { local: true } : {}),
            }),
        ).length
      : 0
    const blendedPoints = privacyBlendedPoints
    const taskCostAvailable = blendedPoints.some(
      (p) => typeof p.costPerTask === 'number' && p.costPerTask > 0,
    )
    // If the task axis has no data, fall back so the chart never goes blank.
    if (costAxis === 'perTask' && !taskCostAvailable) costAxis = 'blended'
    syncCostAxisGroup(costAxisGroup, taskCostAvailable)
    syncCostAxisGroup(expandCostAxisGroup, taskCostAvailable)
    syncPlanCoverageGroup(planCoverageGroup)
    syncPlanCoverageGroup(expandPlanCoverageGroup)
    let allPoints: FrontierPoint[]
    let missingTaskCost = 0
    if (costAxis === 'perTask') {
      const { plotted, missingAxisCost } = projectOntoCostAxis(
        blendedPoints.map(asFrontierCandidate),
        'perTask',
      )
      allPoints = computeParetoFrontier(plotted)
      missingTaskCost = missingAxisCost.length
    } else {
      allPoints = blendedPoints
    }
    syncZdrBtn(zdrBtn)
    syncZdrBtn(expandZdrBtn)
    syncNoTrainingBtn(noTrainingBtn)
    syncNoTrainingBtn(expandNoTrainingBtn)
    // Discovery can carry a hundred-plus priced models; the map's job is the
    // frontier, so dominated setup opportunities collapse into a disclosure
    // rather than each claiming a labelled dot. Dropping dominated points
    // cannot change the frontier.
    const dominatedLive = allPoints.filter((p) => p.discovery === true && !p.onFrontier)
    const points = allPoints.filter((p) => p.discovery !== true || p.onFrontier)
    // Discoverable points are deliberately absent from the default chart, but
    // the feed still supplied their price. Exclude them from the "no price"
    // disclosure without pretending they are routable or plotting them. Use
    // the blended-price candidates rather than the current projected points:
    // a model missing AA task cost is still priced and belongs in the task-axis
    // note, not the generic no-price list.
    const pricedIds = new Set(
      [...blendedPoints, ...discoverableCandidates].map(
        (p) => resolveIntellectModelId(p.id) ?? p.id,
      ),
    )
    const unpricedModels = unpricedCanonicalModels(pricedIds, live.hintOnly).filter((u) => {
      if (!modelIdentityHasRoute(u.id)) return false
      if (zdrOnly && !isZeroRetentionModelPath(u.id, routePolicy)) return false
      return !noTrainingOnly || isNoTrainingModelPath(u.id, routePolicy)
    })
    lastPoints = points
    // Warm the card cache for what is plotted, so the first hover on a point
    // usually has its answer already. Fire-and-forget: nothing repaints on the
    // result · the hover path reads the cache, and repaints itself if an answer
    // arrives while a card is open. Capped to the IPC batch limit.
    void requestFrontierModelCards(points.slice(0, MAX_CARD_PREFETCH).map((p) => p.id))
    // The unpriced gutter is off by default (it can carry hundreds); the toggle
    // overlays the top few on the left axis, the full set stays in the list.
    const applyUnpriced = (btn: HTMLButtonElement | null): void => {
      if (!btn) return
      btn.hidden = unpricedModels.length === 0
      btn.textContent = showUnpriced ? 'Hide unpriced' : 'Show unpriced'
      btn.classList.toggle('active', showUnpriced)
    }
    applyUnpriced(unpricedBtn)
    applyUnpriced(expandUnpricedBtn)
    const unscoredAll = unscoredPricedModels(extraProviders)
    const filteredUnscored = unscoredAll.filter((model) => {
      if (
        !candidateHasRoute({
          id: model.id,
          intellect: 0,
          costPerMTok: model.costPerMTok,
        })
      ) {
        return false
      }
      if (zdrOnly && !isZeroRetentionModelPath(model.id, routePolicy)) return false
      return !noTrainingOnly || isNoTrainingModelPath(model.id, routePolicy)
    })
    lastGutters = {
      ...(showUnpriced ? { unpriced: unpricedModels } : {}),
      unscored: filteredUnscored,
    }
    // When discovery is OFF, tell the user how many models the toggle reveals.
    if (!discover && discoverableCandidates.length > 0) {
      const modelCount = discoverableCandidates.length
      liveNoteParts.push(
        el(
          'span',
          {},
          `${String(modelCount)} more priced and scored model${modelCount === 1 ? ' is' : 's are'} not currently available in your model picker · press “Discover models” to overlay where they'd sit on your frontier. `,
        ),
      )
    }
    if (costAxis === 'perTask' && missingTaskCost > 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          `${String(missingTaskCost)} model${missingTaskCost === 1 ? '' : 's'} lack AA task-cost data and are hidden on this axis. `,
        ),
      )
    }
    if (zdrOnly && hiddenByZdr > 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          `ZDR only: hiding ${String(hiddenByZdr)} model${hiddenByZdr === 1 ? '' : 's'} on retained-by-default paths (Anthropic/OpenAI API, …). `,
        ),
      )
    }
    if (noTrainingOnly && hiddenByNoTraining > 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          `No training: hiding ${String(hiddenByNoTraining)} model${hiddenByNoTraining === 1 ? '' : 's'} on training or unknown-policy routes. `,
        ),
      )
    }
    if (zdrOnly && points.length === 0) {
      liveNoteParts.push(
        el(
          'span',
          {},
          'No zero-retention models on this map yet · add a Fireworks/Together provider, an HF model pinned to a ZDR partner, a local model, or OpenRouter under default ZDR routing. ',
        ),
      )
    }
    if (discover && dominatedLive.length > 0) {
      liveNoteParts.push(
        el(
          'details',
          { class: 'frontier-dominated-live' },
          el(
            'summary',
            {},
            `${String(dominatedLive.length)} discoverable models are dominated (not worth setting up · better value already on your frontier)`,
          ),
          renderBandedModelList(
            dominatedLive.map((p) => ({
              id: p.id,
              intellect: p.intellect,
              estimated: p.intellectEstimated,
              costPerMTok: p.costPerMTok,
            })),
          ),
        ),
      )
    }
    const unscoredList = lastGutters.unscored ?? []
    // The disclosure lists the FULL unpriced set regardless of the gutter
    // toggle (the gutter only overlays the top few on the chart).
    const unpricedList = unpricedModels
    lastUnpriced = unpricedList
    lastUnscored = unscoredList
    panelTooltip.dismiss()
    expandTooltip?.dismiss()
    chartHost.replaceChildren(
      renderChart(points, lastGutters, panelTooltip, {}, costAxis),
      ...buildAuxLists(unpricedList, unscoredList),
    )
    // Repaint the pop-out from the same freshly computed data (no-op if closed).
    paintExpanded()
    liveNotes.replaceChildren(
      ...liveNoteParts.map((t) => (typeof t === 'string' ? el('span', {}, `${t} `) : t)),
    )
    const compositeModels = compositeScoredLocalModels(localIds)
    compositeHost.replaceChildren(
      ...(compositeModels.length > 0
        ? [
            el(
              'p',
              { class: 'field-hint' },
              'Local model scores use a separate scale and cannot be compared directly with the chart above:',
            ),
            renderCompositeStrip(compositeModels),
          ]
        : []),
    )
  }

  return {
    root: fieldset,
    refresh,
    setPlanCoverageMode,
    getPlanCoverageMode: () => planCoverageMode,
    setWindowExhaustion,
  }
}
