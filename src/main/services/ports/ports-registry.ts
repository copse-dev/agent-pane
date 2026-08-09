import { scanListeningPorts, readParentMap } from './host-scan.ts'
import { attributePort, type PortOwner } from './process-ancestry.ts'
import { listOwnedProcesses, ownedByPid, type OwnedProcess } from './port-owners.ts'
import type { ListeningPort } from './port-scan.ts'
import { terminatePidTree } from '../exec/subprocess-kill.ts'

/** One row in the Ports panel: a listening port plus who (if anyone) owns it. */
export interface PortRow extends ListeningPort {
  /** The Shells tab or background task this listener descends from, else null. */
  owner: PortOwner | null
  /** Loopback URL to open, or null when the bind address isn't reachable locally. */
  url: string | null
}

/**
 * Bind addresses that mean "reachable on this machine's loopback". A server bound
 * to a specific LAN address gets no URL: the built-in browser auto-allows
 * loopback only, so offering a link we would then have to prompt for — or that
 * resolves to a different machine's interface — is worse than offering none.
 */
const LOOPBACK_ADDRESSES = new Set(['0.0.0.0', '127.0.0.1', '::', '::1', '*', 'localhost', ''])

/** `http://localhost:<port>` when the bind address is loopback or bind-all, else null. */
export function portUrl(port: ListeningPort): string | null {
  if (!LOOPBACK_ADDRESSES.has(port.address)) return null
  return `http://localhost:${String(port.port)}`
}

/**
 * Order for display: ours first (the rows that do something when clicked), then
 * ascending port so the list is stable between refreshes. Scan tools return
 * kernel order, which reshuffles on every poll and makes the panel flicker.
 */
function compareRows(left: PortRow, right: PortRow): number {
  if (!!left.owner !== !!right.owner) return left.owner ? -1 : 1
  return left.port - right.port
}

/**
 * Pure assembly: attribute each scanned port to an owner by climbing the process
 * tree, attach a loopback URL, and sort. Separated from the scan so the
 * interesting logic is testable without running `lsof` or reading `ps`.
 */
export function buildPortRows(
  ports: readonly ListeningPort[],
  parentMap: Map<number, number>,
  owned: readonly OwnedProcess[],
): PortRow[] {
  const byPid = ownedByPid(owned)
  return ports
    .map((port) => ({
      ...port,
      owner: attributePort(port.pid, parentMap, byPid),
      url: portUrl(port),
    }))
    .sort(compareRows)
}

/** What the panel renders: the rows, plus whether we could see the host at all. */
export interface PortScanResult {
  rows: PortRow[]
  /** The scan tool that ran, or null when the host has none — see `scanListeningPorts`. */
  tool: string | null
}

/** Test seam: an e2e-installed row set, so a spec need not depend on the host. */
let seededRows: PortScanResult | null = null

/** Test-only (`COPSE_E2E=1`): serve fixed rows instead of scanning the host. */
export function setSeededPortRows(result: PortScanResult | null): void {
  seededRows = result
}

/** Scan the host and assemble the panel's rows. */
export async function listPortRows(): Promise<PortScanResult> {
  if (seededRows) return seededRows
  const { tool, ports } = await scanListeningPorts()
  if (ports.length === 0) return { rows: [], tool }
  // Only read the process table when there is something to attribute.
  const parentMap = await readParentMap()
  return { rows: buildPortRows(ports, parentMap, listOwnedProcesses()), tool }
}

/**
 * Kill the process listening on `port`, but only when it descends from a Copse
 * process tree. Ownership is re-derived here rather than taken from the caller:
 * the renderer sends a port number, so a stale or forged row can never turn this
 * into "kill any pid on the machine".
 */
export async function killOwnedPort(port: number): Promise<{ killed: boolean; reason?: string }> {
  const { rows } = await listPortRows()
  const row = rows.find((candidate) => candidate.port === port)
  if (!row) return { killed: false, reason: `Nothing is listening on port ${String(port)}.` }
  if (!row.owner) {
    return {
      killed: false,
      reason: `Port ${String(port)} belongs to a process Copse did not start.`,
    }
  }
  if (row.pid === null) {
    return { killed: false, reason: `Could not read the process holding port ${String(port)}.` }
  }
  terminatePidTree(row.pid)
  return { killed: true }
}
