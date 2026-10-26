/** Builds an element: attributes by `setAttribute` (`true` → present with no
 * value, `false`/`undefined` → omitted), then appends `children` once. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === undefined) continue;
    node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children);
  return node;
}

/** Removes every child of `node`. */
export function clear(node: Element): void {
  node.replaceChildren();
}

/** Adds a listener, returning the matching `removeEventListener` call. */
export function on<K extends keyof WindowEventMap>(
  target: EventTarget,
  event: K,
  handler: (ev: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): () => void {
  target.addEventListener(event, handler as EventListener, opts);
  return () => {
    target.removeEventListener(event, handler as EventListener, opts);
  };
}
