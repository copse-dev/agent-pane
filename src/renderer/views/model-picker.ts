import { showContextMenu, type ContextMenuEntry } from '../dom/context-menu.ts'
import { el, clear, on } from '../dom/helpers.ts'
import { arrowLeftIcon, checkIcon, chevronDownIcon, chevronRightIcon } from '../dom/icons.ts'
import { modelDisplayLabel, type ModelOption } from './model-options.ts'

export interface ModelPickerOptions {
  /** Field pickers use form-control chrome and open below; the composer stays compact. */
  variant?: 'compact' | 'field'
  /** Extra class for a surface-specific width/layout hook. */
  className?: string
  /** Called after the menu closes (for example, to return focus to the composer). */
  onClose?: () => void
  /** Composer-only global shortcut. Dialog pickers must not compete for it. */
  enableShortcut?: boolean
  /** Accessible name when there is no useful surrounding label relationship. */
  ariaLabel?: string
  /** Settings mounts before it has loaded saved values, so it refreshes explicitly. */
  loadOnMount?: boolean
  /** Enables a recent-first view, with the complete searchable catalog one level deeper. */
  getRecentValues?: () => readonly string[]
  /**
   * Runs only after a refresh wins its generation race. Use this for side effects
   * that must not apply from a stale in-flight load (e.g. syncing a native select).
   */
  onOptionsLoaded?: (options: readonly ModelOption[]) => void
  /**
   * Extra selectors for the *current* value, listed under the models — today
   * the ACP agent's own knobs (reasoning level, mode). Loaded alongside the
   * model list on every refresh; return `[]` for values that have none.
   */
  loadValueGroups?: (current: string) => Promise<PickerValueGroup[]>
  /** Applies a selection from {@link ModelPickerOptions.loadValueGroups}. */
  onSelectGroupValue?: (groupId: string, value: string) => void
}

/**
 * A secondary selector shown beneath the model list, scoped to the currently
 * selected model. Deliberately protocol-agnostic: the picker renders labelled
 * choices and reports the pick, and the caller decides what a group means.
 */
export interface PickerValueGroup {
  id: string
  label: string
  currentValue: string
  choices: readonly { value: string; label: string; description?: string }[]
}

export interface ModelPicker {
  root: HTMLElement
  refresh: () => Promise<void>
  sync: () => void
  destroy: () => void
}

const RECENT_MODEL_LIMIT = 5

/**
 * The app-wide searchable model picker. Surfaces own where the current value is
 * stored; this component owns filtering, grouping, keyboard navigation, and
 * consistent presentation.
 */
export function mountModelPicker(
  root: HTMLElement,
  getCurrent: () => string,
  onSelect: (model: string) => void,
  loadOptions: (current: string) => Promise<ModelOption[]>,
  pickerOpts: ModelPickerOptions = {},
): ModelPicker {
  const variant = pickerOpts.variant ?? 'compact'
  const recentMode = pickerOpts.getRecentValues !== undefined
  const wrap = el('div', {
    class: [
      'model-picker',
      `model-picker-${variant}`,
      recentMode ? 'model-picker-recent-mode' : undefined,
      pickerOpts.className,
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  })
  const triggerAttrs: Record<string, string> = {
    type: 'button',
    class: 'model-picker-trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  }
  if (pickerOpts.ariaLabel) triggerAttrs['aria-label'] = pickerOpts.ariaLabel
  const trigger = el('button', triggerAttrs)
  const labelEl = el('span', { class: 'model-picker-label' })
  const chevron = el(
    'span',
    { class: 'model-picker-chevron', 'aria-hidden': 'true' },
    chevronDownIcon('ui-icon ui-icon-sm'),
  )
  trigger.append(labelEl, chevron)
  const menu = el('div', {
    class: 'model-picker-menu',
    hidden: '',
    'aria-label': 'Choose model',
  })
  const recentHeader = el(
    'div',
    {
      class: 'model-picker-view-title',
      hidden: recentMode ? undefined : '',
    },
    'Recent',
  )
  const allHeader = el('div', { class: 'model-picker-all-header', hidden: '' })
  const backButton = el(
    'button',
    {
      type: 'button',
      class: 'model-picker-back',
      'aria-label': 'Back to recent models',
    },
    arrowLeftIcon('ui-icon ui-icon-sm'),
  )
  allHeader.append(backButton, el('span', { class: 'model-picker-view-title' }, 'All models'))
  const filter = el('input', {
    type: 'search',
    class: 'model-picker-filter',
    placeholder: 'Filter models...',
    'aria-label': 'Filter models',
    autocomplete: 'off',
    hidden: recentMode ? '' : undefined,
  })
  const list = el('div', {
    class: 'model-picker-list',
    role: 'listbox',
    'aria-label': recentMode ? 'Recent models' : 'All models',
  })
  const browseButton = el(
    'button',
    {
      type: 'button',
      class: 'model-picker-browse',
      'aria-label': 'Browse all models',
      hidden: recentMode ? undefined : '',
    },
    el('span', {}, 'All models'),
    chevronRightIcon('ui-icon ui-icon-sm'),
  )
  // Selectors that belong to the current model rather than to the catalog (an
  // ACP agent's reasoning level, its mode). Listed under the models, each row
  // drilling into its own choices.
  const groupsSection = el('div', { class: 'model-picker-groups', hidden: '' })
  const groupHeader = el('div', { class: 'model-picker-all-header', hidden: '' })
  const groupBack = el(
    'button',
    { type: 'button', class: 'model-picker-back', 'aria-label': 'Back to models' },
    arrowLeftIcon('ui-icon ui-icon-sm'),
  )
  const groupTitle = el('span', { class: 'model-picker-view-title' })
  groupHeader.append(groupBack, groupTitle)
  menu.append(recentHeader, allHeader, groupHeader, filter, list, groupsSection, browseButton)
  wrap.append(trigger, menu)
  root.append(wrap)

  const homeView = recentMode ? 'recent' : 'all'
  let open = false
  let view: 'recent' | 'all' | 'group' = homeView
  const cleanups: Array<() => void> = []
  let cachedOptions: ModelOption[] = []
  let valueGroups: PickerValueGroup[] = []
  let activeGroupId: string | null = null
  let activeValue: string | null = null
  let refreshGeneration = 0
  let loadState: 'loading' | 'ready' | 'error' = 'loading'

  function activeGroup(): PickerValueGroup | undefined {
    return valueGroups.find((group) => group.id === activeGroupId)
  }

  function focusActiveOption(): void {
    list
      .querySelector<HTMLElement>('.model-picker-option.is-active')
      ?.focus({ preventScroll: true })
  }

  function setView(next: 'recent' | 'all' | 'group', focus = true): void {
    view = next === 'group' ? 'group' : recentMode ? next : 'all'
    if (view !== 'group') activeGroupId = null
    recentHeader.hidden = view !== 'recent'
    allHeader.hidden = !recentMode || view !== 'all'
    groupHeader.hidden = view !== 'group'
    filter.hidden = view !== 'all'
    browseButton.hidden = !recentMode || view !== 'recent'
    groupsSection.hidden = view !== homeView || valueGroups.length === 0
    const group = activeGroup()
    if (group) groupTitle.textContent = group.label
    list.setAttribute(
      'aria-label',
      view === 'group'
        ? (group?.label ?? 'Options')
        : view === 'recent'
          ? 'Recent models'
          : 'All models',
    )
    if (view !== 'all') filter.value = ''
    renderMenu(cachedOptions)
    if (!focus) return
    if (view === 'all') filter.focus()
    else focusActiveOption()
  }

  function openGroup(groupId: string): void {
    activeGroupId = groupId
    activeValue = activeGroup()?.currentValue ?? null
    setView('group')
  }

  function setOpen(next: boolean): void {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    if (next) {
      menu.removeAttribute('hidden')
      setView(homeView)
      if (loadState === 'error') void refresh()
    } else {
      menu.setAttribute('hidden', '')
      filter.value = ''
      setView(homeView, false)
      pickerOpts.onClose?.()
    }
  }

  function matchingOptions(options: readonly ModelOption[]): ModelOption[] {
    const query = filter.value.trim().toLocaleLowerCase()
    return query
      ? options.filter((opt) => `${opt.label} ${opt.value}`.toLocaleLowerCase().includes(query))
      : [...options]
  }

  function visibleOptions(options: readonly ModelOption[]): ModelOption[] {
    if (view === 'all') return matchingOptions(options)
    const requested = [getCurrent(), ...(pickerOpts.getRecentValues?.() ?? [])]
    const seen = new Set<string>()
    const recent: ModelOption[] = []
    for (const value of requested) {
      if (!value || seen.has(value)) continue
      seen.add(value)
      const option = options.find((candidate) => candidate.value === value)
      if (option) recent.push(option)
      if (recent.length === RECENT_MODEL_LIMIT) break
    }
    return recent
  }

  function scrollActiveOptionIntoView(): void {
    const active = list.querySelector<HTMLElement>('.model-picker-option.is-active')
    if (!active) return
    const activeBounds = active.getBoundingClientRect()
    const listBounds = list.getBoundingClientRect()
    if (activeBounds.top < listBounds.top) {
      list.scrollTop += activeBounds.top - listBounds.top
    } else if (activeBounds.bottom > listBounds.bottom) {
      list.scrollTop += activeBounds.bottom - listBounds.bottom
    }
  }

  /** Render one group's choices in place of the model list (drill-in view). */
  function renderGroupChoices(group: PickerValueGroup): void {
    clear(list)
    activeValue ??= group.currentValue
    for (const choice of group.choices) {
      const selected = choice.value === group.currentValue
      const item = el(
        'button',
        {
          type: 'button',
          class: 'model-picker-option',
          role: 'option',
          'data-value': choice.value,
          'aria-selected': choice.value === activeValue ? 'true' : 'false',
          'aria-current': selected ? 'true' : undefined,
          ...(choice.description ? { title: choice.description } : {}),
        },
        el('span', { class: 'model-picker-option-label' }, choice.label),
        ...(selected ? [checkIcon('ui-icon ui-icon-sm model-picker-option-check')] : []),
      )
      if (selected) item.classList.add('is-selected')
      if (choice.value === activeValue) item.classList.add('is-active')
      item.addEventListener('click', () => {
        selectGroupValue(choice.value)
      })
      list.append(item)
    }
    scrollActiveOptionIntoView()
  }

  /** The current model's own selectors, as rows that drill into their choices. */
  function renderGroups(): void {
    clear(groupsSection)
    groupsSection.hidden = view !== homeView || valueGroups.length === 0
    for (const group of valueGroups) {
      const current = group.choices.find((choice) => choice.value === group.currentValue)
      const row = el(
        'button',
        {
          type: 'button',
          class: 'model-picker-group-row',
          'aria-haspopup': 'listbox',
          'aria-label': `${group.label}: ${current?.label ?? 'default'}`,
        },
        el('span', { class: 'model-picker-group-row-label' }, group.label),
        el('span', { class: 'model-picker-group-row-value' }, current?.label ?? 'Default'),
        chevronRightIcon('ui-icon ui-icon-sm'),
      )
      row.addEventListener('click', () => {
        openGroup(group.id)
      })
      groupsSection.append(row)
    }
  }

  function selectGroupValue(value: string): void {
    const group = activeGroup()
    if (!group) return
    // Reflect the pick immediately: persistence is async and the menu closes now.
    group.currentValue = value
    pickerOpts.onSelectGroupValue?.(group.id, value)
    renderGroups()
    setOpen(false)
  }

  function renderMenu(options: readonly ModelOption[]): void {
    const group = activeGroup()
    if (view === 'group' && group) {
      renderGroupChoices(group)
      return
    }
    clear(list)
    renderGroups()
    if (options.length === 0 && loadState !== 'ready') {
      list.append(
        el(
          'div',
          {
            class: `model-picker-status is-${loadState}`,
            role: 'status',
            'aria-live': 'polite',
          },
          loadState === 'loading'
            ? 'Loading models…'
            : 'Models unavailable. Close and reopen to retry.',
        ),
      )
      return
    }
    const current = getCurrent()
    const matches = visibleOptions(options)
    const active =
      matches.find((opt) => opt.value === activeValue && !opt.disabled) ??
      matches.find((opt) => opt.value === current && !opt.disabled) ??
      matches.find((opt) => !opt.disabled)
    activeValue = active?.value ?? null
    let lastGroup: string | undefined
    for (const opt of matches) {
      if (opt.group !== lastGroup) {
        lastGroup = opt.group
        if (view === 'all' && opt.group) {
          list.append(el('div', { class: 'model-picker-group-label' }, opt.group))
        }
      }
      const selected = opt.value === current
      const item = el(
        'button',
        {
          type: 'button',
          class: 'model-picker-option',
          role: 'option',
          'data-value': opt.value,
          'aria-selected': opt.value === activeValue ? 'true' : 'false',
          'aria-current': selected ? 'true' : undefined,
          disabled: opt.disabled ? true : undefined,
        },
        el('span', { class: 'model-picker-option-label' }, opt.label),
        ...(recentMode && selected
          ? [checkIcon('ui-icon ui-icon-sm model-picker-option-check')]
          : []),
      )
      if (selected) item.classList.add('is-selected')
      if (opt.value === activeValue) item.classList.add('is-active')
      item.addEventListener('click', () => {
        selectOption(opt.value)
      })
      list.append(item)
    }
    if (matches.length === 0) {
      list.append(
        el(
          'div',
          { class: 'model-picker-empty' },
          view === 'all' ? 'No matching models' : 'No recent models available',
        ),
      )
    }
    scrollActiveOptionIntoView()
  }

  function selectOption(value: string | null): void {
    if (value === null) return
    const option = cachedOptions.find((opt) => opt.value === value)
    if (!option || option.disabled) return
    activeValue = option.value
    onSelect(option.value)
    updateTrigger(cachedOptions)
    setOpen(false)
  }

  function moveActive(direction: -1 | 1): void {
    const group = activeGroup()
    const values =
      view === 'group' && group
        ? group.choices.map((choice) => choice.value)
        : visibleOptions(cachedOptions)
            .filter((opt) => !opt.disabled)
            .map((opt) => opt.value)
    if (values.length === 0) return
    const index = values.findIndex((value) => value === activeValue)
    const nextIndex = Math.max(0, Math.min(values.length - 1, index + direction))
    activeValue = values[nextIndex] ?? null
    renderMenu(cachedOptions)
    if (view !== 'all') focusActiveOption()
  }

  function updateTrigger(options: readonly ModelOption[]): void {
    const current = getCurrent()
    const match = options.find((opt) => opt.value === current)
    labelEl.textContent = match?.label ?? (current ? modelDisplayLabel(current) : 'Select model')
    labelEl.title = current
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration
    if (cachedOptions.length === 0) {
      loadState = 'loading'
      renderMenu(cachedOptions)
    }
    try {
      const options = await loadOptions(getCurrent())
      if (generation !== refreshGeneration) return
      cachedOptions = options
      loadState = 'ready'
    } catch {
      if (generation !== refreshGeneration) return
      cachedOptions = []
      loadState = 'error'
    }
    // The current model's own selectors are a separate, best-effort load: a
    // failure there leaves the model list fully usable.
    if (pickerOpts.loadValueGroups) {
      const groups = await pickerOpts.loadValueGroups(getCurrent()).catch(() => [])
      if (generation !== refreshGeneration) return
      valueGroups = [...groups]
      if (!activeGroup()) activeGroupId = null
    }
    pickerOpts.onOptionsLoaded?.(cachedOptions)
    renderMenu(cachedOptions)
    updateTrigger(cachedOptions)
    // The menu can be opened before `loadOptions` resolves: `setView` then had
    // only the "Loading models…" status to focus, so nothing took it and arrow
    // keys had nowhere to start. `renderMenu` also rebuilds every option, which
    // destroys a focused one. Re-apply once the options land — but never steal
    // focus from the filter or from an option the user has already moved to.
    if (open && view === 'recent' && !menu.contains(document.activeElement)) focusActiveOption()
  }

  function sync(): void {
    renderMenu(cachedOptions)
    updateTrigger(cachedOptions)
  }

  trigger.addEventListener('click', () => {
    setOpen(!open)
  })
  // Right-click is the shortcut to the current model's own selectors: every
  // choice on one flat menu, grouped by selector, without walking into the
  // model list first. Falls through to the platform menu when there are none.
  trigger.addEventListener('contextmenu', (e) => {
    if (valueGroups.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const entries: ContextMenuEntry[] = []
    for (const group of valueGroups) {
      entries.push({ heading: group.label })
      for (const choice of group.choices) {
        entries.push({
          label: choice.label,
          checked: choice.value === group.currentValue,
          onSelect: () => {
            group.currentValue = choice.value
            pickerOpts.onSelectGroupValue?.(group.id, choice.value)
            renderGroups()
          },
        })
      }
    }
    showContextMenu(e.clientX, e.clientY, entries)
  })
  browseButton.addEventListener('click', () => {
    setView('all')
  })
  backButton.addEventListener('click', () => {
    setView('recent')
  })
  groupBack.addEventListener('click', () => {
    activeValue = null
    setView(homeView)
  })
  filter.addEventListener('input', () => {
    renderMenu(cachedOptions)
  })
  menu.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (
      e.key === 'Enter' &&
      (e.target === filter ||
        (e.target instanceof HTMLElement && e.target.matches('.model-picker-option')))
    ) {
      e.preventDefault()
      if (view === 'group') {
        if (activeValue !== null) selectGroupValue(activeValue)
      } else selectOption(activeValue)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (view === 'group') {
        activeValue = null
        setView(homeView)
      } else if (view === 'all' && recentMode) setView('recent')
      else {
        setOpen(false)
        if (!recentMode) trigger.focus()
      }
    } else if (e.key === 'ArrowLeft' && view === 'group') {
      e.preventDefault()
      e.stopPropagation()
      activeValue = null
      setView(homeView)
    } else if (e.key === 'ArrowRight' && view === 'recent' && recentMode) {
      e.preventDefault()
      e.stopPropagation()
      setView('all')
    } else if (e.key === 'ArrowLeft' && view === 'all' && recentMode) {
      e.preventDefault()
      e.stopPropagation()
      setView('recent')
    }
  })

  cleanups.push(
    on(document, 'click', (e) => {
      if (!open) return
      if (!(e.target instanceof Node) || !wrap.contains(e.target)) setOpen(false)
    }),
    on(document, 'keydown', (e) => {
      const isOpenShortcut =
        pickerOpts.enableShortcut === true &&
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === 'm' || e.key === 'M')
      if (isOpenShortcut && !document.querySelector('dialog[open]')) {
        e.preventDefault()
        setOpen(true)
        return
      }
      if (e.key === 'Escape' && open) setOpen(false)
    }),
  )

  // Surfaces often remount by clearing a host (`innerHTML = ''` / `clear()`),
  // which drops the DOM without an explicit destroy. Tear down document
  // listeners when the widget leaves the tree so remounts do not leak.
  const removalObserver = new MutationObserver(() => {
    if (document.contains(wrap)) return
    removalObserver.disconnect()
    destroy()
  })
  removalObserver.observe(document.documentElement, { childList: true, subtree: true })
  cleanups.push(() => {
    removalObserver.disconnect()
  })

  let destroyed = false
  function destroy(): void {
    if (destroyed) return
    destroyed = true
    refreshGeneration++
    cleanups.forEach((cleanup) => {
      cleanup()
    })
    wrap.remove()
  }

  updateTrigger(cachedOptions)
  if (pickerOpts.loadOnMount !== false) void refresh()

  return {
    root: wrap,
    refresh,
    sync,
    destroy,
  }
}

export interface ModelSelectPickerOptions extends Omit<ModelPickerOptions, 'variant'> {
  loadOptions: (current: string) => Promise<ModelOption[]>
}

export interface ModelSelectPicker extends ModelPicker {
  refresh: (current?: string) => Promise<void>
}

let fieldPickerId = 0

function nativeOption(item: ModelOption): HTMLOptionElement {
  const option = document.createElement('option')
  option.value = item.value
  option.textContent = item.label
  option.disabled = item.disabled === true
  return option
}

/**
 * Bridge a form-owned native select to the shared picker. The select remains a
 * successful (hidden) form control, so FormData and existing settings save code
 * keep one source of truth while users interact with the searchable widget.
 */
export function mountModelSelectPicker(
  select: HTMLSelectElement,
  pickerOpts: ModelSelectPickerOptions,
): ModelSelectPicker {
  let current = select.value
  if (!select.id) {
    select.id = `model-picker-select-${String(++fieldPickerId)}`
  }
  const wrappingLabel =
    select.parentElement instanceof HTMLLabelElement ? select.parentElement : null
  const associatedLabels = [...document.querySelectorAll<HTMLLabelElement>('label')].filter(
    (label) => label.htmlFor === select.id,
  )
  if (wrappingLabel && !associatedLabels.includes(wrappingLabel)) {
    associatedLabels.push(wrappingLabel)
  }
  const host = el('div', {
    class: 'model-picker-field-host',
    'data-model-picker-for': select.name || select.id,
  })
  select.after(host)
  select.hidden = true
  select.classList.add('model-picker-native')
  select.setAttribute('aria-hidden', 'true')
  select.tabIndex = -1

  function syncNativeOptions(options: readonly ModelOption[]): void {
    clear(select)
    let lastGroup: string | undefined
    let group: HTMLOptGroupElement | null = null
    for (const item of options) {
      if (item.group !== lastGroup) {
        lastGroup = item.group
        if (item.group) {
          group = document.createElement('optgroup')
          group.label = item.group
          select.append(group)
        } else {
          group = null
        }
      }
      const option = nativeOption(item)
      if (group) group.append(option)
      else select.append(option)
    }
    select.value = current
  }

  const { onOptionsLoaded: _ignoredOnOptionsLoaded, ...forwardedOpts } = pickerOpts
  const picker = mountModelPicker(
    host,
    () => current,
    (value) => {
      current = value
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    },
    (value) => pickerOpts.loadOptions(value),
    {
      ...forwardedOpts,
      variant: 'field',
      ariaLabel: pickerOpts.ariaLabel ?? (select.name || select.id),
      // Sync the hidden select only after the winning refresh generation so a
      // stale in-flight load cannot clobber a newer option list / value.
      onOptionsLoaded: syncNativeOptions,
    },
  )
  const trigger = picker.root.querySelector<HTMLButtonElement>('.model-picker-trigger')
  if (trigger && associatedLabels.length > 0) {
    trigger.id = `${select.id}-model-picker-${String(++fieldPickerId)}`
    associatedLabels.forEach((label) => {
      label.htmlFor = trigger.id
    })
  }

  const onNativeChange = (): void => {
    current = select.value
    picker.sync()
  }
  select.addEventListener('change', onNativeChange)

  return {
    ...picker,
    refresh: async (nextCurrent?: string): Promise<void> => {
      if (nextCurrent !== undefined) current = nextCurrent
      await picker.refresh()
    },
    destroy: (): void => {
      select.removeEventListener('change', onNativeChange)
      picker.destroy()
      host.remove()
      select.hidden = false
      select.classList.remove('model-picker-native')
      select.removeAttribute('aria-hidden')
      select.removeAttribute('tabindex')
      associatedLabels.forEach((label) => {
        label.htmlFor = select.id
      })
    },
  }
}
