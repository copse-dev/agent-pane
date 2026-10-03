/**
 * Make `parent`'s element children exactly `desired`, in order, touching the DOM
 * only where it differs.
 *
 * `replaceChildren` throws every child away and rebuilds it, which drops hover,
 * focus and an in-flight click on a node whose content did not change. Here a
 * node already in the right place is left alone, a node in the wrong place is
 * moved (never recreated), and a node no longer wanted is removed.
 */
export function patchChildren(parent: Element, desired: readonly Element[]): void {
  // Drop what is no longer wanted first. Left for the end, a removed node ahead of
  // the rest would make every later node look out of place and be moved.
  const wanted = new Set<Element>(desired)
  let stale = parent.firstElementChild
  while (stale) {
    const next = stale.nextElementSibling
    if (!wanted.has(stale)) stale.remove()
    stale = next
  }
  let cursor = parent.firstElementChild
  for (const node of desired) {
    if (node === cursor) {
      cursor = cursor.nextElementSibling
      continue
    }
    parent.insertBefore(node, cursor)
  }
}
