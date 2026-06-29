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

/**
 * Typed `querySelector` returning `E | null`. Prefer this over
 * `root.querySelector(sel) as E`: the generic types the result without an
 * unchecked assertion and keeps the honest `| null`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the generic return type lets call sites request the concrete element type, mirroring lib's querySelector<E>
export function qs<E extends Element = HTMLElement>(root: ParentNode, selector: string): E | null {
  return root.querySelector<E>(selector)
}

/**
 * Like {@link qs} but throws when nothing matches. Use for an element the caller
 * just rendered and treats as guaranteed present — a clear error beats the silent
 * non-null lie of `querySelector(sel) as E`, which only NPEs at first use.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the generic return type lets call sites request the concrete element type, mirroring lib's querySelector<E>
export function qsRequired<E extends Element = HTMLElement>(root: ParentNode, selector: string): E {
  const found = root.querySelector<E>(selector)
  if (!found) throw new Error(`qsRequired: no element matches ${JSON.stringify(selector)}`)
  return found
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
