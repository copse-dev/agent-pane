import { session } from 'electron'
import type { WebContents } from 'electron'
import { BROWSER_SESSION_PARTITION } from '@shared/browser-session.ts'

let browserSession: Electron.Session | undefined

function getBrowserSession(): Electron.Session {
  browserSession ??= session.fromPartition(BROWSER_SESSION_PARTITION)
  return browserSession
}

/** True for in-sidebar browser guest pages that must load external https URLs. */
export function isBrowserWebContents(contents: WebContents): boolean {
  return contents.session === getBrowserSession()
}
