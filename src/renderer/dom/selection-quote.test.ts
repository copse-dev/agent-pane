import '../../../tests/setup-dom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bindSelectionQuote } from './selection-quote.ts'

const cleanups: (() => void)[] = []
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => {
    cleanup()
  })
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function fixture(send = async (): Promise<boolean> => true): {
  transcript: HTMLElement
  popup: HTMLElement
  input: HTMLTextAreaElement
  sendButton: HTMLButtonElement
  quotes: { text: string; reply: string }[]
  sends: { text: string; reply: string }[]
} {
  const transcript = document.createElement('div')
  transcript.textContent = 'Selected text for quoting.'
  transcript.getBoundingClientRect = (): DOMRect => new DOMRect(20, 20, 400, 300)
  document.body.append(transcript)
  const quotes: { text: string; reply: string }[] = []
  const sends: { text: string; reply: string }[] = []
  const binding = bindSelectionQuote(transcript, {
    quote: (text, reply) => {
      quotes.push({ text, reply })
    },
    send: async (text, reply) => {
      sends.push({ text, reply })
      return send()
    },
  })
  cleanups.push(binding.destroy)
  const popup = document.querySelector<HTMLElement>('.transcript-selection-quote')
  const input = document.querySelector<HTMLTextAreaElement>('.transcript-selection-reply')
  const sendButton = document.querySelector<HTMLButtonElement>('.transcript-selection-send')
  assert.ok(popup && input && sendButton)
  return { transcript, popup, input, sendButton, quotes, sends }
}

function select(
  root: HTMLElement,
  start: number,
  end: number,
  bounds = new DOMRect(40, 50, 120, 20),
  rects = [bounds],
): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  assert.ok(root.firstChild)
  const range = document.createRange()
  range.setStart(root.firstChild, start)
  range.setEnd(root.firstChild, end)
  range.getClientRects = (): DOMRectList => {
    const visibleRects = rects.map(
      (rect) => new DOMRect(rect.x, rect.y - root.scrollTop, rect.width, rect.height),
    )
    return Object.assign(visibleRects, {
      item: (index: number) => visibleRects[index] ?? null,
    })
  }
  range.cloneRange = (): Range => range
  const selection = document.getSelection()
  assert.ok(selection)
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
}

describe('transcript selection reply', () => {
  it('opens a reply area without repeating the quote and adds its reply to the prompt', () => {
    const { transcript, popup, input, sendButton, quotes } = fixture()
    select(transcript, 0, 13)
    assert.equal(popup.hidden, false)
    assert.equal(document.activeElement, input, 'typing goes straight into the reply')
    assert.equal(input.getAttribute('placeholder'), 'Reply…')
    assert.equal(popup.textContent.includes('Selected text'), false)
    assert.equal(popup.querySelectorAll('button').length, 1)
    assert.equal(sendButton.textContent, 'Send')
    assert.equal(popup.textContent, 'Send')
    assert.equal(sendButton.disabled, true)
    input.value = 'Use these first.'
    input.dispatchEvent(new Event('input'))
    assert.equal(sendButton.disabled, false)
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    sendButton.dispatchEvent(press)
    assert.equal(press.defaultPrevented, true)
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    assert.deepEqual(quotes, [{ text: 'Selected text', reply: 'Use these first.' }])
    assert.equal(popup.hidden, true)
  })

  it('keeps a draft and its original passage through outside clicks, selection changes and blur', () => {
    const { transcript, popup, input, quotes } = fixture()
    select(transcript, 0, 13)
    input.value = 'Keep my reply.'
    input.dispatchEvent(new Event('input'))
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    outside.focus()
    document.dispatchEvent(new PointerEvent('pointerup', { button: 0 }))
    document.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    select(transcript, 14, 18)
    transcript.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    document.dispatchEvent(new PointerEvent('pointercancel'))
    window.dispatchEvent(new Event('blur'))
    assert.equal(popup.hidden, false)
    assert.equal(input.value, 'Keep my reply.')
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    assert.deepEqual(quotes, [{ text: 'Selected text', reply: 'Keep my reply.' }])
  })

  it('pins a drafted reply when its selected passage scrolls out of view', () => {
    const { transcript, popup, input } = fixture()
    popup.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 180, 60)
    select(transcript, 0, 13)
    input.value = 'Still editing.'
    input.dispatchEvent(new Event('input'))
    transcript.scrollTop = 500
    transcript.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    assert.equal(popup.hidden, false)
    assert.equal(input.value, 'Still editing.')
    assert.ok(Number.parseFloat(popup.style.top) >= 8)
    assert.ok(Number.parseFloat(popup.style.top) + 60 <= transcript.getBoundingClientRect().bottom)
  })

  it('closes a drafted reply on Escape and prevents a queued selection event from reopening it', () => {
    const { transcript, popup, input } = fixture()
    select(transcript, 0, 13)
    input.value = 'Discard this.'
    input.dispatchEvent(new Event('input'))
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    input.blur()
    document.dispatchEvent(new Event('selectionchange'))
    assert.equal(popup.hidden, true)
    assert.equal(input.value, '')
  })

  it('closes when all entered text is deleted, including a whitespace-only draft', () => {
    const { transcript, popup, input, sendButton } = fixture()
    select(transcript, 0, 13)
    input.value = ' '
    input.dispatchEvent(new Event('input'))
    transcript.dispatchEvent(new Event('scroll'))
    assert.equal(popup.hidden, false)
    assert.equal(sendButton.disabled, true)
    input.value = ''
    input.dispatchEvent(new Event('input'))
    input.blur()
    document.dispatchEvent(new Event('selectionchange'))
    assert.equal(popup.hidden, true)
    assert.equal(input.value, '')
  })

  it('does not reopen or take focus from the right-click menu after a queued selection event', () => {
    const { transcript, popup, input } = fixture()
    select(transcript, 0, 13)
    transcript.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    input.blur()
    document.dispatchEvent(new Event('selectionchange'))
    assert.equal(popup.hidden, true)
    assert.notEqual(document.activeElement, input)
  })

  it('keeps the selected passage while the textarea owns focus and selection', () => {
    const { transcript, popup, input, quotes } = fixture()
    select(transcript, 0, 13)
    input.focus()
    document.getSelection()?.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    assert.equal(popup.hidden, false)
    input.value = 'My reply'
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    assert.deepEqual(quotes, [{ text: 'Selected text', reply: 'My reply' }])
  })

  it('copies the captured passage after autofocus without changing the draft', () => {
    const { transcript, popup, input } = fixture()
    select(transcript, 0, 14)
    document.getSelection()?.removeAllRanges()
    for (const draft of ['', 'Keep my reply.']) {
      input.value = draft
      input.setSelectionRange(draft.length, draft.length)
      input.dispatchEvent(new Event('input'))
      const clipboardData = new window.DataTransfer()
      const event = new window.ClipboardEvent('copy', { clipboardData, cancelable: true })
      input.dispatchEvent(event)
      assert.equal(event.defaultPrevented, true)
      assert.equal(clipboardData.getData('text/plain'), 'Selected text ')
      assert.equal(input.value, draft)
      assert.equal(popup.hidden, false)
      assert.equal(document.activeElement, input)
    }
  })

  it('leaves selected reply text to native copy and ignores copy after dismissal', () => {
    const { transcript, input } = fixture()
    select(transcript, 0, 13)
    input.value = 'My reply'
    input.setSelectionRange(0, 2)
    const copy = (): ClipboardEvent => {
      const event = new window.ClipboardEvent('copy', {
        clipboardData: new window.DataTransfer(),
        cancelable: true,
      })
      input.dispatchEvent(event)
      return event
    }
    assert.equal(copy().defaultPrevented, false)
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    assert.equal(copy().defaultPrevented, false)
  })

  it('restores the captured passage for a right-click after textarea focus clears it', () => {
    const { transcript, popup } = fixture()
    select(transcript, 0, 13)
    document.getSelection()?.removeAllRanges()
    transcript.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }))
    document.dispatchEvent(new Event('selectionchange'))
    assert.equal(popup.hidden, false)
    transcript.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    assert.equal(document.getSelection()?.toString(), 'Selected text')
    assert.equal(popup.hidden, true)
  })

  it('dismisses an empty reply on a right-click outside the transcript', () => {
    const { transcript, popup } = fixture()
    select(transcript, 0, 13)
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }))
    assert.equal(popup.hidden, true)
  })

  it('adds a bare quote on Enter and leaves Shift+Enter available for a newline', () => {
    const { transcript, input, quotes } = fixture()
    select(transcript, 0, 13)
    const newline = new window.KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      cancelable: true,
    })
    input.dispatchEvent(newline)
    assert.equal(newline.defaultPrevented, false)
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    assert.deepEqual(quotes, [{ text: 'Selected text', reply: '' }])
  })

  for (const modifier of ['metaKey', 'ctrlKey']) {
    it(`sends the captured quote and reply on ${modifier}+Enter`, async () => {
      const { transcript, popup, input, sends, quotes } = fixture()
      select(transcript, 0, 13)
      input.value = 'Send this.'
      input.dispatchEvent(new Event('input'))
      input.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'Enter',
          [modifier]: true,
          cancelable: true,
        }),
      )
      await tick()
      assert.deepEqual(sends, [{ text: 'Selected text', reply: 'Send this.' }])
      assert.deepEqual(quotes, [])
      assert.equal(popup.hidden, true)
    })
  }

  it('prevents duplicate sends while pending and retains a reply on a failed handoff', async () => {
    let complete: (sent: boolean) => void = () => {}
    const pending = new Promise<boolean>((resolve) => {
      complete = resolve
    })
    const { transcript, popup, input, sendButton, sends, quotes } = fixture(() => pending)
    select(transcript, 0, 13)
    input.value = 'Keep this reply.'
    input.dispatchEvent(new Event('input'))
    sendButton.click()
    sendButton.click()

    assert.equal(input.disabled, true)
    assert.equal(sends.length, 1)
    complete(false)
    await tick()
    assert.equal(popup.hidden, false)
    assert.equal(input.value, 'Keep this reply.')

    assert.equal(input.disabled, false)
    assert.equal(
      popup.querySelector('[role="status"]')?.textContent,
      'Reply not sent. Try again or press Enter to add it to the prompt.',
    )
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    assert.deepEqual(quotes, [{ text: 'Selected text', reply: 'Keep this reply.' }])
  })

  it('waits for the end of a pointer drag', () => {
    const { transcript, popup } = fixture()
    transcript.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    select(transcript, 0, 13)
    assert.equal(popup.hidden, true)
    document.dispatchEvent(new PointerEvent('pointerup', { button: 0 }))
    assert.equal(popup.hidden, false)
  })

  it('dismisses collapsed and outside selections', () => {
    const { transcript, popup } = fixture()
    select(transcript, 0, 13)
    select(transcript, 0, 0)
    assert.equal(popup.hidden, true)
    const outside = document.createElement('div')
    outside.textContent = 'Outside text'
    document.body.append(outside)
    select(outside, 0, 7)
    assert.equal(popup.hidden, true)
  })

  it('ignores whitespace and selections outside the visible transcript', () => {
    const { transcript, popup } = fixture()
    select(transcript, 0, 13, new DOMRect(40, 400, 120, 20))
    assert.equal(popup.hidden, true)
    transcript.textContent = '   '
    select(transcript, 0, 3)
    assert.equal(popup.hidden, true)
  })

  it('keeps the popover inside a narrow transcript and places it above the selection when possible', () => {
    const { transcript, popup } = fixture()
    transcript.getBoundingClientRect = (): DOMRect => new DOMRect(20, 20, 180, 100)
    popup.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 120, 30)
    select(transcript, 0, 13, new DOMRect(170, 90, 20, 20))
    assert.equal(popup.hidden, false)
    assert.equal(popup.style.left, '72px')
    assert.equal(popup.style.top, '52px')
  })

  it('keeps the reply above every line in a multiline selection', () => {
    const { transcript, popup } = fixture()
    popup.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 180, 80)
    const rects = [
      new DOMRect(40, 160, 120, 20),
      new DOMRect(40, 180, 260, 20),
      new DOMRect(40, 200, 180, 20),
    ]
    select(transcript, 0, 13, rects[0], rects)
    assert.equal(popup.hidden, false)
    assert.equal(popup.style.top, '72px')
    assert.ok(rects.every((rect) => Number.parseFloat(popup.style.top) + 80 <= rect.top))
  })

  it('reserves scroll space when neither side of the multiline selection has room', () => {
    const { transcript, popup, input } = fixture()
    const viewport = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 120 })
    cleanups.push(() => {
      if (viewport) Object.defineProperty(window, 'innerHeight', viewport)
      else Reflect.deleteProperty(window, 'innerHeight')
    })
    transcript.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 400, 120)
    popup.getBoundingClientRect = (): DOMRect => new DOMRect(0, 0, 180, 50)
    const rects = [
      new DOMRect(40, 10, 120, 20),
      new DOMRect(40, 50, 260, 20),
      new DOMRect(40, 90, 180, 20),
    ]
    select(transcript, 0, 13, rects[0], rects)
    assert.equal(transcript.style.getPropertyValue('--selection-reply-space'), '66px')
    assert.equal(transcript.scrollTop, 56)
    assert.equal(popup.style.top, '62px')
    const top = Number.parseFloat(popup.style.top)
    assert.ok(rects.every((rect) => top >= rect.bottom - transcript.scrollTop))
    assert.ok(top + 50 <= window.innerHeight - 8)
    transcript.dispatchEvent(new Event('scroll'))
    assert.equal(popup.hidden, false, 'the positioning scroll must not dismiss the reply')
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    assert.equal(transcript.style.getPropertyValue('--selection-reply-space'), '')
    assert.equal(popup.hidden, true)
  })

  it('dismisses on Escape, scrolling and right-click', () => {
    const { transcript, popup } = fixture()
    select(transcript, 0, 13)
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    assert.equal(popup.hidden, true)
    select(transcript, 0, 13)
    transcript.dispatchEvent(new Event('scroll'))
    assert.equal(popup.hidden, true)
    select(transcript, 0, 13)
    transcript.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    assert.equal(popup.hidden, true)
  })

  it('removes the popover and document listeners on teardown', () => {
    const { transcript, popup, input, quotes } = fixture()
    cleanups.splice(0).forEach((cleanup) => {
      cleanup()
    })
    select(transcript, 0, 13)
    assert.equal(popup.isConnected, false)
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    assert.deepEqual(quotes, [])
    assert.equal(document.querySelector('.transcript-selection-quote'), null)
  })
})
