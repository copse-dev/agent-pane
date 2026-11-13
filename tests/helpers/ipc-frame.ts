import { EventEmitter } from 'node:events'
import type { WebFrameMain } from 'electron'

/** Identity-only double; fail if a sender gate starts inspecting frame content. */
export function ipcFrame(parent: WebFrameMain | null = null): WebFrameMain {
  const unused = (): never => {
    throw new Error('sender checks must use identity only')
  }
  return new (class extends EventEmitter implements WebFrameMain {
    collectJavaScriptCallStack = unused
    copyVideoFrameAt = unused
    executeJavaScript = unused
    isDestroyed = (): boolean => false
    postMessage = unused
    printToPDF = unused
    reload = unused
    saveVideoFrameAs = unused
    send = unused
    detached = false
    frames: WebFrameMain[] = []
    framesInSubtree: WebFrameMain[] = []
    frameToken = ''
    frameTreeNodeId = 0
    get ipc(): never {
      return unused()
    }
    name = ''
    origin = 'null'
    osProcessId = 0
    parent = parent
    processId = 0
    routingId = 0
    top = parent
    url = 'file:///app/index.html'
    visibilityState = 'visible'
  })()
}
