import { JSDOM } from 'jsdom'

// jsdom-backed DOM globals for tests that exercise the markdown sanitizer.
// DOMPurify relies on a spec-complete DOM (HTML parsing + serialization); the
// lighter happy-dom used by `setup-dom.ts` mis-parses sanitized output, so any
// test that runs `sanitizeRenderedMarkdown` must use this setup instead. Node's
// test runner isolates each file in its own process, so this does not affect
// the happy-dom globals used elsewhere.
const win = new JSDOM('').window
Object.assign(globalThis, {
  document: win.document,
  window: win,
  customElements: win.customElements,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  Element: win.Element,
  HTMLElement: win.HTMLElement,
  Node: win.Node,
})
