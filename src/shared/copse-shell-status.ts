import { COPSE_SHELL_ORIGIN } from './mobile-asset-routes.ts'

/**
 * The one message the copse.me shell accepts from a framed Mac
 * (copse-web-access plan, decision 9; `shell/public/lib/status.js` in
 * copse-dev/remote-service): a state and two counts, never transcripts, diffs,
 * thread names or file names. The shell also reads its arrival as proof that
 * the frame really reached this Mac.
 */
export interface ShellStatusMessage {
  type: 'copse-status'
  v: 1
  state: 'idle' | 'working' | 'needs-attention'
  counts: { attention: number; running: number }
}

const DEVICE_HOSTNAME = /^(?:lan|web)\.[a-z2-7]{12}\.u\.copse\.me$/
/** The shell refuses larger counts. */
const MAX_COUNT = 999

/**
 * Where to report status: the shell's origin when this page is the Mac's
 * interface under one of its trusted names and something frames it, else
 * `null`. `frame-ancestors` lets nothing but the shell frame a trusted name,
 * and `postMessage` to the shell's exact origin reaches no other parent.
 */
export function shellStatusTarget(hostname: string, framed: boolean): string | null {
  return framed && DEVICE_HOSTNAME.test(hostname) ? COPSE_SHELL_ORIGIN : null
}

export function shellStatus(rows: readonly { group: string; state: string }[]): ShellStatusMessage {
  const attention = Math.min(MAX_COUNT, rows.filter((row) => row.group === 'needs-you').length)
  const running = Math.min(MAX_COUNT, rows.filter((row) => row.state === 'working').length)
  return {
    type: 'copse-status',
    v: 1,
    state: attention > 0 ? 'needs-attention' : running > 0 ? 'working' : 'idle',
    counts: { attention, running },
  }
}
