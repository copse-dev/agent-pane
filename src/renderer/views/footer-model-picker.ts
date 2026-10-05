import { CHATGPT_PLAN_MODEL_PREFIX } from '@copse/llm/reserved-prefixes.ts'
import { el } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { fetchModelOptions } from './model-options.ts'
import { mountModelPicker } from './model-picker.ts'
import {
  loadAcpOptionGroups,
  saveAcpOptionSelection,
  type AcpOptionGroup,
} from './acp-config-options.ts'
import {
  REASONING_GROUP_ID,
  reasoningLevelFromGroupValue,
  reasoningValueGroup,
} from './footer-reasoning-group.ts'
import type { ReasoningLevel } from '@copse/llm/model-parameters.ts'

export interface FooterModelPickerOptions {
  /** When true, ACP agents are omitted (SSH workspaces). */
  isSshWorkspace?: () => boolean
  /** Called after the menu closes (e.g. return focus to the composer). */
  onClose?: () => void
  /** Most-recent-first model values from prior threads. */
  getRecentModels?: () => readonly string[]
  /** Override the trigger label for the current picker value (resolved route). */
  formatCurrentLabel?: (current: string) => string | undefined
  /** Actual route for a dynamic model, shared by its label and coverage badge. */
  getCurrentRoute?: (current: string) => string | undefined
  /** This chat's reasoning override, if any. Omit to hide the effort selector. */
  getReasoning?: () => ReasoningLevel | undefined
  /** Applies an effort pick; `undefined` clears the chat's override. */
  onSelectReasoning?: (level: ReasoningLevel | undefined) => void
}

// Composer adapter for the app-wide picker. The trigger stays compact while the
// shared menu provides the same search/group/keyboard experience as form fields.
export function mountFooterModelPicker(
  root: HTMLElement,
  api: ApiClient,
  getCurrent: () => string,
  onSelect: (model: string) => void,
  pickerOpts: FooterModelPickerOptions = {},
): { refresh: () => void; sync: () => void; openMenu: () => void; destroy: () => void } {
  // The agent whose selectors are currently listed. Captured on load so a pick
  // persists against the right agent even if the model value moves on after.
  let optionAgentId: string | null = null
  let optionGroups: AcpOptionGroup[] = []

  function persistGroupValue(groupId: string, value: string): void {
    const agentId = optionAgentId
    const group = optionGroups.find((candidate) => candidate.id === groupId)
    if (!agentId || !group) return
    group.currentValue = value
    void saveAcpOptionSelection(api, agentId, group, value).catch((err: unknown) => {
      console.error('[acp] failed to save option selection:', err)
    })
  }

  const usage = el(
    'button',
    {
      type: 'button',
      class: 'ui-btn ui-btn-ghost footer-plan-usage',
      'aria-label': 'Manage ChatGPT usage',
      title: 'Manage your ChatGPT plan and Copse’s allowance',
    },
    'Manage usage',
  )
  usage.addEventListener('click', () => {
    void api.shell.openExternal('https://chatgpt.com/settings/usage')
  })
  function updateUsage(): void {
    usage.hidden = !getCurrent().startsWith(CHATGPT_PLAN_MODEL_PREFIX)
  }

  const picker = mountModelPicker(
    root,
    getCurrent,
    (model) => {
      onSelect(model)
      updateUsage()
      void picker.refresh()
    },
    (current) =>
      fetchModelOptions(api, pickerOpts.getCurrentRoute?.(current) ?? current, {
        sshWorkspace: pickerOpts.isSshWorkspace?.() === true,
      }),
    {
      variant: 'compact',
      enableShortcut: true,
      ariaLabel: 'Chat model',
      // Everything that belongs to the *chosen model* rather than the catalog:
      // our own per-chat effort, plus an ACP agent's own knobs (mode, thinking
      // effort). Both hang off whichever value is selected, so they reload with
      // the model list.
      loadValueGroups: async (current) => {
        const loaded = await loadAcpOptionGroups(api, current)
        optionAgentId = loaded?.agentId ?? null
        optionGroups = loaded?.groups ?? []
        const reasoning = pickerOpts.getReasoning
          ? reasoningValueGroup(current, pickerOpts.getReasoning())
          : null
        return reasoning ? [reasoning, ...optionGroups] : optionGroups
      },
      onSelectGroupValue: (groupId, value) => {
        if (groupId === REASONING_GROUP_ID) {
          pickerOpts.onSelectReasoning?.(reasoningLevelFromGroupValue(value))
          return
        }
        persistGroupValue(groupId, value)
      },
      ...(pickerOpts.onClose ? { onClose: pickerOpts.onClose } : {}),
      ...(pickerOpts.getRecentModels ? { getRecentValues: pickerOpts.getRecentModels } : {}),
      ...(pickerOpts.formatCurrentLabel
        ? { formatCurrentLabel: pickerOpts.formatCurrentLabel }
        : {}),
      ...(pickerOpts.getCurrentRoute ? { getCurrentRoute: pickerOpts.getCurrentRoute } : {}),
    },
  )

  root.append(usage)
  updateUsage()

  // Selected-plugin models can appear or disappear while this footer remains
  // mounted. Refresh on explicit open so the menu reflects live plugin state.
  picker.root.querySelector('.model-picker-trigger')?.addEventListener('click', () => {
    void picker.refresh()
  })

  return {
    refresh: (): void => {
      updateUsage()
      void picker.refresh()
    },
    sync: picker.sync,
    // Same pairing as an explicit trigger click: refresh live plugin/provider
    // state, then show the menu.
    openMenu: (): void => {
      void picker.refresh()
      picker.openMenu()
    },
    destroy: (): void => {
      usage.remove()
      picker.destroy()
    },
  }
}
