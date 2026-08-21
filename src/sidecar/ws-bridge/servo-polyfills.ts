/**
 * Small polyfills for web APIs Servo lacks at the pinned revision, loaded by
 * the ws-bridge bundle before app.js. Each entry names its upstream gap;
 * delete entries as Servo grows the API.
 */

// crypto.randomUUID (Servo has getRandomValues but not randomUUID). The
// renderer mints project/thread/message ids with it, and the unhandled
// rejection from its absence killed thread-list restore on first run.
if (typeof crypto.randomUUID !== 'function') {
  const randomUUID = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const six = bytes[6]
    const eight = bytes[8]
    if (six !== undefined) bytes[6] = (six & 0x0f) | 0x40
    if (eight !== undefined) bytes[8] = (eight & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  Reflect.set(crypto, 'randomUUID', randomUUID)
}

export {}
