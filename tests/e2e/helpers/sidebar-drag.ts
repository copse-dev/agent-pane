import { browser } from '@wdio/globals'

/**
 * Drive an HTML5 drag in the real renderer (issue #1685).
 *
 * WebDriver's own `dragAndDrop` moves the pointer; it does **not** start a
 * Chromium drag, so no `dragstart`/`dragover`/`drop` ever fires and a spec built
 * on it would pass whether or not the feature works. Dispatching real
 * `DragEvent`s that share one real `DataTransfer` exercises the production
 * listeners instead — the payload MIME, the drop-side geometry, the indicator,
 * and the store plus config write all run exactly as they do under a mouse.
 *
 * Rows are addressed by the `data-project-id` / `data-group-id` the pane already
 * renders (and re-queries for inline rename), not by a selector added for tests.
 */

/** Which row to grab or drop on, by the id the fixture seeded. */
export type SidebarRowRef = { project: string } | { group: string }

/** Point within the target row: the reorder bands, or a header's nest-into band. */
export type DragWhere = 'top' | 'middle' | 'bottom'

function rowSelector(ref: SidebarRowRef): string {
  return 'project' in ref
    ? `.project-entry[data-project-id="${ref.project}"] > .project-row, ` +
        `.project-entry[data-project-id="${ref.project}"] > .project-line > .project-row`
    : `.project-group[data-group-id="${ref.group}"] > .project-group-row`
}

const DRAG_SCRIPT = `
const [fromSel, toSel, where, holdOnly] = arguments
const from = document.querySelector(fromSel)
const to = document.querySelector(toSel)
if (!from || !to) return false
const rect = to.getBoundingClientRect()
const fraction = where === 'top' ? 0.15 : where === 'bottom' ? 0.85 : 0.5
const clientY = rect.top + rect.height * fraction
const clientX = rect.left + rect.width / 2
const dataTransfer = new DataTransfer()
const fire = (target, type) => {
  target.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }),
  )
}
fire(from, 'dragstart')
fire(to, 'dragover')
if (holdOnly) return true
fire(to, 'drop')
fire(from, 'dragend')
return true
`

async function runDrag(
  from: SidebarRowRef,
  to: SidebarRowRef,
  where: DragWhere,
  holdOnly: boolean,
): Promise<void> {
  const fromSel = rowSelector(from)
  const toSel = rowSelector(to)
  const ran = await browser.execute<boolean, [string, string, string, boolean]>(
    DRAG_SCRIPT,
    fromSel,
    toSel,
    where,
    holdOnly,
  )
  if (!ran) throw new Error(`sidebar drag could not find both rows: ${fromSel} → ${toSel}`)
}

/** Full drag: pick the row up, hover the target, release. */
export function dragSidebarRow(
  from: SidebarRowRef,
  to: SidebarRowRef,
  where: DragWhere,
): Promise<void> {
  return runDrag(from, to, where, false)
}

/**
 * Drag and hold over the target without releasing, leaving the drop indicator
 * painted so a screenshot can show where the row would land.
 */
export function hoverSidebarDrag(
  from: SidebarRowRef,
  to: SidebarRowRef,
  where: DragWhere,
): Promise<void> {
  return runDrag(from, to, where, true)
}

/** Sidebar rows top to bottom as `['Alpha', 'Client work > Gamma', …]`. */
export function readSidebarShape(): Promise<string[]> {
  return browser.execute(() => {
    const nodes = Array.from(document.querySelectorAll('.projects-list > *'))
    return nodes.flatMap((node) => {
      if (node.classList.contains('project-entry')) {
        return [node.querySelector('.project-name')?.textContent ?? '']
      }
      if (!node.classList.contains('project-group')) return []
      const groupName = node.querySelector('.project-group-name')?.textContent ?? ''
      const members = Array.from(node.querySelectorAll('.project-name')).map(
        (name) => `${groupName} > ${name.textContent ?? ''}`,
      )
      return members.length > 0 ? members : [`${groupName} > (empty)`]
    })
  })
}

/** Wait until the sidebar settles into `expected`, reporting what it showed instead. */
export async function waitForSidebarShape(expected: string[]): Promise<void> {
  let seen: string[] = []
  await browser.waitUntil(
    async () => {
      seen = await readSidebarShape()
      return seen.length === expected.length && seen.every((row, i) => row === expected[i])
    },
    {
      timeout: 10_000,
      timeoutMsg: `expected sidebar ${JSON.stringify(expected)}, got ${JSON.stringify(seen)}`,
    },
  )
}
