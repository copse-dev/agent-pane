import type { FrontierPoint, FrontierCostAxis } from '@copse/llm/pareto-frontier.ts'
import { TRACKED_MODELS, cloudModelDisplayLabel } from '@copse/llm/model-catalog.ts'
import {
  explainIntellectScore,
  resolveIntellectModelId,
  type IntellectDerivationStep,
} from '@copse/llm/model-intellect.ts'
import { requestModelCards, resolvedModelCard } from './model-card-cache.ts'
import { huggingFaceCardUrl } from '@copse/llm/model-cards.ts'
import type { CanonicalScoredModel } from './intellect-frontier-chart.ts'
import { el } from '../dom/helpers.ts'

/**
 * Compact display form of a model id for chart labels: provider prefixes and
 * vendor org paths are wrappers, not identity, so `huggingface:zai-org/
 * GLM-5.2:deepinfra` reads as `GLM-5.2:deepinfra`. Tooltips keep the full id.
 */
export function displayModelLabel(id: string): string {
  const resolved = resolveIntellectModelId(id)
  if (resolved !== null && TRACKED_MODELS.some((tracked) => tracked === resolved)) {
    return cloudModelDisplayLabel(resolved)
  }
  let s = resolved ?? id
  const sep = s.indexOf(':')
  if (sep > 0 && !s.slice(0, sep).includes('/')) s = s.slice(sep + 1)
  const slash = s.lastIndexOf('/')
  if (slash >= 0) s = s.slice(slash + 1)
  return cloudModelDisplayLabel(s || id)
}

/** Hover layer contract: renderers hand over content, the panel positions it. */
export interface FrontierTooltip {
  show: (content: HTMLElement, evt: MouseEvent, target?: Element) => void
  pin: (content: HTMLElement, evt: MouseEvent, target: Element) => void
  update: (content: HTMLElement, target: Element) => void
  hide: () => void
  dismiss: () => void
}

function ttRow(cls: string, ...children: (Node | string)[]): HTMLElement {
  return el('div', { class: cls }, ...children)
}

const formatPrice = (v: number): string => `$${String(Number(v.toFixed(2)))}/MTok`
const formatTaskPrice = (v: number): string => `$${String(Number(v.toFixed(2)))}/task`

/**
 * Append the "Card" section: a link to the vendor's own model card / system
 * card for this model. Nothing is appended unless a card has RESOLVED · an
 * absent or still-resolving card reads as absent, never as a placeholder link
 * that 404s. `wireTooltip` repaints the hover card when an answer lands.
 *
 * The anchor opens externally: an `http(s)` `target="_blank"` inside the
 * renderer is denied by the web-contents lockdown and handed to
 * `shell.openExternal`, so the card opens in the user's browser without this
 * panel needing an IPC client.
 */
function appendCardSection(root: HTMLElement, id: string, routes: readonly string[] = []): void {
  const card = resolvedModelCard(id)
  const huggingFace = [id, ...routes].map(huggingFaceCardUrl).find((url) => url !== null)
  if (!card && !huggingFace) return
  root.append(ttRow('tt-section', 'Model links'))
  const appendLink = (url: string, label: string, className: string): void => {
    root.append(
      ttRow(
        'tt-line',
        el(
          'a',
          {
            class: className,
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          label,
        ),
      ),
    )
  }
  if (card) appendLink(card.url, card.title, 'tt-card-link')
  if (huggingFace && huggingFace !== card?.url)
    appendLink(huggingFace, 'Hugging Face', 'tt-card-link tt-huggingface-link')
  if (card?.kind === 'index') {
    root.append(
      ttRow('tt-muted', `${card.publisher} publishes this model's card behind their card index.`),
    )
  }
}

/** ", resets Tue" from an ISO reset time, or '' when unknown/unparseable. */
function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const d = new Date(resetsAt)
  if (Number.isNaN(d.getTime())) return ''
  return `, resets ${d.toLocaleDateString(undefined, { weekday: 'short' })}`
}

/**
 * One score-derivation step as hover-card copy. The step ids (`measured`,
 * `equated`) are data labels, and the equating detail already opens with its
 * verb, so prefixing the id would print "equated: equated v4.3→v4.1".
 */
function derivationStepCopy(step: IntellectDerivationStep): string {
  const detail = step.detail.replaceAll('—', '·')
  if (step.step === 'measured') return `Measured ${detail}`
  if (detail.toLowerCase().startsWith(step.step.toLowerCase())) {
    return detail.charAt(0).toUpperCase() + detail.slice(1)
  }
  const label = step.step.charAt(0).toUpperCase() + step.step.slice(1)
  return `${label}: ${detail}`
}

function scoreScaleCopy(scale: string): string {
  return scale.replace(' (canonical)', '').replaceAll('—', '·')
}

/**
 * Rich hover card for a plotted point: bold identity, the score's full
 * derivation, every known price for the same weights, and frontier status.
 */
export function pointTooltipContent(
  p: FrontierPoint,
  costAxis: FrontierCostAxis = 'blended',
): HTMLElement {
  const root = el('div', { class: 'frontier-tooltip-content' })
  const label = displayModelLabel(p.id)
  root.append(ttRow('tt-title', el('strong', {}, label)))
  if (label !== p.id) root.append(ttRow('tt-muted', p.id))

  root.append(ttRow('tt-section', 'Score'))
  const explanation = explainIntellectScore(p.id)
  if (explanation) {
    root.append(
      ttRow(
        'tt-line',
        el('strong', {}, `${p.intellectEstimated ? '~' : ''}${String(p.intellect)}`),
        ` · ${scoreScaleCopy(explanation.scale)}`,
      ),
    )
    for (const step of explanation.steps) {
      root.append(ttRow('tt-muted', derivationStepCopy(step)))
    }
  } else {
    root.append(
      ttRow(
        'tt-line',
        el('strong', {}, `~${String(p.intellect)}`),
        ' · live Artificial Analysis value (not yet curated)',
      ),
    )
  }
  if (p.quant && p.intellectEstimated) {
    root.append(
      ttRow(
        'tt-muted',
        `Adjusted down for ${p.quant} quantisation · an estimate, not a measurement.`,
      ),
    )
  }

  root.append(ttRow('tt-section', p.prices?.length ? 'Prices' : 'Price'))
  const blended =
    p.blendedCostPerMTok ??
    (p.planDetail !== undefined ? p.planDetail.apiPricePerMTok : p.costPerMTok)
  const priceLine = p.plan
    ? el(
        'span',
        {},
        el('strong', {}, 'included in your plan'),
        costAxis === 'perTask'
          ? ` (${p.plan}) · ~$0 marginal task cost`
          : ` (${p.plan}) · ~$0 marginal token cost`,
      )
    : p.local
      ? el('span', {}, 'free (runs on-device)')
      : costAxis === 'perTask'
        ? el('span', {}, `${formatTaskPrice(p.costPerMTok)} AA Intelligence Index task (plotted)`)
        : el(
            'span',
            {},
            `${formatPrice(p.costPerMTok)} blended (80% in / 20% out)`,
            ...(p.prices?.length ? [' · best offer, plotted'] : []),
          )
  root.append(ttRow('tt-line', priceLine))
  if (costAxis === 'perTask') {
    if (!p.local && !p.plan) {
      root.append(
        ttRow('tt-muted', `${formatPrice(blended)} blended list price (80% in / 20% out).`),
      )
    }
  } else if (typeof p.costPerTask === 'number') {
    root.append(
      ttRow(
        'tt-muted',
        `Artificial Analysis cost per Intelligence Index task: ${formatTaskPrice(p.costPerTask)} (reflects verbosity, not just token price).`,
      ),
    )
  }
  for (const offer of p.prices ?? []) {
    root.append(
      ttRow('tt-muted', `${displayModelLabel(offer.id)}: ${formatPrice(offer.costPerMTok)}`),
    )
  }
  // Plan-covered: how much of the window is used + the off-plan fallback price.
  if (p.plan && p.planDetail) {
    root.append(
      ttRow(
        'tt-muted',
        `${String(Math.round(p.planDetail.usedPercent))}% of this plan window used${formatReset(p.planDetail.resetsAt)}.`,
      ),
      ttRow('tt-muted', `Off-plan you'd pay ${formatPrice(p.planDetail.apiPricePerMTok)} blended.`),
    )
    if (p.planDetail.priorLimitHits) {
      const { hit, total } = p.planDetail.priorLimitHits
      root.append(
        ttRow(
          'tt-muted',
          `Limit hit in ${String(hit)}/${String(total)} prior windows · still treating as included.`,
        ),
      )
    }
  }
  // Plan window spent: it's plotted at its real price now, not as included.
  if (p.planLimitReached) {
    const prior = p.planLimitReached.priorLimitHits
    const priorNote = prior
      ? ` Limit hit in ${String(prior.hit)}/${String(prior.total)} prior windows.`
      : ''
    root.append(
      ttRow(
        'tt-muted',
        prior
          ? `${p.planLimitReached.label} usually exhausted · plotted at off-plan price.${priorNote}`
          : `${p.planLimitReached.label} plan limit reached${formatReset(p.planLimitReached.resetsAt)} · plotted at its off-plan price.`,
      ),
    )
  }

  appendCardSection(
    root,
    p.id,
    p.prices?.map((offer) => offer.id),
  )

  root.append(
    ttRow(
      'tt-status',
      p.discovery
        ? p.onFrontier
          ? 'Not configured · setting up a provider would put this ON your value frontier.'
          : 'Not configured · available via Artificial Analysis if you set up a provider.'
        : p.onFrontier
          ? 'On the value frontier'
          : `Dominated by ${displayModelLabel(p.dominatedBy ?? '?')}`,
    ),
  )
  return root
}

/** Hover card for a right-gutter (scored, unpriced) model. */
export function unpricedTooltipContent(u: CanonicalScoredModel): HTMLElement {
  const root = el('div', { class: 'frontier-tooltip-content' })
  root.append(ttRow('tt-title', el('strong', {}, displayModelLabel(u.id))))
  if (displayModelLabel(u.id) !== u.id) root.append(ttRow('tt-muted', u.id))
  root.append(ttRow('tt-section', 'Score'))
  const explanation = explainIntellectScore(u.id)
  root.append(ttRow('tt-line', el('strong', {}, `${u.estimated ? '~' : ''}${String(u.intellect)}`)))
  for (const step of explanation?.steps ?? []) {
    root.append(ttRow('tt-muted', derivationStepCopy(step)))
  }
  appendCardSection(root, u.id)
  root.append(ttRow('tt-status', 'No price data yet · position on intellect only.'))
  return root
}

/** Hover card for a bottom-gutter (priced, unscored) model. */
export function unscoredTooltipContent(u: { id: string; costPerMTok: number }): HTMLElement {
  const root = el('div', { class: 'frontier-tooltip-content' })
  root.append(ttRow('tt-title', el('strong', {}, displayModelLabel(u.id))))
  if (displayModelLabel(u.id) !== u.id) root.append(ttRow('tt-muted', u.id))
  root.append(ttRow('tt-section', 'Price'))
  root.append(ttRow('tt-line', `${formatPrice(u.costPerMTok)} blended (80% in / 20% out)`))
  appendCardSection(root, u.id)
  root.append(ttRow('tt-status', 'No sourced intellect measurement yet · position on price only.'))
  return root
}

const TOOLTIP_OFFSET_PX = 12

/**
 * Place a hover card beside the cursor without squeezing it into a tall column.
 * Near the right edge, shrink-to-fit width uses only the remaining horizontal
 * room · the same failure mode the chart labels avoid by flipping anchor.
 */
export function positionFrontierTooltip(
  tip: HTMLElement,
  container: HTMLElement,
  evt: Pick<MouseEvent, 'clientX' | 'clientY'>,
): void {
  const rect = container.getBoundingClientRect()
  const tipWidth = tip.offsetWidth
  const tipHeight = tip.offsetHeight
  const cursorX = evt.clientX - rect.left
  const cursorY = evt.clientY - rect.top

  let left = cursorX + TOOLTIP_OFFSET_PX
  if (left + tipWidth > rect.width) {
    left = cursorX - tipWidth - TOOLTIP_OFFSET_PX
  }
  left = Math.max(0, Math.min(left, Math.max(0, rect.width - tipWidth)))

  let top = cursorY + TOOLTIP_OFFSET_PX
  if (top + tipHeight > rect.height) {
    top = cursorY - tipHeight - TOOLTIP_OFFSET_PX
  }
  top = Math.max(0, Math.min(top, Math.max(0, rect.height - tipHeight)))

  tip.style.left = `${String(left)}px`
  tip.style.top = `${String(top)}px`
}

/**
 * How long the hover card survives after the pointer leaves its point. The card
 * carries a model-card link, so it has to be reachable: the pointer needs to
 * cross the {@link TOOLTIP_OFFSET_PX} gap between point and card, and during
 * that crossing it is over neither. Entering the card cancels the pending hide.
 */
export const TOOLTIP_HIDE_GRACE_MS = 220

/** A positioned hover layer inside `container` (which must be a positioning context). */
export function createTooltipLayer(container: HTMLElement): FrontierTooltip {
  const tip = el('div', { class: 'frontier-tooltip', hidden: true })
  container.append(tip)
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  let currentTarget: Element | undefined
  let pinnedTarget: Element | undefined
  let position: MouseEvent | undefined
  const doc = container.ownerDocument
  const cancelHide = (): void => {
    if (hideTimer !== undefined) clearTimeout(hideTimer)
    hideTimer = undefined
  }
  const hideNow = (): void => {
    cancelHide()
    tip.hidden = true
    currentTarget = undefined
    position = undefined
  }
  const dismiss = (): void => {
    pinnedTarget = undefined
    delete tip.dataset['pinned']
    doc.removeEventListener('click', onOutsideClick)
    doc.removeEventListener('keydown', onEscape)
    hideNow()
  }
  const onOutsideClick = (evt: MouseEvent): void => {
    const target = evt.target
    if (target instanceof Node && (tip.contains(target) || pinnedTarget?.contains(target))) return
    dismiss()
  }
  const onEscape = (evt: KeyboardEvent): void => {
    if (evt.key === 'Escape') dismiss()
  }
  const replaceContent = (content: HTMLElement): void => {
    tip.replaceChildren(content)
    if (pinnedTarget) {
      const close = el(
        'button',
        {
          type: 'button',
          class: 'frontier-tooltip-close',
          'aria-label': 'Close model details',
        },
        '×',
      )
      close.addEventListener('click', dismiss)
      tip.append(close)
    }
  }
  tip.addEventListener('mouseenter', cancelHide)
  tip.addEventListener('mouseleave', () => {
    if (!pinnedTarget) hideNow()
  })
  return {
    show(content, evt, target): void {
      if (pinnedTarget) return
      cancelHide()
      currentTarget = target
      position = evt
      replaceContent(content)
      tip.hidden = false
      positionFrontierTooltip(tip, container, evt)
    },
    pin(content, evt, target): void {
      if (pinnedTarget === target) {
        dismiss()
        return
      }
      cancelHide()
      pinnedTarget = target
      currentTarget = target
      position = evt
      tip.dataset['pinned'] = 'true'
      replaceContent(content)
      tip.hidden = false
      positionFrontierTooltip(tip, container, evt)
      doc.addEventListener('click', onOutsideClick)
      doc.addEventListener('keydown', onEscape)
    },
    update(content, target): void {
      if (!tip.hidden && currentTarget === target) {
        replaceContent(content)
        if (position) positionFrontierTooltip(tip, container, position)
      }
    },
    hide(): void {
      if (pinnedTarget) return
      // Deferred, not immediate: see TOOLTIP_HIDE_GRACE_MS.
      cancelHide()
      hideTimer = setTimeout(hideNow, TOOLTIP_HIDE_GRACE_MS)
    },
    dismiss,
  }
}

/**
 * The API used to resolve card links, set once by the panel. A module-level
 * handle because `wireTooltip` is called from the pure SVG renderer, which has
 * no business taking an IPC client as a parameter. Undefined in unit tests and
 * in the demo build, where nothing is resolved and no card section renders.
 */
let modelCardApi: ModelCardResolveApi | undefined

export type ModelCardResolveApi = Parameters<typeof requestModelCards>[1]

/** Point the panel's card lookups at an IPC bridge. */
export function setModelCardApi(api: ModelCardResolveApi | undefined): void {
  modelCardApi = api
}

export function requestFrontierModelCards(ids: readonly string[]): Promise<boolean> {
  return requestModelCards(ids, modelCardApi)
}

export function wireTooltip(
  target: SVGElement,
  tooltip: FrontierTooltip | undefined,
  build: () => HTMLElement,
  modelId?: string,
): void {
  if (!tooltip) return
  // Resolving a card is a round-trip, so the first hover can open before the
  // answer exists. Repaint once it lands · but only while the pointer is still
  // on this point, or a stale reply would reopen a card the user has left.
  const fillCard = (): void => {
    if (modelId === undefined) return
    void requestFrontierModelCards([modelId]).then((landed) => {
      if (landed) tooltip.update(build(), target)
    })
  }
  target.setAttribute('tabindex', '0')
  target.setAttribute('role', 'button')
  target.setAttribute('aria-label', `Details for ${displayModelLabel(modelId ?? 'model')}`)
  target.addEventListener('mouseenter', (evt) => {
    tooltip.show(build(), evt, target)
    fillCard()
  })
  target.addEventListener('mousemove', (evt) => {
    tooltip.show(build(), evt, target)
  })
  target.addEventListener('mouseleave', () => {
    tooltip.hide()
  })
  target.addEventListener('click', (evt) => {
    tooltip.pin(build(), evt, target)
    fillCard()
  })
  target.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return
    evt.preventDefault()
    const rect = target.getBoundingClientRect()
    tooltip.pin(
      build(),
      new MouseEvent('click', {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }),
      target,
    )
    fillCard()
  })
}

export function tooltipFor(point: FrontierPoint, costAxis: FrontierCostAxis = 'blended'): string {
  const lines: string[] = [point.id]
  const explanation = explainIntellectScore(point.id)
  if (explanation) {
    lines.push(`intellect ${String(explanation.value)} · ${scoreScaleCopy(explanation.scale)}`)
    for (const step of explanation.steps) lines.push(derivationStepCopy(step))
  } else {
    lines.push(`intellect ${point.intellectEstimated ? '~' : ''}${String(point.intellect)}`)
  }
  lines.push(
    point.local
      ? 'cost: free (runs on-device)'
      : point.plan
        ? `cost: included in plan (${point.plan})`
        : costAxis === 'perTask'
          ? `cost: $${String(point.costPerMTok)}/task AA Intelligence Index`
          : `cost: $${String(point.costPerMTok)}/MTok blended (80% input / 20% output)`,
  )
  lines.push(
    point.onFrontier ? 'On the value frontier' : `Dominated by ${point.dominatedBy ?? '?'}`,
  )
  return lines.join('\n')
}
