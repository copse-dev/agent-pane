// Strip ANSI/VT control sequences from text. Anchored on ESC (\x1b) so literal
// `[..m`-style text that isn't a real escape sequence survives untouched.
//
// Shared between the main-process subprocess output cap and the renderer's
// "Agent tasks" view so the two can't drift. Pure string work — no Node deps —
// so it's safe to pull into the renderer bundle.
const ANSI_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_RE, '')
}
