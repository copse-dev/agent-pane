/**
 * Drives the browser demo the way a visitor would: focus the composer, type the
 * recorded prompt a character at a time, and press Send. Everything after that
 * is the app's own doing — the replayed trace arrives on the normal chunk path
 * (see `trace-player.ts`), so what you watch is the real streaming transcript,
 * not a scripted animation of one.
 *
 * It only ever touches public DOM — `.prompt-input`, `.submit-btn`, and the
 * projects pane's new-thread button — because anything deeper would be a demo
 * private road that the app could break without noticing.
 */

const COMPOSER_SELECTOR = '.prompt-input'
const SUBMIT_SELECTOR = '.submit-btn'
/** `.submit-btn` wears this while a run is in flight (it renders as Stop). */
const RUNNING_CLASS = 'with-stop'

const MOUNT_TIMEOUT_MS = 20_000
const RUN_TIMEOUT_MS = 120_000
const POLL_MS = 60

export interface AutoplayOptions {
  /** Text to type into the composer. */
  prompt: string
  /** Reload and play again after each run instead of stopping. */
  loop?: boolean
  /** Type and pause instantly — reduced motion, or a test. */
  instant?: boolean
  /** Typing speed. Human-fast rather than machine-instant. */
  charsPerSecond?: number
  /** Wait before the first keystroke, so the app has settled visually. */
  startDelayMs?: number
  /** Pause on the finished transcript before looping. */
  loopPauseMs?: number
  signal?: AbortSignal
}

const DEFAULT_CHARS_PER_SECOND = 28
const DEFAULT_START_DELAY_MS = 1_200
/** Long enough that the loop mostly shows a finished answer, not a restart. */
const DEFAULT_LOOP_PAUSE_MS = 20_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll for an element, resolving `null` if it never turns up. */
async function waitForElement<T extends Element>(
  root: ParentNode,
  selector: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted === true) return null
    const found = root.querySelector<T>(selector)
    if (found) return found
    if (Date.now() > deadline) return null
    await sleep(POLL_MS)
  }
}

/** Poll a predicate, resolving `false` on timeout or abort. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted === true) return false
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await sleep(POLL_MS)
  }
}

/** Put the caret at the end of the composer so typing looks like typing. */
function caretToEnd(el: HTMLElement): void {
  const selection = el.ownerDocument.defaultView?.getSelection()
  if (!selection) return
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

/**
 * Type into the composer's contenteditable. The editor derives its value from
 * the DOM on `input`, so growing the text node and firing `input` is exactly
 * what a keypress does to it — the send button enables, the draft autosaves,
 * and the context estimate recomputes as they would for a person.
 */
export async function typeIntoComposer(
  composer: HTMLElement,
  text: string,
  options: { charsPerSecond?: number; instant?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const { charsPerSecond = DEFAULT_CHARS_PER_SECOND, instant = false, signal } = options
  const emitInput = (): void => {
    composer.dispatchEvent(new Event('input', { bubbles: true }))
  }
  composer.focus()
  composer.textContent = ''
  emitInput()
  if (instant) {
    composer.textContent = text
    caretToEnd(composer)
    emitInput()
    return
  }
  const delay = 1000 / charsPerSecond
  // Grapheme clusters, so an emoji or combining mark arrives as one keystroke
  // rather than as visibly broken halves.
  const characters = [...new Intl.Segmenter().segment(text)].map((entry) => entry.segment)
  let typed = ''
  for (const [index, character] of characters.entries()) {
    if (signal?.aborted === true) return
    typed += character
    composer.textContent = typed
    caretToEnd(composer)
    emitInput()
    // A touch of jitter: metronome-even typing reads as a machine.
    await sleep(delay * (character === ' ' ? 1.6 : 0.75 + (index % 5) / 8))
  }
}

/** Type the prompt, send it, and resolve when the run finishes. */
async function playOnce(doc: Document, options: AutoplayOptions): Promise<boolean> {
  const composer = await waitForElement<HTMLElement>(
    doc,
    COMPOSER_SELECTOR,
    MOUNT_TIMEOUT_MS,
    options.signal,
  )
  const submit = doc.querySelector<HTMLButtonElement>(SUBMIT_SELECTOR)
  if (!composer || !submit) return false

  await typeIntoComposer(composer, options.prompt, {
    ...(options.charsPerSecond === undefined ? {} : { charsPerSecond: options.charsPerSecond }),
    ...(options.instant === undefined ? {} : { instant: options.instant }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (options.signal?.aborted === true) return false
  await sleep(options.instant === true ? 0 : 320)
  submit.click()

  // The run is over when the Send button stops offering to stop it. Waiting for
  // it to *start* first avoids reading the pre-submit state as "already done".
  await waitUntil(() => submit.classList.contains(RUNNING_CLASS), 5_000, options.signal)
  return waitUntil(() => !submit.classList.contains(RUNNING_CLASS), RUN_TIMEOUT_MS, options.signal)
}

/**
 * Run the walkthrough once, then — when looping — leave the finished transcript
 * up for a while and reload to start over.
 *
 * Reloading rather than opening a fresh thread is deliberate: every cycle then
 * starts from byte-identical state. Looping through the app's own "new thread"
 * button instead leaves the previous run in the sidebar, so an unattended hero
 * slowly fills with identically-titled threads.
 */
export async function startAutoplay(doc: Document, options: AutoplayOptions): Promise<void> {
  const { signal } = options
  // A function, not a narrowed read: the flag flips while we are awaiting, and
  // the compiler otherwise assumes the check above still holds.
  const aborted = (): boolean => signal?.aborted === true
  if (!options.instant) await sleep(options.startDelayMs ?? DEFAULT_START_DELAY_MS)
  const completed = await playOnce(doc, options)
  if (options.loop !== true || !completed || aborted()) return
  await sleep(options.loopPauseMs ?? DEFAULT_LOOP_PAUSE_MS)
  if (aborted()) return
  doc.defaultView?.location.reload()
}
