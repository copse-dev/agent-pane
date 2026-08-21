/**
 * Small polyfills for web APIs Servo lacks at the pinned revision, loaded by
 * the ws-bridge bundle before app.js. Each entry names its upstream gap;
 * delete entries as Servo grows the API.
 */

// crypto.randomUUID — implemented in Servo (servo/servo#33158) but gated
// [SecureContext], and a tauri:// page never qualifies: non-special schemes
// get opaque origins, which are never potentially-trustworthy, and script's
// GlobalScope::is_secure_context() ignores the ProtocolHandler::is_secure()
// registration that the runtime already makes (net's fetch path honors it —
// script's does not). Same root cause as CSP 'self' never matching. Until
// upstream threads the registry into script, SecureContext-gated APIs
// (crypto.subtle included) are absent here; this shims the one the renderer
// needs at boot (project/thread/message ids).
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

// document.queryCommandSupported and the rest of the legacy editing API —
// implemented in Servo but pref-gated (`dom_exec_command_enabled`, default
// off). monaco-editor's clipboard contrib probes it at module-init, and the
// missing function kills the whole monaco bundle (no diff or file views).
// The shell enables the pref (tauri-runtime-servo sets it at Servo startup);
// this shim keeps the bundle alive on runtimes that don't. Returning false
// is a spec-permitted answer for any command.
// The API is deprecated (hence the indirection instead of typed member
// access — the lint ban on deprecated APIs is the point of this shim).
const legacyEditingProbe = (name: string): boolean =>
  typeof Reflect.get(document, name) === 'function'
if (!legacyEditingProbe('queryCommandSupported')) {
  Reflect.set(document, 'queryCommandSupported', () => false)
}
if (!legacyEditingProbe('queryCommandEnabled')) {
  Reflect.set(document, 'queryCommandEnabled', () => false)
}

export {}
