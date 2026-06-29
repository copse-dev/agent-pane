export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue
    if (v === true) node.setAttribute(k, '')
    else node.setAttribute(k, v)
  }
  node.append(...children)
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.firstChild.remove()
}

export function on<K extends keyof HTMLElementEventMap>(
  target: EventTarget,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  target.addEventListener(event, handler as EventListener, opts)
  return () => {
    target.removeEventListener(event, handler as EventListener, opts)
  }
}
