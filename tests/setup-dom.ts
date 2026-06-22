import { Window } from 'happy-dom'
const win = new Window()
;(globalThis as any).document = win.document
;(globalThis as any).window = win
;(globalThis as any).customElements = win.customElements
// Expose happy-dom's Event constructors as globals. happy-dom 20 strictly
// rejects events in dispatchEvent() that aren't instances of its own Event
// class, so `new Event()` must resolve to happy-dom's rather than Node's
// built-in global Event.
;(globalThis as any).Event = win.Event
;(globalThis as any).CustomEvent = win.CustomEvent
