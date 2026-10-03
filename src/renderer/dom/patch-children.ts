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
  let cursor = parent.firstElementChild
  for (const node of desired) {
    if (node === cursor) {
      cursor = cursor.nextElementSibling
      continue
    }
    parent.insertBefore(node, cursor)
  }
  while (cursor) {
    const next = cursor.nextElementSibling
    cursor.remove()
    cursor = next
  }
}
