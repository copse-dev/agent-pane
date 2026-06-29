import { el } from '../dom/helpers.ts'

const COPY_LABEL = 'Copy'
const COPIED_LABEL = 'Copied'
const FEEDBACK_MS = 1200

function copyButtonText(code: HTMLElement): string {
  return code.textContent.trimStart()
}

export function attachCodeBlockCopyButtons(root: ParentNode): void {
  const blocks = root.querySelectorAll('pre:has(> code):not(.mermaid):not([data-copy-attached])')
  for (const node of blocks) {
    const pre = node as HTMLElement
    if (pre.closest('.mermaid-diagram')) continue

    const code = pre.querySelector('code')
    if (!code) continue

    const parent = pre.parentNode
    if (!parent) continue

    pre.dataset['copyAttached'] = 'true'
    pre.classList.add('code-block')

    const shell = el('div', { class: 'code-block-shell' })
    parent.insertBefore(shell, pre)
    shell.append(pre)

    const copyBtn = el(
      'button',
      { class: 'code-block-copy', 'aria-label': 'Copy code' },
      COPY_LABEL,
    )
    copyBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void navigator.clipboard.writeText(copyButtonText(code)).then(() => {
        copyBtn.textContent = COPIED_LABEL
        setTimeout(() => {
          copyBtn.textContent = COPY_LABEL
        }, FEEDBACK_MS)
      })
    })
    shell.prepend(copyBtn)
  }
}
