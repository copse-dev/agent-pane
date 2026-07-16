import { el } from '../dom/helpers.ts'
import { outlineIcon } from '../dom/outline-icon.ts'
import type { AppStore } from '@shared/store/store.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import type { RightPanelMode } from '@shared/types/state.ts'
import { toggleRightPanelWithWorkspace } from '../controller/panels.ts'

export type PanelControlId =
  | 'explorer'
  | 'terminal'
  | 'changes'
  | 'prs'
  | 'memories'
  | 'roadmap'
  | 'browser'

interface PanelControlDef {
  id: PanelControlId
  mode: RightPanelMode
  ariaLabel: string
  label: string
  icon: () => SVGSVGElement
  experimentalSetting?: 'okfMemoriesEnabled' | 'roadmapPlansEnabled'
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
    experimentalSetting: 'roadmapPlansEnabled',
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
        class: ['titlebar-btn', 'titlebar-text-btn', keepLabel ? '' : 'titlebar-compact-icon']
          .filter(Boolean)
          .join(' '),
        'aria-label': def.ariaLabel,
        ...(def.experimentalSetting ? { hidden: true } : {}),
      },
      ...children,
    )
    btn.addEventListener('click', () => {
      toggleRightPanelWithWorkspace(store, api, def.mode)
      syncPanelBtns()
    })
    buttons.set(def.id, btn)
    controls.append(btn)
  }

  function syncPanelBtns(): void {
    const { filesPaneOpen, rightPanelMode } = store.getState()
    for (const def of PANEL_CONTROL_DEFS) {
      const btn = buttons.get(def.id)
      if (!btn) continue
      btn.classList.toggle('active', filesPaneOpen && rightPanelMode === def.mode)
    }
  }

  function syncExperimentalBtns(): void {
    for (const def of PANEL_CONTROL_DEFS) {
      if (!def.experimentalSetting) continue
      const btn = buttons.get(def.id)
      if (!btn) continue
      void api.settings.get(def.experimentalSetting).then((enabled) => {
        btn.hidden = enabled !== true
      })
    }
  }

  function syncChangesBadge(): void {
    if (!changesBadge) return
    const pending = store.getState().stagedDiffs.length
    const changesBtn = buttons.get('changes')
    changesBadge.hidden = pending === 0
    changesBadge.textContent = String(pending)
    changesBtn?.classList.toggle('has-pending', pending > 0)
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
      controls.remove()
    },
  }
}
