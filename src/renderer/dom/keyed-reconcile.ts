import { patchChildren } from './patch-children.ts'

/**
 * Keyed reconciliation for views that build their DOM imperatively.
 *
 * A view rebuilds its rows from state each time, as before, but marks each row
 * with a stable key and the values its event handlers close over. Then
 * {@link reconcileChildren} puts the fresh rows into the live parent, keeping
 * the existing node wherever the row has not changed. A kept node keeps its
 * hover, focus, scroll position, any drag in progress, and any reference a
 * caller (or a WebDriver session) already holds to it.
 *
 * The rule for keeping a node is deliberately strict, because its listeners
 * stay the ones it was built with:
 *
 * - **Row** ({@link keyed}): kept only when the fresh row has the same key, the
 *   same markup as the live row had when it was built, and the same `deps`
 *   (compared with `===`). `deps` lists what the row's handlers read without
 *   showing it, such as the project or thread object. Anything that changes
 *   the markup or one of those values gets the fresh row and fresh listeners.
 * - **Container** ({@link keyedContainer}): a wrapper with no listeners of its
 *   own. The live container is always kept, its attributes are updated, and
 *   its children are reconciled in turn. That is what lets a row inside a
 *   project block survive a change to another row in the block.
 * - **Unkeyed** elements are always replaced.
 *
 * A handler that holds a reference to a fresh *container* (for example, to
 * mark it as dragging) should resolve it with {@link liveNode} when it runs,
 * because the live container may be an older node.
 */

interface Mark {
  key: string
  container: boolean
  deps: readonly unknown[]
}

const marks = new WeakMap<Element, Mark>()
/** Each live row's markup as it was built, before any runtime change to it. */
const builtMarkup = new WeakMap<Element, string>()
/** A fresh node that was dropped in favour of the live node it matched. */
const adoptedBy = new WeakMap<Element, Element>()

/** Mark `node` as a row identified by `key` among its siblings. */
export function keyed<E extends Element>(node: E, key: string, deps: readonly unknown[] = []): E {
  marks.set(node, { key, container: false, deps })
  return node
}

/**
 * Mark `node` as a listener-free wrapper identified by `key` among its siblings.
 * Its children must all be elements, so they can be reconciled one by one.
 */
export function keyedContainer<E extends Element>(node: E, key: string): E {
  marks.set(node, { key, container: true, deps: [] })
  return node
}

/** The node that is in the document in place of `node`, or `node` itself. */
export function liveNode(node: Element): Element {
  return adoptedBy.get(node) ?? node
}

export interface ReconcileOptions {
  /**
   * Classes that runtime code adds to a container (a drag or drop indicator)
   * and that a render must not remove when it updates the container's
   * attributes.
   */
  transientClasses?: readonly string[]
}

/** Make `parent`'s element children `fresh`, keeping every live node that still matches. */
export function reconcileChildren(
  parent: Element,
  fresh: readonly Element[],
  options: ReconcileOptions = {},
): void {
  const liveByKey = new Map<string, Element>()
  for (const child of Array.from(parent.children)) {
    const mark = marks.get(child)
    if (mark && !liveByKey.has(mark.key)) liveByKey.set(mark.key, child)
  }
  const desired: Element[] = []
  for (const node of fresh) {
    // A node the view keeps across renders (one it did not rebuild) is
    // already where it belongs.
    if (node.parentElement === parent) {
      desired.push(node)
      continue
    }
    const mark = marks.get(node)
    const live = mark ? liveByKey.get(mark.key) : undefined
    const liveMark = live ? marks.get(live) : undefined
    if (mark && live && liveMark) {
      liveByKey.delete(mark.key)
      // A container is always reconciled child by child, even when its markup
      // is unchanged: a row inside it may have new `deps`.
      if (mark.container && liveMark.container && onlyElementChildren(node)) {
        syncAttributes(live, node, options.transientClasses ?? [])
        reconcileChildren(live, Array.from(node.children), options)
        adopt(node, live)
        desired.push(live)
        continue
      }
      if (
        !mark.container &&
        !liveMark.container &&
        builtMarkup.get(live) === node.outerHTML &&
        sameDeps(liveMark.deps, mark.deps)
      ) {
        adopt(node, live)
        desired.push(live)
        continue
      }
    }
    recordBuiltMarkup(node)
    desired.push(node)
  }
  patchChildren(parent, desired)
}

function adopt(fresh: Element, live: Element): void {
  adoptedBy.set(fresh, live)
  const mark = marks.get(fresh)
  if (mark) marks.set(live, mark)
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function onlyElementChildren(node: Element): boolean {
  return node.childNodes.length === node.children.length
}

/** Remember the markup of `node` and of every row inside it, as built. */
function recordBuiltMarkup(node: Element): void {
  for (const candidate of [node, ...Array.from(node.querySelectorAll('*'))]) {
    if (marks.get(candidate)?.container === false) builtMarkup.set(candidate, candidate.outerHTML)
  }
}

function syncAttributes(live: Element, fresh: Element, transientClasses: readonly string[]): void {
  // Read the runtime classes first: the loop below drops `class` when the
  // fresh node has none.
  const kept = transientClasses.filter((name) => live.classList.contains(name))
  for (const { name } of Array.from(live.attributes)) {
    if (name !== 'class' && !fresh.hasAttribute(name)) live.removeAttribute(name)
  }
  for (const { name, value } of Array.from(fresh.attributes)) {
    if (name === 'class') continue
    if (live.getAttribute(name) !== value) live.setAttribute(name, value)
  }
  const next = [
    ...Array.from(fresh.classList),
    ...kept.filter((name) => !fresh.classList.contains(name)),
  ]
  const nextClass = next.join(' ')
  if ((live.getAttribute('class') ?? '') !== nextClass) {
    if (nextClass) live.setAttribute('class', nextClass)
    else live.removeAttribute('class')
  }
}
