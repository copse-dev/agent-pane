import { el } from '../dom/helpers.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

/** Open a plain-text snapshot without interpreting its contents as markup. */
export function openTextExpand(content: string, name: string): void {
  const text = el('pre', { class: 'attachment-preview-text' })
  text.textContent = content
  openAttachmentPreview({
    kind: 'text',
    title: name,
    ariaLabel: `Text preview: ${name}`,
    content: text,
  })
}

/** Make a sent text attachment keyboard- and pointer-openable. */
export function attachTextExpand(chip: HTMLElement, content: string, name: string): void {
  if (chip.dataset['textExpand'] === 'true') return
  chip.dataset['textExpand'] = 'true'
  chip.classList.add('text-expandable')
  chip.setAttribute('role', 'button')
  chip.setAttribute('tabindex', '0')
  chip.setAttribute('aria-label', `Preview ${name}`)

  const open = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
    openTextExpand(content, name)
  }
  chip.addEventListener('click', open)
  chip.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    open(event)
  })
}
