import {
  renderMarkdown,
  StreamingMarkdownRenderer,
  type RenderMarkdownOptions,
} from '@copse/streaming-markdown'
import { createInputSmoother, type InputSmoother } from '@copse/streaming-markdown/smoothing'
import { attachCodeBlockCopyButtons } from './code-block-copy.ts'
import { renderMermaidIn } from './mermaid.ts'
import { attachTableCopyButtons } from './table-copy.ts'
import { fillUserPromptFold, splitUserPromptForFold } from '../views/user-prompt-fold.ts'

/**
 * Chat message rendering shared by every transcript: the main conversation, side
 * chats, and the mobile companion. A surface supplies only what it alone can do
 * (`decorate`, `runCommands`, `renderOptions`); everything else — code highlighting
 * and copy buttons, table copy, Mermaid frames, streamed pacing, prompt line breaks —
 * renders identically wherever a message is shown.
 */
export interface MessageMarkdownHost {
  /** Offer Run on runnable fenced shell blocks (the desktop transcript handles the request). */
  runCommands?: boolean
  /** Host-only passes over a settled render, such as workspace file links and artifact images. */
  decorate?: (el: HTMLElement) => void
  /** Per-surface render config, such as the mobile sanitizer and footnote ids. */
  renderOptions?: RenderMarkdownOptions
}

/** A paced frame of streamed text landed in a message element. Bubbles. */
export const STREAM_PAINT_EVENT = 'copse:stream-paint'
/** A paced stream finished revealing and took its final render. Bubbles. */
export const STREAM_SETTLED_EVENT = 'copse:stream-settled'

// Per-message incremental renderers for the active streaming pass. Keyed by the
// message element so re-entrant token events reuse the same DOM regions instead
// of rebuilding the whole message innerHTML each token (O(n²)).
const streamingRenderers = new WeakMap<HTMLElement, StreamingMarkdownRenderer>()
// Streamed text reaches the element through the package's input smoother, one
// frame at a time, so a transcript learns about each paint and the deferred final
// render through the events above rather than at the call site.
const streamSmoothers = new WeakMap<HTMLElement, InputSmoother>()

function paintStreamingMarkdown(el: HTMLElement, display: string, host: MessageMarkdownHost): void {
  let renderer = streamingRenderers.get(el)
  if (!renderer) {
    renderer = new StreamingMarkdownRenderer(el)
    streamingRenderers.set(el, renderer)
  }
  renderer.update(display)
  attachCodeBlockCopyButtons(el, { runCommands: host.runCommands === true })
}

function streamSmootherFor(
  el: HTMLElement,
  display: string,
  host: MessageMarkdownHost,
): InputSmoother {
  const existing = streamSmoothers.get(el)
  if (existing) return existing
  // Text already on screen — a message rebuilt mid-stream — stays put; only
  // what arrives from now on is paced. A fresh bubble paces from its start.
  const shown = el.hasChildNodes() ? display : ''
  if (shown) paintStreamingMarkdown(el, shown, host)
  const smoother = createInputSmoother({
    update: (text) => {
      paintStreamingMarkdown(el, text, host)
      el.dispatchEvent(new CustomEvent(STREAM_PAINT_EVENT, { bubbles: true }))
    },
    // Follow the provider's own rate: a steady reveal a little behind it.
    cadence: 'adaptive',
    initial: shown,
  })
  streamSmoothers.set(el, smoother)
  return smoother
}

/** Committed render: the finished markdown with every settled-message enhancement. */
export function renderSettledMessageMarkdown(
  el: HTMLElement,
  markdown: string,
  host: MessageMarkdownHost = {},
): void {
  el.classList.remove('is-streaming')
  streamingRenderers.delete(el)
  el.innerHTML = renderMarkdown(markdown, host.renderOptions)
  attachCodeBlockCopyButtons(el, { runCommands: host.runCommands === true })
  // Tables only on the committed final render — during streaming they are
  // patched with pending rows, so wrapping them then would fight the DOM sync.
  attachTableCopyButtons(el)
  host.decorate?.(el)
  void renderMermaidIn(el)
}

/**
 * Paint an assistant message. While `streaming`, text is paced through the
 * incremental renderer; once it stops, the reveal catches up and the element
 * takes {@link renderSettledMessageMarkdown}. `onSettled` runs after a paced
 * stream's final render (not after a direct settled render).
 */
export function paintAssistantMarkdown(
  el: HTMLElement,
  display: string,
  streaming: boolean,
  host: MessageMarkdownHost = {},
  onSettled?: () => void,
): void {
  if (streaming) {
    el.classList.add('is-streaming')
    streamSmootherFor(el, display, host).push(display)
    return
  }
  const smoother = streamSmoothers.get(el)
  if (smoother) {
    // Let the reveal catch up before the final render replaces the scaffold,
    // so the end of the answer doesn't arrive in one pop. A later call pushes
    // again, which voids this settle in favour of its own content.
    smoother.push(display)
    smoother.finish(() => {
      smoother.dispose()
      streamSmoothers.delete(el)
      renderSettledMessageMarkdown(el, display, host)
      onSettled?.()
      el.dispatchEvent(new CustomEvent(STREAM_SETTLED_EVENT, { bubbles: true }))
    })
    return
  }
  renderSettledMessageMarkdown(el, display, host)
}

/** Turn composer single newlines into CommonMark hard breaks; skip fenced code. */
export function userPromptMarkdown(source: string): string {
  const parts: string[] = []
  const fenceRe = /```[\s\S]*?```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(source)) !== null) {
    parts.push(hardBreakSingleNewlines(source.slice(last, match.index)))
    parts.push(match[0])
    last = match.index + match[0].length
  }
  parts.push(hardBreakSingleNewlines(source.slice(last)))
  return parts.join('')
}

function hardBreakSingleNewlines(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, '  \n')
}

/** Render a user prompt (or one fold region of it) as markdown. */
export function paintUserMarkdown(
  el: HTMLElement,
  content: string,
  renderOptions?: RenderMarkdownOptions,
): void {
  if (!content) {
    el.replaceChildren()
    return
  }
  // escape-all: angle-bracketed examples (`<cd … && npm test>`) must stay literal.
  // Default passthrough emits raw tags; the sink sanitizer then strips unknown
  // elements and the command vanishes from the transcript.
  el.innerHTML = renderMarkdown(userPromptMarkdown(content), {
    ...renderOptions,
    htmlPolicy: 'escape-all',
  })
  attachCodeBlockCopyButtons(el)
}

/**
 * Settled user prompt: markdown like assistant replies. Long prompts get a
 * mid-fold accordion — opening and closing stay visible; the middle collapses.
 */
export function renderUserPromptMarkdown(el: HTMLElement, content: string): void {
  const parts = splitUserPromptForFold(content)
  if (!parts) {
    paintUserMarkdown(el, content)
    return
  }
  fillUserPromptFold(el, parts, (region, text) => {
    paintUserMarkdown(region, text)
  })
}
