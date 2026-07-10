import { Window } from 'happy-dom'
import { setSanitizerBackend } from '@copse/streaming-markdown'
import { installAppLinkDecorator } from '../src/renderer/markdown/link-decorator.ts'

// happy-dom has no native Sanitizer API, so @copse/streaming-markdown's default
// backend would throw. Unit tests assert on the DOM structure of the renderer's
// (already-escaped, trusted) output, not on sanitizer security — that is covered
// by the package's own suite and by e2e in real Chromium — so a pass-through
// backend is sufficient here and avoids pulling DOMPurify's window-dependent
// module into the bundled test environment before this DOM is installed.
setSanitizerBackend({ sanitize: (html) => html })

// streaming-markdown 0.10.0 defaults to a neutral link decorator (#112). The app
// opts into the workspace/browser `data-*` link hooks at boot; mirror that here so
// unit tests see the same decorated anchors the renderer emits in production.
installAppLinkDecorator()

const win = new Window()
Object.assign(globalThis, {
  document: win.document,
  window: win,
  customElements: win.customElements,
  // Expose happy-dom's Event constructors as globals. happy-dom 20 strictly
  // rejects events in dispatchEvent() that aren't instances of its own Event
  // class, so `new Event()` must resolve to happy-dom's rather than Node's
  // built-in global Event.
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  ErrorEvent: win.ErrorEvent,
  Element: win.Element,
  // Node carries the nodeType constants (Node.TEXT_NODE, …) that DOM-walking
  // renderer code (e.g. the composer editor's serializer) compares against.
  Node: win.Node,
  // requestAnimationFrame is a standard part of a browser DOM environment that
  // happy-dom doesn't surface as a bare global. Real renderer views call it (e.g.
  // the conversation list's scroll-pin reset), so component tests that mount those
  // views need it defined. A synchronous shim is enough — the callbacks here only
  // flip flags; no view recurses inside rAF.
  requestAnimationFrame: (cb: (t: number) => void): number => {
    cb(0)
    return 0
  },
  cancelAnimationFrame: (): void => {},
})
