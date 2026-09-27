import { browser } from '@wdio/globals'

/**
 * Computed styles of an open model picker menu, with the design tokens they
 * should match resolved in the same page so a comparison is colour-to-colour
 * rather than against a hard-coded rgb() that changes with the theme.
 */
export interface ModelPickerMenuStyle {
  /** list.scrollWidth − list.clientWidth; > 0 means the list scrolls sideways. */
  listHorizontalOverflow: number
  /** Option labels in order, for failure messages. */
  labels: string[]
  labelTextOverflow: string[]
  /** The first label wider than its box, if any, with its row's tooltip. */
  truncated: { text: string; title: string } | null
  optionFontFamily: string
  optionFontSize: string
  selectedColor: string | null
  selectedBackground: string | null
  selectedFontWeight: string | null
  activeBackground: string | null
  activeIsSelected: boolean
  tokens: {
    accent: string
    textPrimary: string
    bgHover: string
    bgSelected: string
    fontMono: string
    fontFamily: string
    fontSizeSm: string
  }
}

export async function readModelPickerMenuStyle(
  menuSelector: string,
): Promise<ModelPickerMenuStyle | null> {
  return browser.execute((menuSelector) => {
    const menu = document.querySelector<HTMLElement>(menuSelector)
    const list = menu?.querySelector<HTMLElement>('.model-picker-list')
    const option = menu?.querySelector<HTMLElement>('.model-picker-option')
    if (!menu || !list || !option) return null
    const probe = (
      property: 'color' | 'backgroundColor' | 'fontFamily' | 'fontSize',
      value: string,
    ) => {
      const el = document.createElement('div')
      el.style[property] = value
      menu.append(el)
      const resolved = getComputedStyle(el)[property]
      el.remove()
      return resolved
    }
    const labels = [...menu.querySelectorAll<HTMLElement>('.model-picker-option-label')]
    const truncated = labels.find((label) => label.scrollWidth > label.clientWidth + 1)
    const selected = menu.querySelector<HTMLElement>('.model-picker-option.is-selected')
    const active = menu.querySelector<HTMLElement>('.model-picker-option.is-active')
    return {
      listHorizontalOverflow: list.scrollWidth - list.clientWidth,
      labels: labels.map((label) => label.textContent ?? ''),
      labelTextOverflow: [...new Set(labels.map((label) => getComputedStyle(label).textOverflow))],
      truncated: truncated
        ? {
            text: truncated.textContent ?? '',
            title: truncated.closest<HTMLElement>('.model-picker-option')?.title ?? '',
          }
        : null,
      optionFontFamily: getComputedStyle(option).fontFamily,
      optionFontSize: getComputedStyle(option).fontSize,
      selectedColor: selected ? getComputedStyle(selected).color : null,
      selectedBackground: selected ? getComputedStyle(selected).backgroundColor : null,
      selectedFontWeight: selected ? getComputedStyle(selected).fontWeight : null,
      activeBackground: active ? getComputedStyle(active).backgroundColor : null,
      activeIsSelected: !!active && active === selected,
      tokens: {
        accent: probe('color', 'var(--accent)'),
        textPrimary: probe('color', 'var(--text-primary)'),
        bgHover: probe('backgroundColor', 'var(--bg-hover)'),
        bgSelected: probe('backgroundColor', 'var(--bg-selected)'),
        fontMono: probe('fontFamily', 'var(--font-mono)'),
        fontFamily: probe('fontFamily', 'var(--font-family)'),
        fontSizeSm: probe('fontSize', 'var(--font-size-sm)'),
      },
    }
  }, menuSelector)
}

/** Styles of a focused model-picker filter: one accent border, no outline. */
export async function readFocusedFilterStyle(filterSelector: string): Promise<{
  focused: boolean
  outlineStyle: string
  outlineWidth: string
  borderColor: string
  boxShadow: string
  accent: string
} | null> {
  return browser.execute((filterSelector) => {
    const filter = document.querySelector<HTMLInputElement>(filterSelector)
    if (!filter) return null
    filter.focus()
    const probe = document.createElement('div')
    probe.style.color = 'var(--accent)'
    document.body.append(probe)
    const accent = getComputedStyle(probe).color
    probe.remove()
    const style = getComputedStyle(filter)
    return {
      focused: document.activeElement === filter,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      borderColor: style.borderTopColor,
      boxShadow: style.boxShadow,
      accent,
    }
  }, filterSelector)
}
