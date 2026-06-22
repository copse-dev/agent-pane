import type { WebContents } from 'electron'
import { shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const lockedDown = new WeakSet<WebContents>()

function rendererRootDir(): string {
  return join(__dirname, '../renderer')
}

/** http(s) links clicked in the renderer should open in the system browser. */
export function isExternalHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/** Allow only file:// URLs under the packaged renderer directory (plus about:blank). */
export function isAllowedRendererNavigation(url: string): boolean {
  if (url === 'about:blank') return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'file:') return false
  const target = fileURLToPath(parsed)
  const root = rendererRootDir()
  return target === root || target.startsWith(`${root}/`)
}

export function attachWebContentsLockdown(contents: WebContents): void {
  if (lockedDown.has(contents)) return
  lockedDown.add(contents)

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  const blockIfDisallowed = (event: Electron.Event, url: string) => {
    if (!isAllowedRendererNavigation(url)) {
      event.preventDefault()
      if (isExternalHttpUrl(url)) void shell.openExternal(url)
    }
  }

  contents.on('will-navigate', blockIfDisallowed)
  contents.on('will-redirect', blockIfDisallowed)
}
