/**
 * Who owns a Copse-spawned process tree. Only ports whose owning process
 * descends from one of these are shown as ours (clickable, killable); everything
 * else (system services, the user's other apps) is inert.
 */
export interface PortOwner {
  kind: 'terminal' | 'background'
  /** Terminal session id or background-task id — the handle the UI reveals/kills. */
  id: string
  /** Human label for the row (shell tab name, or the background command). */
  label: string
}

/**
 * Walk `pid`'s ancestry — itself first, then parents — to the nearest owned root.
 * The listening process is usually a grandchild of the shell (`bash` → `npm` →
 * `node`), so a direct pid match isn't enough; we climb until we hit an owned pid
 * or run out. Bounded by `maxDepth` so a bogus/cyclic parent map can't spin.
 */
export function findOwner(
  pid: number,
  parentOf: (pid: number) => number | null,
  ownedByPid: Map<number, PortOwner>,
  maxDepth = 64,
): PortOwner | null {
  let current: number | null = pid
  for (let depth = 0; depth < maxDepth && current !== null && current > 0; depth++) {
    const owner = ownedByPid.get(current)
    if (owner) return owner
    current = parentOf(current)
  }
  return null
}

/**
 * Parse `pid ppid` pairs, one per line, as printed by `ps -Ao pid=,ppid=`
 * (portable across macOS/Linux). Non-numeric / short lines are skipped.
 */
export function parsePsPairs(output: string): Map<number, number> {
  const map = new Map<number, number>()
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 2) continue
    const pid = Number(cols[0])
    const ppid = Number(cols[1])
    if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid)
  }
  return map
}

/** Attribute a scanned port to its owner (or null) by climbing the parent map. */
export function attributePort(
  pid: number | null,
  parentMap: Map<number, number>,
  ownedByPid: Map<number, PortOwner>,
): PortOwner | null {
  if (pid === null) return null
  return findOwner(pid, (id) => parentMap.get(id) ?? null, ownedByPid)
}
