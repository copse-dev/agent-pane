/** Failed token attempts in a row that block a peer. */
const MAX_ATTEMPTS = 30
/** How long a blocked peer is refused. */
const BLOCK_MS = 300_000
/** Distinct peers remembered at once. Relayed peers are whatever addresses the relay reports. */
const PEER_LIMIT = 1024

/**
 * Failed device-token attempts per peer: 30 in a row block that peer for five
 * minutes, and a success forgets it. At most 1,024 peers are remembered; a new
 * one past that forgets the earliest remembered.
 */
export class FailedAuthLimiter {
  private readonly peers = new Map<string, { attempts: number; blockedUntil: number }>()

  blocked(peer: string): boolean {
    const prior = this.peers.get(peer)
    return prior !== undefined && prior.blockedUntil > Date.now()
  }

  failed(peer: string): void {
    const prior = this.peers.get(peer)
    const attempts =
      prior?.blockedUntil && prior.blockedUntil < Date.now() ? 1 : (prior?.attempts ?? 0) + 1
    if (!prior && this.peers.size >= PEER_LIMIT) {
      const earliest = this.peers.keys().next()
      if (!earliest.done) this.peers.delete(earliest.value)
    }
    this.peers.set(peer, {
      attempts,
      blockedUntil: attempts >= MAX_ATTEMPTS ? Date.now() + BLOCK_MS : 0,
    })
  }

  succeeded(peer: string): void {
    this.peers.delete(peer)
  }
}
