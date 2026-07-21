import { el, on } from '../dom/helpers.ts'
import { moreHorizontalIcon } from '../dom/icons.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { toggleRightPanelWithWorkspace } from '../controller/panels.ts'
import { countPortraitPanelOverflow } from './portrait-panel-bar-overflow.ts'
import { ROADMAP_PLANS_PACK_ID } from '@copse/agent/packs/roadmap-plans-pack.ts'

export type PanelControlId =
  'explorer' | 'terminal' | 'changes' | 'prs' | 'memories' | 'roadmap' | 'browser'

interface PanelControlDef {
  id: PanelControlId
  mode: RightPanelMode
  ariaLabel: string
  label: string
  icon: () => SVGSVGElement
  /** Hide the button until this experimental setting is on (read via settings IPC). */
  experimentalSetting?: 'okfMemoriesEnabled'
  /** Hide the button until this first-party pack is enabled (read via `packs:list`). */
  experimentalPack?: string
}

/** True for a control whose visibility is gated behind an experimental flag or pack. */
function isGated(def: PanelControlDef): boolean {
  return !!def.experimentalSetting || !!def.experimentalPack
}

function panelIcon(): SVGSVGElement {
  return outlineIcon(
    'panel',
    ['M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'M9 4v16'],
    'titlebar-btn-icon',
  )
}

function terminalIcon(): SVGSVGElement {
  return outlineIcon('terminal', ['m7 8 4 4-4 4', 'M13 16h4'], 'titlebar-btn-icon')
}

function changesIcon(): SVGSVGElement {
  return outlineIcon(
    'changes',
    [
      'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M6 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M15 5H9a3 3 0 0 0-3 3v8',
      'M9 19h6a3 3 0 0 0 3-3V8',
    ],
    'titlebar-btn-icon',
  )
}

function browserIcon(): SVGSVGElement {
  return outlineIcon(
    'browser',
    [
      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
      'M2 12h20',
      'M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20Z',
    ],
    'titlebar-btn-icon',
  )
}

function prsIcon(): SVGSVGElement {
  return outlineIcon(
    'prs',
    [
      'M9 6a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z',
      'M6 9v12',
      'M21 18a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z',
      'M13 6h3a2 2 0 0 1 2 2v7',
    ],
    'titlebar-btn-icon',
  )
}

function memoriesIcon(): SVGSVGElement {
  return outlineIcon(
    'memories',
    [
      'M4 19.5A2.5 2.5 0 0 1 6.5 17H20',
      'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
    ],
    'titlebar-btn-icon',
  )
}

function roadmapIcon(): SVGSVGElement {
  return outlineIcon(
    'roadmap',
    ['M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4Z', 'M8 2v16', 'M16 6v16'],
    'titlebar-btn-icon',
  )
}

const PANEL_CONTROL_DEFS: readonly PanelControlDef[] = [
  {
    id: 'explorer',
    mode: 'explorer',
    ariaLabel: 'Toggle right panel',
    label: 'Panel',
    icon: panelIcon,
  },
  {
    id: 'terminal',
    mode: 'terminal',
    ariaLabel: 'Open terminal',
    label: 'Terminal',
    icon: terminalIcon,
  },
  {
    id: 'changes',
    mode: 'changes',
    ariaLabel: 'Open changes',
    label: 'Changes',
    icon: changesIcon,
  },
  {
    id: 'prs',
    mode: 'prs',
    ariaLabel: 'Open pull requests',
    label: 'PRs',
    icon: prsIcon,
  },
  {
    id: 'memories',
    mode: 'memories',
    ariaLabel: 'Open memories',
    label: 'Memories',
    icon: memoriesIcon,
    experimentalSetting: 'okfMemoriesEnabled',
  },
  {
    id: 'roadmap',
    mode: 'roadmap',
    ariaLabel: 'Open roadmap',
    label: 'Roadmap',
    icon: roadmapIcon,
    experimentalPack: ROADMAP_PLANS_PACK_ID,
  },
  {
    id: 'browser',
    mode: 'browser',
    ariaLabel: 'Open browser',
    label: 'Browser',
    icon: browserIcon,
  },
]

export interface MountPanelModeControlsOptions {
  /** Container class (defaults to titlebar-panel-controls). */
  className?: string
  /**
   * Control ids whose text labels stay visible in portrait/vertical chrome.
   * All other labels get `.titlebar-btn-label` and hide via CSS when
   * `#app.is-portrait-chrome`. Pass `'all'` for the bottom portrait row.
   */
  alwaysShowLabels?: ReadonlySet<PanelControlId> | 'all'
  /**
   * When true (portrait bar), trailing buttons that don't fit collapse into a
   * `…` overflow menu instead of wrapping or scrolling.
   */
  enableOverflow?: boolean
}

/**
 * Shared Panel / Terminal / Changes / … toggle cluster used by the titlebar and
 * the portrait chrome row beneath the composer footer.
 */
export function mountPanelModeControls(
  store: AppStore,
  api: ApiClient,
  opts: MountPanelModeControlsOptions = {},
): { element: HTMLElement; destroy: () => void } {
  const alwaysShowLabels =
    opts.alwaysShowLabels === 'all' ? null : (opts.alwaysShowLabels ?? new Set<PanelControlId>())
  const controls = el('div', { class: opts.className ?? 'titlebar-panel-controls' })
  const buttons = new Map<PanelControlId, HTMLButtonElement>()
  let changesBadge: HTMLSpanElement | null = null
  const cleanups: Array<() => void> = []
  let syncOverflow: (() => void) | null = null

  for (const def of PANEL_CONTROL_DEFS) {
    const keepLabel = alwaysShowLabels === null || alwaysShowLabels.has(def.id)
    const children: Array<Node | string> = [def.icon()]
    if (keepLabel) {
      children.push(def.label)
    } else {
      children.push(el('span', { class: 'titlebar-btn-label' }, def.label))
    }
    if (def.id === 'changes') {
      changesBadge = el('span', { class: 'titlebar-btn-badge', hidden: true })
      children.push(changesBadge)
    }
    const btn = el(
      'button',
      {
        // Portrait bar omits `.titlebar-btn` so existing e2e / click helpers that
        // target `.titlebar-btn[aria-label=…]` stay uniquely on the titlebar.
        class: [
          opts.enableOverflow ? 'portrait-panel-btn' : 'titlebar-btn',
          'titlebar-text-btn',
          keepLabel ? '' : 'titlebar-compact-icon',
        ]
          .filter(Boolean)
          .join(' '),
        'aria-label': def.ariaLabel,
        'data-panel-control': def.id,
        ...(isGated(def) ? { hidden: true } : {}),
      },
      ...children,
    )
    if (isGated(def)) btn.setAttribute('data-experimental-hidden', '')
    btn.addEventListener('click', () => {
      toggleRightPanelWithWorkspace(store, api, def.mode)
      syncPanelBtns()
    })
    buttons.set(def.id, btn)
    controls.append(btn)
  }

  if (opts.enableOverflow) {
    const overflowBadge = el('span', {
      class: 'titlebar-btn-badge portrait-panel-overflow-badge',
      hidden: true,
    })
    const overflowTrigger = el(
      'button',
      {
        type: 'button',
        class: 'portrait-panel-overflow-trigger',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        'aria-label': 'More panel modes',
      },
      moreHorizontalIcon('ui-icon ui-icon-sm'),
      overflowBadge,
    )
    const overflowMenu = el('div', {
      class: 'portrait-panel-overflow-menu',
      role: 'menu',
      hidden: '',
    })
    const overflowWrap = el(
      'div',
      { class: 'portrait-panel-overflow', hidden: true },
      overflowTrigger,
      overflowMenu,
    )
    controls.append(overflowWrap)

    let overflowOpen = false
    let overflowFrame = 0

    function setOverflowOpen(next: boolean): void {
      overflowOpen = next
      overflowTrigger.setAttribute('aria-expanded', String(next))
      if (next) overflowMenu.removeAttribute('hidden')
      else overflowMenu.setAttribute('hidden', '')
    }

    function eligibleButtons(): HTMLButtonElement[] {
      return PANEL_CONTROL_DEFS.map((def) => buttons.get(def.id)).filter(
        (btn): btn is HTMLButtonElement => !!btn && !btn.hasAttribute('data-experimental-hidden'),
      )
    }

    function renderOverflowMenu(overflowed: HTMLButtonElement[]): void {
      const { filesPaneOpen, rightPanelMode } = store.getState()
      overflowMenu.replaceChildren(
        ...overflowed.map((btn) => {
          const id = btn.dataset['panelControl']
          const def = PANEL_CONTROL_DEFS.find((d) => d.id === id)
          const item = el(
            'button',
            { type: 'button', class: 'portrait-panel-overflow-item', role: 'menuitem' },
            def ? def.icon() : '',
            def?.label ?? btn.getAttribute('aria-label') ?? 'Panel',
          )
          if (def && filesPaneOpen && rightPanelMode === def.mode) {
            item.classList.add('is-active')
          }
          item.addEventListener('click', () => {
            btn.click()
            setOverflowOpen(false)
          })
          return item
        }),
      )
    }

    function syncOverflowBadge(overflowed: HTMLButtonElement[]): void {
      const changesOverflowed = overflowed.some((btn) => btn.dataset['panelControl'] === 'changes')
      const pending = store.getState().stagedDiffs.length
      const show = changesOverflowed && pending > 0
      overflowBadge.hidden = !show
      overflowBadge.textContent = show ? String(pending) : ''
      overflowTrigger.classList.toggle('has-pending', show)
    }

    syncOverflow = (): void => {
      cancelAnimationFrame(overflowFrame)
      overflowFrame = requestAnimationFrame(() => {
        // Unit tests run under a minimal DOM without layout/CSSOM; skip overflow
        // planning there so rAF work from mount doesn't throw after the test ends.
        if (typeof getComputedStyle !== 'function' || controls.clientWidth === 0) return

        const eligible = eligibleButtons()
        for (const btn of eligible) {
          btn.removeAttribute('data-portrait-overflow')
        }
        overflowWrap.hidden = true
        setOverflowOpen(false)

        const styles = getComputedStyle(controls)
        const gap = Number.parseFloat(styles.columnGap || styles.gap || '0') || 0
        const padL = Number.parseFloat(styles.paddingLeft) || 0
        const padR = Number.parseFloat(styles.paddingRight) || 0
        const containerWidth = Math.max(0, controls.clientWidth - padL - padR)
        const widths = eligible.map((btn) => btn.getBoundingClientRect().width)

        // Measure the trigger while briefly shown so getBoundingClientRect is real.
        overflowWrap.hidden = false
        const overflowWidth = overflowTrigger.getBoundingClientRect().width
        overflowWrap.hidden = true

        const hideCount = countPortraitPanelOverflow(widths, gap, containerWidth, overflowWidth, 1)
        if (hideCount === 0) {
          syncOverflowBadge([])
          return
        }

        const overflowed = eligible.slice(eligible.length - hideCount)
        for (const btn of overflowed) {
          btn.setAttribute('data-portrait-overflow', '')
        }
        overflowWrap.hidden = false
        renderOverflowMenu(overflowed)
        syncOverflowBadge(overflowed)
      })
    }

    overflowTrigger.addEventListener('click', () => {
      if (overflowWrap.hidden) return
      setOverflowOpen(!overflowOpen)
    })
    cleanups.push(
      on(document, 'click', (e) => {
        if (!overflowOpen) return
        if (!overflowWrap.contains(e.target as Node)) setOverflowOpen(false)
      }),
      on(document, 'keydown', (e) => {
        if (e.key === 'Escape' && overflowOpen) setOverflowOpen(false)
      }),
    )

    const observer = new ResizeObserver(() => {
      syncOverflow?.()
    })
    observer.observe(controls)
    cleanups.push(() => {
      cancelAnimationFrame(overflowFrame)
      observer.disconnect()
    })
  }

  function syncPanelBtns(): void {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    for (const def of PANEL_CONTROL_DEFS) {
      const btn = buttons.get(def.id)
      if (!btn) continue
      btn.classList.toggle('active', filesPaneOpen && rightPanelMode === def.mode)
    }
    syncOverflow?.()
  }

  function applyGate(btn: HTMLButtonElement, enabled: boolean): void {
    const hide = !enabled
    btn.hidden = hide
    if (hide) btn.setAttribute('data-experimental-hidden', '')
    else btn.removeAttribute('data-experimental-hidden')
  }

  function syncExperimentalBtns(): void {
    const pending: Array<Promise<void>> = []
    for (const def of PANEL_CONTROL_DEFS) {
      const btn = buttons.get(def.id)
      if (!btn) continue
      if (def.experimentalSetting) {
        const setting = def.experimentalSetting
        pending.push(
          api.settings.get(setting).then((enabled) => {
            applyGate(btn, enabled === true)
          }),
        )
      } else if (def.experimentalPack) {
        // Pack-gated controls (e.g. Roadmap) read the shared host pack registry
        // via `packs:list`; the button shows iff the pack is enabled. Toggling
        // the pack in Settings emits `settings_changed`, which re-runs this.
        const packId = def.experimentalPack
        pending.push(
          api.packs
            .list()
            .then((res) => {
              applyGate(
                btn,
                res.packs.some((p) => p.id === packId && p.enabled),
              )
            })
            .catch(() => {
              applyGate(btn, false)
            }),
        )
      }
    }
    void Promise.all(pending).then(() => {
      syncOverflow?.()
    })
  }

  function syncChangesBadge(): void {
    if (!changesBadge) return
    const pending = store.getState().stagedDiffs.length
    const changesBtn = buttons.get('changes')
    changesBadge.hidden = pending === 0
    changesBadge.textContent = String(pending)
    changesBtn?.classList.toggle('has-pending', pending > 0)
    syncOverflow?.()
  }

  syncPanelBtns()
  syncChangesBadge()
  syncExperimentalBtns()

  const unsubs = [
    store.on('files_pane_changed', syncPanelBtns),
    store.on('right_panel_mode_changed', syncPanelBtns),
    store.on('staged_diffs_changed', syncChangesBadge),
    store.on('settings_changed', syncExperimentalBtns),
  ]

  return {
    element: controls,
    destroy(): void {
      unsubs.forEach((u) => {
        u()
      })
      cleanups.forEach((u) => {
        u()
      })
      controls.remove()
    },
  }
}
