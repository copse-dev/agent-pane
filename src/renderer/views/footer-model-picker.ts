import { el, clear, on } from '../dom/helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { fetchModelOptions, modelDisplayLabel } from './model-options.ts'

export interface FooterModelPickerOptions {
  /** When true, ACP agents are omitted (SSH workspaces). */
  isSshWorkspace?: () => boolean
  /** Called after the menu closes (e.g. return focus to the composer). */
  onClose?: () => void
}

// Compact footer model picker: the trigger stays narrow (truncated label) while
// the open menu grows to fit long LM Studio model ids.
export function mountFooterModelPicker(
  root: HTMLElement,
  api: ApiClient,
  getCurrent: () => string,
  onSelect: (model: string) => void,
  pickerOpts: FooterModelPickerOptions = {},
): { refresh: () => void; destroy: () => void } {
  const wrap = el('div', { class: 'model-picker' })
  const trigger = el('button', {
    type: 'button',
    class: 'model-picker-trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  })
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
  let cachedOptions: Awaited<ReturnType<typeof fetchModelOptions>> = []
  let activeValue: string | null = null

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

  function matchingOptions(
    options: Awaited<ReturnType<typeof fetchModelOptions>>,
  ): Awaited<ReturnType<typeof fetchModelOptions>> {
    const query = filter.value.trim().toLocaleLowerCase()
    return query
      ? options.filter((opt) => `${opt.label} ${opt.value}`.toLocaleLowerCase().includes(query))
      : options
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

  function renderMenu(options: Awaited<ReturnType<typeof fetchModelOptions>>): void {
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
    const option = cachedOptions.find((opt) => opt.value === value)
    if (!option || option.disabled || !option.value) return
    activeValue = option.value
    onSelect(option.value)
    setOpen(false)
    void refresh()
  }

  function moveActive(direction: -1 | 1): void {
    const enabledOptions = matchingOptions(cachedOptions).filter((opt) => !opt.disabled)
    if (enabledOptions.length === 0) return
    const index = enabledOptions.findIndex((opt) => opt.value === activeValue)
    const nextIndex = Math.max(0, Math.min(enabledOptions.length - 1, index + direction))
    activeValue = enabledOptions[nextIndex]?.value ?? null
    renderMenu(cachedOptions)
  }

  function updateTrigger(options: Awaited<ReturnType<typeof fetchModelOptions>>): void {
    const current = getCurrent()
    const match = options.find((opt) => opt.value === current)
    labelEl.textContent = match?.label ?? modelDisplayLabel(current)
    labelEl.title = current
  }

  async function refresh(): Promise<void> {
    cachedOptions = await fetchModelOptions(api, getCurrent(), {
      sshWorkspace: pickerOpts.isSshWorkspace?.() === true,
    })
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
    }
  })

  cleanups.push(
    on(document, 'click', (e) => {
      if (!open) return
      if (!wrap.contains(e.target instanceof Node ? e.target : null)) setOpen(false)
    }),
    on(document, 'keydown', (e) => {
      const isOpenShortcut =
        (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'm' || e.key === 'M')
      if (isOpenShortcut && !document.querySelector('dialog[open]')) {
        e.preventDefault()
        setOpen(true)
        return
      }
      if (e.key === 'Escape' && open) setOpen(false)
    }),
  )

  void refresh()

  return {
    refresh: () => void refresh(),
    destroy: (): void => {
      cleanups.forEach((u) => {
        u()
      })
    },
  }
}
