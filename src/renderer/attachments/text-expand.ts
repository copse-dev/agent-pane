import { showContextMenu } from '../dom/context-menu.ts'
import { el } from '../dom/helpers.ts'
import { showErrorToast, showToast } from '../views/toast.ts'
import { openAttachmentPreview } from './attachment-preview.ts'

function copyText(text: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => showToast('Copied', { durationMs: 1500 }))
    .catch((error: unknown) => {
      showErrorToast('Failed to copy', error)
    })
}

function selectedTextWithin(root: Node): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index)
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  }
  const selected = selection.toString()
  return selected.length > 0 ? selected : null
}

/** Open a plain-text snapshot without interpreting its contents as markup. */
export function openTextExpand(content: string, name: string): void {
  const text = el('pre', { class: 'attachment-preview-text' })
  text.textContent = content
  text.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
    const selected = selectedTextWithin(text)
    showContextMenu(
      event.clientX,
      event.clientY,
      [
        {
          label: selected ? 'Copy selection' : 'Copy',
          onSelect: (): void => {
            copyText(selected ?? content)
          },
        },
      ],
      text,
    )
  })
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
