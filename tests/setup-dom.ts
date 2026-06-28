import { Window } from 'happy-dom'
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
