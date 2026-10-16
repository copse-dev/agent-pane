declare global {
  interface Window {
    e2eCaptureTextPins?: Map<string, { observer: MutationObserver; pinned: Map<Text, string> }>
  }
}

// These functions are serialized by WebDriver: keep their runtime dependencies
// inside the function bodies. Each capture pin owns its observer and restore.
export function installCaptureTextPin(
  id: string,
  selector: string,
  source: string,
  flags: string,
  replacement: string,
): number {
  const re = new RegExp(source, flags)
  const pinned = new Map<Text, string>()
  const apply = (): number => {
    const host = document.querySelector(selector)
    if (!host) return 0
    let matched = 0
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text
      // search ignores lastIndex, so /g cannot skip a node. An already-fixed
      // value still counts as present, without chasing our own mutation.
      if (text.data.search(re) === -1) continue
      matched += 1
      const replaced = text.data.replace(re, replacement)
      if (replaced === text.data) continue
      // Remember the latest live value when the app updates an existing node.
      pinned.set(text, text.data)
      text.data = replaced
    }
    return matched
  }
  const count = apply()
  if (count === 0) return 0
  const observer = new MutationObserver(() => {
    observer.disconnect()
    apply()
    observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
  window.e2eCaptureTextPins ??= new Map()
  window.e2eCaptureTextPins.set(id, { observer, pinned })
  return count
}

export function restoreCaptureTextPin(id: string): void {
  const pin = window.e2eCaptureTextPins?.get(id)
  if (!pin) return
  pin.observer.disconnect()
  // Replaced nodes already show live text; only restore the connected originals.
  for (const [node, text] of pin.pinned) if (node.isConnected) node.data = text
  window.e2eCaptureTextPins?.delete(id)
  if (window.e2eCaptureTextPins?.size === 0) delete window.e2eCaptureTextPins
}
