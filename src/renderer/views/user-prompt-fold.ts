import { el } from '../dom/helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'

/** Fold when a settled user prompt exceeds this many lines. */
export const USER_PROMPT_FOLD_LINE_THRESHOLD = 10

/** Opening bookend kept visible while folded. */
export const USER_PROMPT_FOLD_HEAD_LINES = 2

/** Closing bookend (usually the ask) kept visible while folded. */
export const USER_PROMPT_FOLD_TAIL_LINES = 1

export type UserPromptFoldParts = {
  head: string
  middle: string
  tail: string
  hiddenLineCount: number
}

/** Split on `\n`; a trailing newline does not invent an extra visible line. */
export function userPromptLines(content: string): string[] {
  if (!content) return []
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Mid-fold bookends for long prompts: keep the opening lines and the closing
 * ask, hide the middle. Returns null when the prompt should render in full.
 */
export function splitUserPromptForFold(content: string): UserPromptFoldParts | null {
  const lines = userPromptLines(content)
  if (lines.length <= USER_PROMPT_FOLD_LINE_THRESHOLD) return null
  const headCount = USER_PROMPT_FOLD_HEAD_LINES
  const tailCount = USER_PROMPT_FOLD_TAIL_LINES
  if (lines.length <= headCount + tailCount) return null
  const middleLines = lines.slice(headCount, lines.length - tailCount)
  if (middleLines.length === 0) return null
  return {
    head: lines.slice(0, headCount).join('\n'),
    middle: middleLines.join('\n'),
    tail: lines.slice(lines.length - tailCount).join('\n'),
    hiddenLineCount: middleLines.length,
  }
}

function foldLabel(expanded: boolean, hiddenLineCount: number): string {
  return expanded ? 'collapse' : `${String(hiddenLineCount)} lines hidden`
}

/**
 * Fill an existing `.message-text` host with the mid-fold accordion. `renderPart`
 * paints markdown (or plain text) into each bookend / middle region.
 */
export function fillUserPromptFold(
  host: HTMLElement,
  parts: UserPromptFoldParts,
  renderPart: (el: HTMLElement, text: string) => void,
): void {
  host.classList.add('msg-user-fold')
  host.classList.remove('is-expanded')
  host.replaceChildren()

  const head = el('div', { class: 'msg-user-fold-head' })
  renderPart(head, parts.head)

  const label = el(
    'span',
    { class: 'msg-user-fold-label' },
    foldLabel(false, parts.hiddenLineCount),
  )
  const toggle = el(
    'button',
    {
      class: 'msg-user-fold-toggle',
      type: 'button',
      'aria-expanded': 'false',
    },
    chevronDownIcon('ui-icon msg-user-fold-chev'),
    label,
  )

  const middle = el('div', { class: 'msg-user-fold-middle' })
  renderPart(middle, parts.middle)

  const tail = el('div', { class: 'msg-user-fold-tail' })
  renderPart(tail, parts.tail)

  toggle.addEventListener('click', () => {
    const open = !host.classList.contains('is-expanded')
    host.classList.toggle('is-expanded', open)
    toggle.setAttribute('aria-expanded', String(open))
    label.textContent = foldLabel(open, parts.hiddenLineCount)
  })

  host.append(head, el('div', { class: 'msg-user-fold-control' }, toggle), middle, tail)
}
