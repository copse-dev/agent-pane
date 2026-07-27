import { el, clear, on } from '../dom/helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'
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
  /**
   * Runs only after a refresh wins its generation race. Use this for side effects
   * that must not apply from a stale in-flight load (e.g. syncing a native select).
   */
  onOptionsLoaded?: (options: readonly ModelOption[]) => void
}

export interface ModelPicker {
  root: HTMLElement
  refresh: () => Promise<void>
  sync: () => void
  destroy: () => void
}

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
  const wrap = el('div', {
    class: ['model-picker', `model-picker-${variant}`, pickerOpts.className]
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
  const menu = el('div', { class: 'model-picker-menu', hidden: '' })
  const filter = el('input', {
    type: 'search',
    class: 'model-picker-filter',
    placeholder: 'Filter models...',
    'aria-label': 'Filter models',
    autocomplete: 'off',
  })
  const list = el('div', { class: 'model-picker-list', role: 'listbox' })
  menu.append(filter, list)
  wrap.append(trigger, menu)
  root.append(wrap)

  let open = false
  const cleanups: Array<() => void> = []
  let cachedOptions: ModelOption[] = []
  let activeValue: string | null = null
  let refreshGeneration = 0

  function setOpen(next: boolean): void {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    if (next) {
      menu.removeAttribute('hidden')
      renderMenu(cachedOptions)
      filter.focus()
    } else {
      menu.setAttribute('hidden', '')
      filter.value = ''
      renderMenu(cachedOptions)
      pickerOpts.onClose?.()
    }
  }

  function matchingOptions(options: readonly ModelOption[]): ModelOption[] {
    const query = filter.value.trim().toLocaleLowerCase()
    return query
      ? options.filter((opt) => `${opt.label} ${opt.value}`.toLocaleLowerCase().includes(query))
      : [...options]
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

  function renderMenu(options: readonly ModelOption[]): void {
    clear(list)
    const current = getCurrent()
    const matches = matchingOptions(options)
    const active =
      matches.find((opt) => opt.value === activeValue && !opt.disabled) ??
      matches.find((opt) => opt.value === current && !opt.disabled) ??
      matches.find((opt) => !opt.disabled)
    activeValue = active?.value ?? null
    let lastGroup: string | undefined
    for (const opt of matches) {
      if (opt.group !== lastGroup) {
        lastGroup = opt.group
        if (opt.group) list.append(el('div', { class: 'model-picker-group-label' }, opt.group))
      }
      const item = el(
        'button',
        {
          type: 'button',
          class: 'model-picker-option',
          role: 'option',
          'data-value': opt.value,
          'aria-selected': opt.value === activeValue ? 'true' : 'false',
          disabled: opt.disabled ? true : undefined,
        },
        opt.label,
      )
      if (opt.value === current) item.classList.add('is-selected')
      if (opt.value === activeValue) item.classList.add('is-active')
      item.addEventListener('click', () => {
        selectOption(opt.value)
      })
      list.append(item)
    }
    if (matches.length === 0) {
      list.append(el('div', { class: 'model-picker-empty' }, 'No matching models'))
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
    const enabledOptions = matchingOptions(cachedOptions).filter((opt) => !opt.disabled)
    if (enabledOptions.length === 0) return
    const index = enabledOptions.findIndex((opt) => opt.value === activeValue)
    const nextIndex = Math.max(0, Math.min(enabledOptions.length - 1, index + direction))
    activeValue = enabledOptions[nextIndex]?.value ?? null
    renderMenu(cachedOptions)
  }

  function updateTrigger(options: readonly ModelOption[]): void {
    const current = getCurrent()
    const match = options.find((opt) => opt.value === current)
    labelEl.textContent = match?.label ?? (current ? modelDisplayLabel(current) : 'Select model')
    labelEl.title = current
  }

  async function refresh(): Promise<void> {
    const generation = ++refreshGeneration
    const options = await loadOptions(getCurrent())
    if (generation !== refreshGeneration) return
    cachedOptions = options
    pickerOpts.onOptionsLoaded?.(cachedOptions)
    renderMenu(cachedOptions)
    updateTrigger(cachedOptions)
  }

  function sync(): void {
    renderMenu(cachedOptions)
    updateTrigger(cachedOptions)
  }

  trigger.addEventListener('click', () => {
    setOpen(!open)
  })
  filter.addEventListener('input', () => {
    renderMenu(cachedOptions)
  })
  filter.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      selectOption(activeValue)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      trigger.focus()
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
