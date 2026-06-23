import { JSDOM } from 'jsdom'

// jsdom-backed DOM globals for tests that exercise the markdown sanitizer.
// DOMPurify relies on a spec-complete DOM (HTML parsing + serialization); the
// lighter happy-dom used by `setup-dom.ts` mis-parses sanitized output, so any
// test that runs `sanitizeRenderedMarkdown` must use this setup instead. Node's
// test runner isolates each file in its own process, so this does not affect
// the happy-dom globals used elsewhere.
const win = new JSDOM('').window
;(globalThis as any).document = win.document
;(globalThis as any).window = win
;(globalThis as any).customElements = win.customElements
;(globalThis as any).Event = win.Event
;(globalThis as any).CustomEvent = win.CustomEvent
;(globalThis as any).Element = win.Element
;(globalThis as any).Node = win.Node
