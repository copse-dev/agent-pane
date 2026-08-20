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
): { refresh: () => void; openMenu: () => void; destroy: () => void } {
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

  const picker = mountModelPicker(
    root,
    getCurrent,
    (model) => {
      onSelect(model)
      void picker.refresh()
    },
    (current) =>
      fetchModelOptions(api, current, {
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
    },
  )

  // Selected-plugin models can appear or disappear while this footer remains
  // mounted. Refresh on explicit open so the menu reflects live plugin state.
  picker.root.querySelector('.model-picker-trigger')?.addEventListener('click', () => {
    void picker.refresh()
  })

  return {
    refresh: () => void picker.refresh(),
    // Same pairing as an explicit trigger click: refresh live plugin/provider
    // state, then show the menu.
    openMenu: (): void => {
      void picker.refresh()
      picker.openMenu()
    },
    destroy: picker.destroy,
  }
}
