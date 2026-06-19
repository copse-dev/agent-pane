import { el, clear, on } from '../dom/helpers.ts'
import type { ApiClient } from '../../preload/api.d.ts'
import { fetchModelOptions, modelDisplayLabel } from './model-options.ts'

// Compact footer model picker: the trigger stays narrow (truncated label) while
// the open menu grows to fit long LM Studio model ids.
export function mountFooterModelPicker(
  root: HTMLElement,
  api: ApiClient,
  getCurrent: () => string,
  onSelect: (model: string) => void,
): { refresh: () => void; destroy: () => void } {
  const wrap = el('div', { class: 'model-picker' })
  const trigger = el('button', {
    type: 'button',
    class: 'model-picker-trigger',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  })
  const labelEl = el('span', { class: 'model-picker-label' })
  const chevron = el('span', { class: 'model-picker-chevron', 'aria-hidden': 'true' }, '▾')
  trigger.append(labelEl, chevron)
  const menu = el('div', { class: 'model-picker-menu', role: 'listbox', hidden: '' })
  wrap.append(trigger, menu)
  root.append(wrap)

  let open = false
  const cleanups: Array<() => void> = []

  function setOpen(next: boolean) {
    open = next
    trigger.setAttribute('aria-expanded', String(next))
    if (next) menu.removeAttribute('hidden')
    else menu.setAttribute('hidden', '')
  }

  function renderMenu(options: Awaited<ReturnType<typeof fetchModelOptions>>) {
    clear(menu)
    const current = getCurrent()
    let lastGroup: string | undefined
    for (const opt of options) {
      if (opt.group !== lastGroup) {
        lastGroup = opt.group
        if (opt.group) menu.append(el('div', { class: 'model-picker-group-label' }, opt.group))
      }
      const item = el(
        'button',
        {
          type: 'button',
          class: 'model-picker-option',
          role: 'option',
          'aria-selected': opt.value === current ? 'true' : 'false',
          disabled: opt.disabled ? true : undefined,
        },
        opt.label,
      )
      if (opt.value === current) item.classList.add('is-selected')
      item.addEventListener('click', () => {
        if (opt.disabled || !opt.value) return
        onSelect(opt.value)
        setOpen(false)
        updateTrigger()
        renderMenu(options)
      })
      menu.append(item)
    }
  }

  function updateTrigger() {
    labelEl.textContent = modelDisplayLabel(getCurrent())
    labelEl.title = getCurrent()
  }

  async function refresh() {
    const options = await fetchModelOptions(api, getCurrent())
    renderMenu(options)
    updateTrigger()
  }

  trigger.addEventListener('click', () => {
    setOpen(!open)
  })

  cleanups.push(
    on(document, 'click', (e) => {
      if (!open) return
      if (!wrap.contains(e.target as Node)) setOpen(false)
    }),
    on(document, 'keydown', (e) => {
      if (e.key === 'Escape' && open) setOpen(false)
    }),
  )

  void refresh()

  return {
    refresh,
    destroy: () => cleanups.forEach((u) => u()),
  }
}
