import type { ILinkHandler } from '@xterm/xterm'
import type { ApiClient } from '../../preload/api.d.ts'
import { showConfirmDialog } from './confirm-dialog.ts'

/**
 * OSC 8 hyperlink handler for the terminal pane (e.g. an auth URL a CLI prints
 * as a clickable link). xterm's default handler opens a blank `window.open()`
 * and only assigns the real URL to it afterwards; Electron's popup handler
 * denies that blank-URL request before it ever sees the real target, so the
 * link silently does nothing. Confirm in-app, then hand the URL straight to
 * the app's own external-open path instead of routing through `window.open`.
 */
export function createTerminalWebLinkHandler(
  shell: Pick<ApiClient['shell'], 'openExternal'>,
  confirmOpen: (uri: string) => Promise<boolean> = (uri) =>
    showConfirmDialog({
      message: 'Open this link in your browser?',
      detail: uri,
      confirmLabel: 'Open',
    }),
): ILinkHandler {
  return {
    activate: (_event, uri): void => {
      void confirmOpen(uri).then((confirmed) => {
        if (confirmed) void shell.openExternal(uri)
      })
    },
  }
}
