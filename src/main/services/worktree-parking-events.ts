type ParkingRecheck = (threadId: string) => void

let recheck: ParkingRecheck | null = null

export function registerWorktreeParkingRecheck(listener: ParkingRecheck): void {
  recheck = listener
}

/** Resource owners call this after a thread-owned process or terminal is gone. */
export function notifyThreadResourceFinished(threadId: string | null): void {
  if (threadId) recheck?.(threadId)
}
