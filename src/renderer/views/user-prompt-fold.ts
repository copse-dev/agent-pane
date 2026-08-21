import { el } from '../dom/helpers.ts'
import { chevronDownIcon } from '../dom/icons.ts'

/** Fold when a settled user prompt would render taller than this many visual
 *  lines. Newlines alone miss soft-wrapped prose, so the decision also counts
 *  wrapped lines estimated from text length (see USER_PROMPT_FOLD_CHARS_PER_LINE). */
export const USER_PROMPT_FOLD_LINE_THRESHOLD = 10

/** Rough characters-per-line at the chat column width. Only feeds the fold
 *  prediction — no live measurement, so the folded stage renders on the first
 *  paint instead of flashing the full prompt before collapsing. */
export const USER_PROMPT_FOLD_CHARS_PER_LINE = 100

/** Opening bookend kept visible while folded. */
export const USER_PROMPT_FOLD_HEAD_LINES = 2

/** Closing bookend (usually the ask) kept visible while folded. */
export const USER_PROMPT_FOLD_TAIL_LINES = 1

export type UserPromptFoldParts = {
  head: string
  middle: string
  tail: string
}

/** Split on `\n`; a trailing newline does not invent an extra visible line. */
export function userPromptLines(content: string): string[] {
  if (!content) return []
  const lines = content.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Predict how many rendered lines a prompt occupies: its hard newlines plus
 *  the soft wraps a long run of text contributes at the chat column width.
 *  Pure arithmetic — no detached-element measurement, so the fold is decided
 *  before anything paints and never flashes a full-height box. */
export function userPromptWrappedLineEstimate(content: string): number {
  const lines = userPromptLines(content)
  let total = 0
  for (const line of lines) {
    total += Math.max(1, Math.ceil(line.length / USER_PROMPT_FOLD_CHARS_PER_LINE))
  }
  return total
}

/** Pass over `words` from one end, returning how many fit under a char budget. */
function budgetWordRun(words: string[], budget: number, fromEnd: boolean): number {
  let count = 0
  let used = 0
  const slice = fromEnd ? words.slice().reverse() : words
  for (const word of slice) {
    const add = used === 0 ? word.length : word.length + 1
    if (used + add > budget) break
    used += add
    count++
  }
  return count
}

/**
 * Long single-paragraph prose has no newline to split on, so carve it by word
 * instead: head and tail stay visible around a hidden middle. Returns null when
 * there is no middle to hide (too few words to be genuinely large).
 */
function splitProseFold(content: string): UserPromptFoldParts | null {
  const words = content.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return null
  const headBudget = USER_PROMPT_FOLD_HEAD_LINES * USER_PROMPT_FOLD_CHARS_PER_LINE
  const tailBudget = USER_PROMPT_FOLD_TAIL_LINES * USER_PROMPT_FOLD_CHARS_PER_LINE
  const headCount = budgetWordRun(words, headBudget, false)
  const tailCount = budgetWordRun(words, tailBudget, true)
  if (headCount === 0 || headCount + tailCount >= words.length) return null
  const middle = words.slice(headCount, words.length - tailCount)
  if (middle.length === 0) return null
  return {
    head: words.slice(0, headCount).join(' '),
    middle: middle.join(' '),
    tail: words.slice(words.length - tailCount).join(' '),
  }
}

/**
 * Mid-fold bookends for long prompts: keep the opening lines and the closing
 * ask, hide the middle. Long single-paragraph prose (no newline boundary,
 * e.g. a soft-wrapped pasted block) falls back to a word-carved head/middle/
 * tail. Returns null when the prompt should render in full.
 */
export function splitUserPromptForFold(content: string): UserPromptFoldParts | null {
  const lines = userPromptLines(content)
  if (lines.length === 0) return null
  const lineCount = lines.length
  const wrappedEstimate = userPromptWrappedLineEstimate(content)
  // Gate on the larger of the two counts, so a few long-sentence paragraphs
  // (soft-wrapped into many visual lines) fold even when `\n` is scarce.
  if (Math.max(lineCount, wrappedEstimate) <= USER_PROMPT_FOLD_LINE_THRESHOLD) return null

  const headCount = USER_PROMPT_FOLD_HEAD_LINES
  const tailCount = USER_PROMPT_FOLD_TAIL_LINES
  if (lineCount <= headCount + tailCount) return splitProseFold(content)
  const middleLines = lines.slice(headCount, lines.length - tailCount)
  if (middleLines.length === 0) return null
  return {
    head: lines.slice(0, headCount).join('\n'),
    middle: middleLines.join('\n'),
    tail: lines.slice(lines.length - tailCount).join('\n'),
  }
}

function foldLabel(expanded: boolean): string {
  return expanded ? 'collapse' : 'expand'
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

  const label = el('span', { class: 'msg-user-fold-label' }, foldLabel(false))
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
    label.textContent = foldLabel(open)
  })

  host.append(head, el('div', { class: 'msg-user-fold-control' }, toggle), middle, tail)
}
