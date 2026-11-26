/**
 * Session-only, thread-scoped grants that let a contained command write the
 * `/tmp` paths it names (`tempWriteTargets`), still inside the project sandbox.
 *
 * In one brevet-card thread most "Run outside sandbox?" prompts left the
 * sandbox only to write a cookie jar or a log under `/tmp`. Answering those by
 * running the whole command outside handed it the network and every other
 * path too. This grant widens the seatbelt to the exact named paths instead,
 * so a covered command keeps no network and no other outside path.
 *
 * Grants die with the process and are never shared between threads. The
 * decision log records the approval and each covered command.
 */
const granted = new Set<string>()

export function grantTempWrites(threadId: string): void {
  granted.add(threadId)
}

export function hasTempWriteGrant(threadId: string): boolean {
  return granted.has(threadId)
}

export function clearTempWriteGrants(): void {
  granted.clear()
}
