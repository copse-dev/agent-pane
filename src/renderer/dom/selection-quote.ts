import { el } from './helpers.ts'
import { trimSelectionText } from './markdown-quote.ts'

/** Keep a selected passage as context while the reader composes a reply beside it. */
export function bindSelectionQuote(
  transcript: HTMLElement,
  actions: {
    quote: (text: string, reply: string) => void
    send: (text: string, reply: string) => Promise<boolean>
  },
): { dismiss: () => void; destroy: () => void } {
  const input = el('textarea', {
    class: 'transcript-selection-reply',
    placeholder: 'Reply…',
    'aria-label': 'Reply to selected text',
    rows: '2',
  })
  input.setAttribute('aria-keyshortcuts', 'Enter Meta+Enter Control+Enter')
  const sendLabel = el('span', {}, 'Send')
  const sendButton = el(
    'button',
    {
      class: 'transcript-selection-send',
      type: 'button',
      'aria-keyshortcuts': 'Meta+Enter Control+Enter',
    },
    sendLabel,
  )
  const status = el('div', { class: 'transcript-selection-status', role: 'status', hidden: true })
  const popup = el(
    'div',
    { class: 'transcript-selection-quote', hidden: true, role: 'group', 'aria-label': 'Selection reply' },
    input,
    el('div', { class: 'transcript-selection-actions' }, sendButton),
    status,
  )
  document.body.append(popup)
  let selectedText = ''
  let selectedRange: Range | null = null
  const highlights = typeof CSS === 'undefined' ? undefined : CSS.highlights
  const highlight = typeof Highlight === 'undefined' ? null : new Highlight()
  let dragging = false
  let suppressed = false
  let sending = false
  let hadText = false
  let revision = 0
  let reservedSpace = false
  let scrollingTo: number | null = null

  const hasDraft = (): boolean => input.value.length > 0 || sending
  const updateControls = (): void => {
    input.disabled = sending
    sendButton.disabled = sending || !input.value.trim()
    sendLabel.textContent = sending ? 'Sending…' : 'Send'
    hadText = input.value.length > 0
  }
  const dismiss = (): void => {
    revision++
    popup.hidden = true
    selectedText = ''
    selectedRange = null
    scrollingTo = null
    if (reservedSpace) {
      transcript.style.removeProperty('--selection-reply-space')
      reservedSpace = false
    }
    if (highlight) {
      if (highlights && highlights.get('transcript-reply-selection') === highlight) {
        highlights.delete('transcript-reply-selection')
      }
      highlight.clear()
    }
    input.value = ''
    status.hidden = true
    status.textContent = ''
    sending = false
    updateControls()
  }

  const selectionBounds = () => {
    if (!selectedRange) return null
    const rects = [...selectedRange.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
    if (rects.length === 0) return null
    return {
      top: Math.min(...rects.map((rect) => rect.top)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
      left: Math.min(...rects.map((rect) => rect.left)),
      right: Math.max(...rects.map((rect) => rect.right)),
    }
  }
  const position = (): void => {
    let selection = selectionBounds()
    const bounds = transcript.getBoundingClientRect()
    if (
      !selection ||
      selection.bottom <= bounds.top ||
      selection.top >= bounds.bottom ||
      selection.right <= bounds.left ||
      selection.left >= bounds.right
    ) {
      if (hasDraft()) {
        // The captured passage may scroll away or be replaced during a rerender.
        // Keep the draft visible until the reader explicitly finishes or clears it.
        const size = popup.getBoundingClientRect()
        const top = Number.parseFloat(popup.style.top) || bounds.top
        const left = Number.parseFloat(popup.style.left) || bounds.left
        const bottom = Math.min(bounds.bottom, window.innerHeight - 8)
        popup.style.top = `${Math.max(8, Math.min(top, bottom - size.height))}px`
        popup.style.left = `${Math.max(8, Math.min(left, window.innerWidth - size.width - 8))}px`
      } else {
        dismiss()
      }
      return
    }
    popup.hidden = false
    const size = popup.getBoundingClientRect()
    const gap = 8
    const visibleTop = Math.max(bounds.top, gap)
    const visibleBottom = Math.min(bounds.bottom, window.innerHeight - gap)
    let top = selection.top - size.height - gap
    if (top < visibleTop) {
      top = selection.bottom + gap
      if (top + size.height > visibleBottom) {
        // A selection can fill the viewport. Reserve real scroll space for the
        // reply, then bring the last selected line above it instead of covering text.
        transcript.style.setProperty('--selection-reply-space', `${size.height + 2 * gap}px`)
        reservedSpace = true
        const before = transcript.scrollTop
        transcript.scrollTop += Math.max(0, selection.bottom + gap + size.height - visibleBottom)
        if (transcript.scrollTop !== before) scrollingTo = transcript.scrollTop
        selection = selectionBounds()
        if (!selection) {
          dismiss()
          return
        }
        top = selection.bottom + gap
      }
    }
    const left = Math.max(bounds.left + gap, Math.min(selection.left, bounds.right - size.width - gap))
    popup.style.left = `${Math.max(gap, Math.min(left, window.innerWidth - size.width - gap))}px`
    // Never clamp vertically into the selected lines.
    popup.style.top = `${top}px`
  }
  const refresh = (): void => {
    // A textarea has its own selection; focusing or editing it must keep the passage captured above.
    if (hasDraft() || dragging || suppressed || popup.contains(document.activeElement)) return
    const selection = document.getSelection()
    if (
      !transcript.isConnected ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !transcript.contains(selection.anchorNode) ||
      !transcript.contains(selection.focusNode)
    ) {
      dismiss()
      return
    }
    const text = trimSelectionText(selection.toString())
    if (!text) {
      dismiss()
      return
    }
    if (text !== selectedText) {
      input.value = ''
      status.hidden = true
      revision++
    }
    const opening = popup.hidden
    selectedText = text
    selectedRange = selection.getRangeAt(0).cloneRange()
    if (highlight && highlights) {
      highlight.clear()
      highlight.add(selectedRange)
      highlights.set('transcript-reply-selection', highlight)
    }
    updateControls()
    position()
    if (opening && !popup.hidden) input.focus({ preventScroll: true })
  }
  const reposition = (): void => {
    if (!popup.hidden) position()
  }
  const addToPrompt = (): void => {
    if (!selectedText || sending) return
    const text = selectedText
    const reply = input.value.trim()
    dismiss()
    actions.quote(text, reply)
  }
  const sendReply = async (): Promise<void> => {
    if (!selectedText || !input.value.trim() || sending) return
    const ticket = revision
    sending = true
    status.hidden = true
    updateControls()
    let handedOff = false
    try {
      handedOff = await actions.send(selectedText, input.value.trim())
    } catch {
      // Keep the reply editable on a failed send; the submission path reports the cause.
    }
    if (ticket !== revision) return
    sending = false
    if (handedOff) {
      dismiss()
    } else {
      status.textContent = 'Reply not sent. Try again or press Enter to add it to the prompt.'
      status.hidden = false
      updateControls()
      position()
    }
  }

  input.addEventListener('input', () => {
    if (hadText && input.value.length === 0) {
      suppressed = true
      dismiss()
    } else {
      updateControls()
    }
  })
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return
    event.preventDefault()
    event.stopPropagation()
    if (event.metaKey || event.ctrlKey) void sendReply()
    else addToPrompt()
  })
  // Sending keeps the textarea's focus and the captured selection.
  sendButton.addEventListener('mousedown', (event) => event.preventDefault())
  sendButton.addEventListener('click', () => void sendReply())

  const onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && popup.contains(event.target)) return
    dragging = event.button === 0
    if (dragging) suppressed = false
    if (!hasDraft()) dismiss()
  }
  const onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !dragging) return
    dragging = false
    refresh()
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      suppressed = true
      dismiss()
    } else if (event.shiftKey && event.key.startsWith('Arrow')) {
      suppressed = false
    }
  }
  const onContextMenu = (): void => {
    if (hasDraft()) return
    suppressed = true
    dismiss()
  }
  const onPointerCancel = (): void => {
    dragging = false
    if (!hasDraft()) dismiss()
  }
  const onScroll = (event: Event): void => {
    if (event.target instanceof Node && popup.contains(event.target)) return
    if (
      event.target === transcript &&
      scrollingTo !== null &&
      Math.abs(transcript.scrollTop - scrollingTo) < 1
    ) {
      scrollingTo = null
      return
    }
    if (hasDraft()) position()
    else dismiss()
  }

  document.addEventListener('selectionchange', refresh)
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('pointerup', onPointerUp)
  document.addEventListener('pointercancel', onPointerCancel)
  document.addEventListener('keydown', onKeyDown)
  transcript.addEventListener('contextmenu', onContextMenu)
  document.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('blur', onPointerCancel)
  updateControls()

  return {
    dismiss,
    destroy: (): void => {
      dismiss()
      popup.remove()
      document.removeEventListener('selectionchange', refresh)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('keydown', onKeyDown)
      transcript.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('blur', onPointerCancel)
    },
  }
}
