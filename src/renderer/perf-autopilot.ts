/**
 * Scripted chat turn for the Electron-vs-Servo comparison (DEBUG BRANCH,
 * `COPSE_PERF=1` + `COPSE_PERF_AUTOPILOT=1`).
 *
 * The comparison had a hole: every measured number stopped at boot, because
 * nothing could drive a real interaction on both stacks. WebdriverIO drives the
 * Electron shell and there is no equivalent for a Servo webview — so external
 * automation can never be symmetric here.
 *
 * The way out is to stop driving from outside. This module lives *in the
 * renderer*, which is the one layer both stacks share verbatim, and drives the
 * real composer: it writes into the `contenteditable` and clicks the real Send
 * button rather than calling a controller directly. That matters — the
 * contenteditable path is a known Servo gap (patch 0002), so a shortcut around
 * the DOM would measure everything except the interesting part.
 *
 * What it times, and why these and not the obvious one:
 *
 * - `autopilot:ttft` / `autopilot:ttfr` — send to first content/reasoning token.
 *   Dominated by the model and the network, so it is reported for context and
 *   must never be read as a stack difference.
 * - `autopilot:paint` — a token arriving to the next frame committing. This is
 *   the engine's cost per streamed update and is independent of how fast the
 *   model produces tokens, which makes it the metric that actually compares the
 *   two renderers under streaming load.
 * - `autopilot:stream` — first token to `message_done`, with token and character
 *   counts, so throughput can be normalised against how much text arrived.
 *
 * The prompt is a fixed constant rather than configuration: a comparison whose
 * input changes between runs is not a comparison, and threading a prompt through
 * two different flag-delivery channels would buy nothing.
 */

import type { AppStore } from '@shared/store/store.ts'
import { autopilotOn, mark, begin } from './perf.ts'

/**
 * Deliberately dull and deterministic: long enough to stream a few hundred
 * tokens, specific enough that a model cannot answer it in three words, and
 * free of anything that would make a run depend on tools, files or the network
 * beyond the model call itself.
 */
const PROMPT =
  'Explain, in about 300 words, why a process tree can report more resident memory than the machine actually has allocated to it. Plain prose, no lists, no code.'

/** The app is booted but the composer mounts a frame or two later. */
const MOUNT_TIMEOUT_MS = 30_000
/**
 * A model that has produced nothing *at all* by now — no content, no reasoning
 * — is a broken key or an unroutable model, and should fail fast rather than
 * burn the full turn budget looking like a slow engine.
 *
 * Watches for any activity, not for content specifically: a reasoning model can
 * think for minutes before its first content token (one run here reasoned for
 * 114 s), and an earlier content-only guard scored that as a stack failure when
 * the stack was working perfectly.
 */
const FIRST_ACTIVITY_TIMEOUT_MS = 120_000
/** Cap on the whole turn, so a stuck stream cannot hang the harness. */
const TURN_TIMEOUT_MS = 300_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForComposer(): Promise<{
  input: HTMLElement
  submit: HTMLButtonElement
} | null> {
  const deadline = Date.now() + MOUNT_TIMEOUT_MS
  for (;;) {
    const input = document.querySelector<HTMLElement>('.prompt-input')
    const submit = document.querySelector<HTMLButtonElement>('button.submit-btn')
    // `disabled` covers the window between mount and the thread being ready to
    // accept a message; sending into that window is silently dropped.
    if (input && submit && !submit.disabled) return { input, submit }
    if (Date.now() > deadline) return null
    await sleep(50)
  }
}

/**
 * Time from now until the frame after next commits.
 *
 * One `requestAnimationFrame` only proves the *next* frame was scheduled; the
 * work queued inside it has not run yet. Resolving on the second frame means
 * the first frame's layout, paint and commit are behind us, which is the number
 * worth attributing to the engine.
 */
function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve()
      })
    })
  })
}

/**
 * Median interval between animation frames while the app is idle.
 *
 * The control for `autopilot:paint`. That metric resolves on the second frame
 * after a token, so its floor is two frame intervals — and if the two engines
 * do not tick at the same rate, comparing the two paint figures compares
 * scheduling cadence rather than the cost of rendering anything. A renderer
 * that is not vsync-locked will look dramatically "faster" for no user-visible
 * benefit. Without this number beside it, the paint row is uninterpretable.
 */
async function measureFrameInterval(samples: number): Promise<number | null> {
  const stamps: number[] = []
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      stamps.push(performance.now())
      if (stamps.length > samples) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const gaps: number[] = []
  for (let i = 1; i < stamps.length; i++) {
    gaps.push((stamps[i] ?? 0) - (stamps[i - 1] ?? 0))
  }
  if (gaps.length === 0) return null
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] ?? null
}

/**
 * Does this engine actually run CSS animations?
 *
 * Nothing else here would notice if it did not. Every timing measures data
 * arriving or frames scheduling; a spinner that renders but never turns is
 * invisible to all of it, and invisible to a single screenshot too — you need
 * two samples to tell a still frame from a stopped one.
 *
 * Uses the app's own spinner keyframes (`ui-inline-status-spin`, icons.css) so
 * this is the real rule the UI depends on rather than a synthetic one, and
 * samples the computed transform twice. An engine running the animation reports
 * a different matrix each time; one that parsed the rule and ignored it reports
 * the same value forever.
 */
async function probeCssAnimation(): Promise<{
  ran: boolean
  first: string
  second: string
  documentAnimations: number
  elementAnimations: number
}> {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:absolute;width:10px;height:10px;opacity:0;pointer-events:none;' +
    'animation:ui-inline-status-spin 0.9s linear infinite'
  document.body.append(probe)
  await afterNextFrame()
  const first = getComputedStyle(probe).transform

  // Is the animation actually *registered*, or is stylo just computing a value
  // from the timeline whenever something forces a restyle?
  //
  // This distinction is the whole diagnosis. Servo advances the computed
  // transform when asked, yet paints nothing — which is exactly what a missing
  // script-side registration looks like: `mark_animating_nodes_as_dirty`
  // iterates the registered set, so an empty set means no node is ever dirtied
  // spontaneously, no restyle is scheduled, no display list is rebuilt, and the
  // spinner freezes. Meanwhile `getComputedStyle` forces a restyle and stylo
  // resolves the current value correctly, which makes the animation look alive
  // to any probe that asks it directly.
  const registered = typeof document.getAnimations === 'function'
  const documentAnimations = registered ? document.getAnimations().length : -1
  const elementAnimations =
    registered && typeof probe.getAnimations === 'function' ? probe.getAnimations().length : -1

  await sleep(300)
  await afterNextFrame()
  const second = getComputedStyle(probe).transform
  probe.remove()
  return { ran: first !== second, first, second, documentAnimations, elementAnimations }
}

/**
 * Where does the caret's geometry actually go wrong?
 *
 * `getComputedStyle(el, '::before')` said `0px × 0px` under Servo while the
 * painted arrow was ~2.5× too tall, which looked like a pure paint bug. But
 * resolved values for pseudo-elements are commonly the *computed* value rather
 * than the *used* one, so that reading proves nothing about layout. These two
 * probes use real elements, whose `getBoundingClientRect` is unambiguous:
 *
 * - `grid`: the app's construction — a `display:grid; place-items:center`
 *   parent (`.message-reasoning-icon`) around a zero-sized bordered child.
 * - `bare`: the same child with no grid parent.
 *
 * If `bare` is 8px on both engines and `grid` is 8px on Chromium but taller on
 * Servo, the fault is grid stretch defeating `place-items: center` on a
 * zero-sized item — a layout bug — and not border painting at all.
 */
function probeBorderTriangle(): {
  grid: number
  bare: number
  pseudo: number
  pseudoGrid: number
  pseudoGridBlock: number
} {
  const child = (): HTMLElement => {
    const box = document.createElement('i')
    box.style.cssText =
      'display:block;width:0;height:0;border-left:5px solid currentColor;' +
      'border-top:4px solid transparent;border-bottom:4px solid transparent'
    return box
  }
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;top:-9999px;left:0;font-size:16px'

  const grid = document.createElement('div')
  grid.style.cssText = 'display:grid;place-items:center;width:16px;height:16px'
  const gridChild = child()
  grid.append(gridChild)

  const bareChild = child()

  // The one variable the two cases above do not cover: the app's triangle is a
  // `::before`, not a real element, and `content: ''` boxes go down a different
  // path in some engines. Measured through an auto-sized parent, because a
  // pseudo-element has no node to call `getBoundingClientRect` on.
  const sheet = document.createElement('style')
  sheet.textContent =
    '.copse-perf-pseudo{display:flex;align-items:flex-start;width:max-content}' +
    '.copse-perf-pseudo::before{content:"";width:0;height:0;' +
    'border-left:5px solid currentColor;border-top:4px solid transparent;' +
    'border-bottom:4px solid transparent}' +
    // The app's actual combination — a `::before` inside a *grid* container —
    // which neither case above covers: `grid` uses a real child and `pseudo`
    // uses a flex parent. Sized to `max-content` so the parent reports the
    // child's height, which is otherwise unmeasurable for a pseudo-element.
    '.copse-perf-pseudo-grid{display:grid;place-items:center;' +
    'width:max-content;height:max-content}' +
    '.copse-perf-pseudo-grid::before{content:"";width:0;height:0;' +
    'border-left:5px solid currentColor;border-top:4px solid transparent;' +
    'border-bottom:4px solid transparent}' +
    // Same again but with the blockification stated explicitly. If this reads 8
    // where the case above reads 19, the fault is exactly that Servo leaves the
    // pseudo-element `display:inline` instead of blockifying it into a grid
    // item — and `display:block` in app CSS is a correct, engine-neutral fix
    // (grid items are blockified anyway, so it is a no-op under Chromium).
    '.copse-perf-pseudo-grid-block{display:grid;place-items:center;' +
    'width:max-content;height:max-content}' +
    '.copse-perf-pseudo-grid-block::before{content:"";display:block;' +
    'width:0;height:0;border-left:5px solid currentColor;' +
    'border-top:4px solid transparent;border-bottom:4px solid transparent}'
  const pseudoHost = document.createElement('span')
  pseudoHost.className = 'copse-perf-pseudo'
  const pseudoGridHost = document.createElement('span')
  pseudoGridHost.className = 'copse-perf-pseudo-grid'
  const pseudoGridBlockHost = document.createElement('span')
  pseudoGridBlockHost.className = 'copse-perf-pseudo-grid-block'

  host.append(grid, bareChild, sheet, pseudoHost, pseudoGridHost, pseudoGridBlockHost)
  document.body.append(host)
  const measured = {
    grid: Math.round(gridChild.getBoundingClientRect().height * 100) / 100,
    bare: Math.round(bareChild.getBoundingClientRect().height * 100) / 100,
    pseudo: Math.round(pseudoHost.getBoundingClientRect().height * 100) / 100,
    pseudoGrid: Math.round(pseudoGridHost.getBoundingClientRect().height * 100) / 100,
    pseudoGridBlock: Math.round(pseudoGridBlockHost.getBoundingClientRect().height * 100) / 100,
  }
  host.remove()
  return measured
}

/**
 * Popover support, which the migration plan calls the top engine risk: the app
 * has ~164 references across menus, tooltips and pickers.
 *
 * Two separate questions, and the second matters more than the first. Whether
 * `showPopover()` exists is easy to feature-detect and easy to fall back from.
 * Whether un-upgraded `[popover]` content is hidden by the UA stylesheet is the
 * dangerous one: if it is not, every popover in the app renders inline, and
 * hidden menu content leaks into the layout rather than simply failing to open.
 */
function probePopover(): Record<string, string | boolean | number> {
  const el = document.createElement('div')
  el.setAttribute('popover', 'auto')
  el.textContent = 'popover probe content'
  const host = document.createElement('div')
  host.style.cssText = 'position:absolute;top:-9999px;left:0;width:200px'
  host.append(el)
  document.body.append(host)

  const displayBefore = getComputedStyle(el).display
  const leakedHeight = Math.round(el.getBoundingClientRect().height)

  let showResult = 'not attempted'
  let displayAfter = 'n/a'
  const show = Reflect.get(el, 'showPopover')
  if (typeof show === 'function') {
    try {
      Reflect.apply(show, el, [])
      showResult = 'ok'
      displayAfter = getComputedStyle(el).display
    } catch (error) {
      showResult = String(error)
    }
  }
  const result = {
    showPopover: typeof show,
    togglePopover: typeof Reflect.get(el, 'togglePopover'),
    // 'none' is correct: the UA stylesheet hides un-opened popovers.
    displayBefore,
    // Non-zero here means hidden content is occupying layout — the bad case.
    leakedHeight,
    showResult,
    displayAfter,
    supportsSelector: CSS.supports('selector(:popover-open)'),
  }
  host.remove()
  return result
}

/**
 * Behavioural check of the remaining risk-register entries.
 *
 * Deliberately does not trust `CSS.supports`: it reports `true` for
 * `selector(:popover-open)` under Servo while the Popover API is absent, so a
 * support string proves nothing. Each entry here either calls the API and
 * observes the result, or applies a rule and reads back a computed value.
 */
function probeCapabilities(): Record<string, string | boolean | number> {
  const out: Record<string, string | boolean | number> = {}

  // <dialog>.showModal — 14 real calls in the app.
  const dialog = document.createElement('dialog')
  dialog.textContent = 'probe'
  document.body.append(dialog)
  const showModal = Reflect.get(dialog, 'showModal')
  out['showModal'] = typeof showModal
  if (typeof showModal === 'function') {
    try {
      Reflect.apply(showModal, dialog, [])
      out['dialogOpens'] = dialog.hasAttribute('open')
      out['dialogDisplay'] = getComputedStyle(dialog).display
    } catch (error) {
      out['dialogOpens'] = `threw: ${String(error)}`
    }
  }
  dialog.remove()

  // :has() — 26 stylesheet rules. Behavioural: does the parent restyle?
  const sheet = document.createElement('style')
  sheet.textContent =
    '.probe-has{color:rgb(1,2,3)}.probe-has:has(.probe-child){color:rgb(9,8,7)}' +
    '.probe-anchor{anchor-name:--probe}'
  const hasParent = document.createElement('div')
  hasParent.className = 'probe-has'
  const hasChild = document.createElement('span')
  hasChild.className = 'probe-child'
  hasParent.append(hasChild)
  const holder = document.createElement('div')
  holder.style.cssText = 'position:absolute;top:-9999px'
  holder.append(sheet, hasParent)
  document.body.append(holder)
  out['hasSelectorWorks'] = getComputedStyle(hasParent).color === 'rgb(9, 8, 7)'

  // CSS anchor positioning — 20 declarations, with a documented JS fallback.
  const anchorEl = document.createElement('div')
  anchorEl.className = 'probe-anchor'
  holder.append(anchorEl)
  out['anchorNameApplied'] = getComputedStyle(anchorEl).getPropertyValue('anchor-name') || 'unset'
  holder.remove()

  // CSS.highlights — 7 uses, find-in-chat.
  out['cssHighlights'] = typeof Reflect.get(CSS, 'highlights')
  out['HighlightCtor'] = typeof Reflect.get(globalThis, 'Highlight')

  // WebCodecs — video pane and VNC H.264.
  out['VideoDecoder'] = typeof Reflect.get(globalThis, 'VideoDecoder')

  return out
}

/** Write into the real contenteditable and let the composer's own listeners see it. */
function typeInto(input: HTMLElement, text: string): void {
  input.focus()
  input.textContent = text
  // The composer tracks its value from `input` events, not from the DOM, so a
  // bare textContent assignment leaves Send disabled and the draft empty.
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export function startPerfAutopilot(store: AppStore): void {
  if (!autopilotOn) return
  void run(store)
}

async function run(store: AppStore): Promise<void> {
  mark('autopilot:start')
  const composer = await waitForComposer()
  if (!composer) {
    mark('autopilot:failed', { reason: 'composer never became ready' })
    return
  }

  let tokens = 0
  let chars = 0
  let firstTokenSeen = false
  let paintSampling = false
  const paints: number[] = []
  // Hand-rolled deferred: the web tsconfig targets ES2022, which predates
  // `Promise.withResolvers`.
  let resolveDone: (outcome: 'done' | 'timeout') => void = () => undefined
  const donePromise = new Promise<'done' | 'timeout'>((resolve) => {
    resolveDone = resolve
  })

  const endTotal = begin('autopilot:total')
  const endFirstToken = begin('autopilot:ttft')
  const endFirstReasoning = begin('autopilot:ttfr')
  // A container, not a `let`: TypeScript's control-flow analysis does not track
  // assignments made inside a callback, so a plain binding narrows to `null` at
  // the use site below and `endStream?.()` becomes a call on `never`.
  const endStream: { close: ReturnType<typeof begin> | null } = { close: null }

  // A container for the same reason `endStream` is one: control-flow analysis
  // does not see assignments made inside store callbacks, so a plain `let`
  // narrows to `false` at the race below and the guard is compiled away.
  const activity = { any: false }
  const offReasoning = store.on('message_reasoning', () => {
    if (activity.any) return
    activity.any = true
    endFirstReasoning()
  })

  const offToken = store.on('message_token', (_messageId, text) => {
    chars += text.length
    tokens++
    if (!firstTokenSeen) {
      firstTokenSeen = true
      activity.any = true
      endFirstToken()
      endStream.close = begin('autopilot:stream')
    }
    // Sample paint cost rather than timing every token: at a few hundred tokens
    // the rAF pairs would themselves become load, and a sample of ~30 is ample
    // for a median. `paintSampling` also serialises them, so overlapping
    // measurements cannot inflate each other.
    if (paintSampling || tokens % 8 !== 0) return
    paintSampling = true
    const started = performance.now()
    void afterNextFrame().then(() => {
      paints.push(performance.now() - started)
      paintSampling = false
    })
  })

  const offDone = store.on('message_done', () => {
    resolveDone('done')
  })

  mark('autopilot:popover', probePopover())
  mark('autopilot:capabilities', probeCapabilities())

  const triangle = probeBorderTriangle()
  mark('autopilot:border-triangle', {
    grid: triangle.grid,
    bare: triangle.bare,
    pseudo: triangle.pseudo,
    pseudoGrid: triangle.pseudoGrid,
    pseudoGridBlock: triangle.pseudoGridBlock,
    expected: 8,
  })

  // Scale sanity. The painted caret is ~21 CSS px tall where its own parent is
  // `--font-size-lg` (16px × --ui-scale), so either a scale token resolves
  // differently here or the window's device pixel ratio is not what the layout
  // assumed. Both would show up far beyond the caret, so measure them.
  const rootStyle = getComputedStyle(document.documentElement)
  const iconHost = document.querySelector('.message-reasoning-icon')
  const iconRect = iconHost?.getBoundingClientRect()
  mark('autopilot:scale', {
    uiScale: rootStyle.getPropertyValue('--ui-scale').trim() || 'unset',
    fontSizeLg: rootStyle.getPropertyValue('--font-size-lg').trim() || 'unset',
    rootFontSize: rootStyle.fontSize,
    devicePixelRatio: window.devicePixelRatio,
    iconHostHeight: iconRect ? Math.round(iconRect.height * 100) / 100 : 'absent',
    iconHostWidth: iconRect ? Math.round(iconRect.width * 100) / 100 : 'absent',
  })

  const animation = await probeCssAnimation()
  mark('autopilot:css-animation', {
    ran: animation.ran,
    documentAnimations: animation.documentAnimations,
    elementAnimations: animation.elementAnimations,
    first: animation.first,
    second: animation.second,
  })

  const frameInterval = await measureFrameInterval(60)
  if (frameInterval !== null) {
    mark('autopilot:frame-interval', { medianMs: Math.round(frameInterval * 100) / 100 })
  }

  mark('autopilot:send')
  typeInto(composer.input, PROMPT)
  // A frame between typing and clicking, so the composer's input handler has
  // enabled Send before the click lands.
  await afterNextFrame()
  composer.submit.click()

  // Which animations are actually *applied* while the model is thinking?
  //
  // Servo registers zero animations during this phase, but that only matters if
  // the app is asking for one. Chromium is the control: if it lists a running
  // animation here and Servo lists the same one, Servo is failing to run an
  // applied animation; if Servo lists none, the app never applied it under this
  // engine and the bug is somewhere else entirely.
  void sleep(3000).then(() => {
    const running: string[] = []
    for (const element of document.querySelectorAll('*')) {
      const name = getComputedStyle(element).animationName
      if (name && name !== 'none') running.push(`${element.className || element.tagName}:${name}`)
    }
    mark('autopilot:running-animations', {
      count: running.length,
      // Bounded: a pathological page should not write an unbounded trace line.
      names: running.slice(0, 6).join(' | ') || 'none',
    })
  })

  // Split the remaining space on the frozen reasoning indicator: does its
  // animated property advance in style, or does style advance while paint
  // stays put? Sampling the same element twice is the only thing that
  // distinguishes "the animation never runs" from "it runs and never repaints".
  void sleep(3500).then(async () => {
    const path = document.querySelector<SVGElement>('.reasoning-activity-path')
    if (!path) {
      mark('autopilot:dashoffset', { found: false })
      return
    }
    const read = (): string => getComputedStyle(path).strokeDashoffset
    const first = read()
    await sleep(400)
    const second = read()
    mark('autopilot:dashoffset', {
      found: true,
      first,
      second,
      advanced: first !== second,
      opacity: getComputedStyle(path).opacity,
    })
  })

  const outcome = await Promise.race([
    donePromise,
    sleep(TURN_TIMEOUT_MS).then(() => 'timeout' as const),
    // A separate, shorter guard: nothing at all from the model means a broken
    // key or an unroutable model, and that should fail fast and loudly rather
    // than burn five minutes looking like a slow engine.
    sleep(FIRST_ACTIVITY_TIMEOUT_MS).then(() =>
      activity.any ? donePromise : ('timeout' as const),
    ),
  ])

  offToken()
  offReasoning()
  offDone()

  if (outcome === 'timeout') {
    mark('autopilot:failed', {
      reason: activity.any ? 'stream never completed' : 'model produced nothing',
      tokens,
      chars,
    })
    return
  }

  // Rendering check, not a data check.
  //
  // Every other signal here comes from the store, which fires when the *data*
  // arrives — it says nothing about whether the engine put pixels on screen.
  // Servo has real rendering gaps, so a run could stream 2000 characters into a
  // store and paint none of them, and every timing above would still look
  // healthy. This reads the text back out of the DOM and checks it is laid out
  // (`offsetHeight > 0`), which is the assertion that would actually catch it.
  await afterNextFrame()
  const rendered = document.querySelector<HTMLElement>('.msg-assistant .message-text')
  const renderedChars = rendered?.textContent.length ?? 0
  const laidOut = (rendered?.offsetHeight ?? 0) > 0
  // The reasoning disclosure's caret is a classic CSS border triangle: a
  // `width:0;height:0` pseudo-element whose left border is the arrow and whose
  // transparent top/bottom borders mitre it to a point. It only works if the
  // box really is zero-sized. Under Servo it renders as a tall stripe, so
  // measure the box rather than guess: a non-zero height here means the
  // pseudo-element was stretched by its `display:grid; place-items:center`
  // parent instead of being centred at its own (zero) size.
  const caretHost = document.querySelector('.message-reasoning-icon')
  const caret = caretHost ? getComputedStyle(caretHost, '::before') : null
  mark('autopilot:caret-box', {
    width: caret?.width ?? 'absent',
    height: caret?.height ?? 'absent',
    borderLeftWidth: caret?.borderLeftWidth ?? 'absent',
  })

  mark('autopilot:dom', {
    renderedChars,
    laidOut,
    storeChars: chars,
    // Reasoning text and markdown formatting mean the two counts never match
    // exactly; the point is that the DOM is not empty and is in the right order
    // of magnitude, not that it is character-identical to the raw stream.
    ratio: chars > 0 ? Math.round((renderedChars / chars) * 100) / 100 : 0,
  })
  if (renderedChars === 0 || !laidOut) {
    mark('autopilot:failed', {
      reason: 'stream completed but nothing rendered',
      tokens,
      chars,
      renderedChars,
      laidOut,
    })
    return
  }

  endStream.close?.({ tokens, chars })
  endTotal({ tokens, chars })
  if (paints.length > 0) {
    const sorted = [...paints].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0
    mark('autopilot:paint', {
      medianMs: Math.round(median * 100) / 100,
      samples: sorted.length,
      // Chunk sizes vary run to run, so the same answer can arrive as 100 fat
      // tokens or 200 thin ones. Carrying both makes that visible instead of
      // letting it masquerade as an engine difference.
      chars,
      tokens,
    })
  }
  mark('autopilot:done', { tokens, chars })
}
