/**
 * Executable design spike with no direct Electron dependencies.
 * Only the trusted host owns the broker/session lifecycle. Agents receive a port.
 * No filesystem, provider, permission, scheduler, or execution dependencies.
 */
import { randomUUID } from 'node:crypto'

export const LIMITS = {
  sessions: 32,
  paths: 16,
  pathLength: 256,
  noteLength: 1_024,
  notesPerRun: 4,
  inbox: 8,
  leaseMs: 120_000,
  events: 2_048,
} as const

/** Host-verified identities, never accepted as model tool arguments. */
export interface Participant {
  threadId: string
  runId: string
  /** Explicitly approved repository + disclosure boundary; not a remote URL. */
  scopeId: string
  /** Identifies the physical checkout, even when threads use different cwd paths. */
  checkoutId: string
  /** Host consent for exchanging notes with this scope's selected providers. */
  optedIn: boolean
}

export interface Collision {
  id: string
  peerThreadId: string
  paths: string[]
  risk: 'shared-checkout' | 'merge-conflict'
}

export interface PeerNote {
  id: string
  collisionId: string
  fromThreadId: string
  fromRunId: string
  toRunId: string
  paths: string[]
  text: string
  trust: 'untrusted-peer-context'
  authority: 'none'
  autoDispatch: false
}

export interface AgentPort {
  /** Replace a short-lived advisory write intent; [] releases it. Not a lock. */
  claim(paths: string[]): void
  inspect(): Collision[]
  send(collisionId: string, text: string): string
  /** Explicit tool result only. Never injects, aborts, resumes, or starts a turn. */
  poll(): PeerNote[]
}

export interface Session {
  port: AgentPort
  /** Host-only stop/revoke, called when the originating run ends. */
  stop(): void
}

export interface RecordEntry {
  sequence: number
  kind: 'joined' | 'claimed' | 'matched' | 'sent' | 'received' | 'dropped' | 'stopped'
  runId: string
  detail: unknown
}

interface State {
  participant: Participant
  paths: string[]
  expiresAt: number
  revision: number
  notesSent: number
  inbox: PeerNote[]
  active: boolean
}

interface Match {
  id: string
  left: State
  right: State
  leftRevision: number
  rightRevision: number
  paths: string[]
}

/**
 * Strict logical repository paths. Production must additionally use the workspace
 * guard's canonical file identity (symlinks/case/hard links), before calling this.
 */
function validatePaths(paths: string[]): string[] {
  if (paths.length > LIMITS.paths) throw new Error('Too many claimed paths')
  for (const path of paths) {
    if (
      path.length === 0 ||
      path.length > LIMITS.pathLength ||
      /[\\:*?[\]{}\x00-\x1f\x7f]/u.test(path) ||
      path.startsWith('~') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error('Use exact repository-relative file paths without aliases or globs')
    }
  }
  return [...new Set(paths)].sort()
}

export class CoordinationBroker {
  #states: State[] = []
  #matches = new Map<string, Match>()
  #records: RecordEntry[] = []
  #now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.#now = now
  }

  /** Host API, intentionally absent from AgentPort. IDs must be fresh per run. */
  join(participant: Participant): Session {
    if (!participant.optedIn) throw new Error('Coordination requires host consent')
    if (this.#states.length >= LIMITS.sessions) throw new Error('Prototype session limit reached')
    if (
      this.#states.some(
        (state) =>
          state.participant.runId === participant.runId ||
          (state.active && state.participant.threadId === participant.threadId),
      )
    ) {
      throw new Error('Run IDs cannot be reused; stop the previous thread run first')
    }
    const state: State = {
      participant: { ...participant },
      paths: [],
      expiresAt: 0,
      revision: 0,
      notesSent: 0,
      inbox: [],
      active: true,
    }
    this.#record('joined', state, participant)
    this.#states.push(state)
    return {
      port: {
        claim: (paths): void => {
          this.#claim(state, paths)
        },
        inspect: () => this.#inspect(state),
        send: (id, text) => this.#send(state, id, text),
        poll: () => this.#poll(state),
      },
      stop: (): void => {
        if (!state.active) return
        // Revoke even if the prototype's in-memory journal is full.
        state.active = false
        state.inbox = []
        this.#record('stopped', state, {})
      },
    }
  }

  /** Host-only journal; agents cannot enumerate other tasks or their transcripts. */
  records(): RecordEntry[] {
    return structuredClone(this.#records)
  }

  #record(kind: RecordEntry['kind'], state: State, detail: unknown): void {
    if (this.#records.length >= LIMITS.events) throw new Error('Prototype journal full')
    this.#records.push({
      sequence: this.#records.length + 1,
      kind,
      runId: state.participant.runId,
      detail: structuredClone(detail),
    })
  }

  #assertActive(state: State): void {
    if (!state.active) throw new Error('Run stopped; coordination capability revoked')
  }

  #live(state: State): boolean {
    return state.active && state.expiresAt > this.#now()
  }

  #claim(state: State, paths: string[]): void {
    this.#assertActive(state)
    const validated = validatePaths(paths)
    this.#record('claimed', state, { paths: validated })
    // An identical live renewal preserves the match; expiration/replacement
    // revokes old capabilities, even if the same paths are claimed again later.
    if (!this.#live(state) || JSON.stringify(validated) !== JSON.stringify(state.paths)) {
      state.revision++
    }
    state.paths = validated
    state.expiresAt = this.#now() + LIMITS.leaseMs
  }

  #valid(match: Match): boolean {
    return (
      this.#live(match.left) &&
      this.#live(match.right) &&
      match.left.revision === match.leftRevision &&
      match.right.revision === match.rightRevision
    )
  }

  #inspect(state: State): Collision[] {
    this.#assertActive(state)
    for (const [id, match] of this.#matches) {
      if (!this.#valid(match)) this.#matches.delete(id)
    }
    if (!this.#live(state)) return []
    const collisions: Collision[] = []
    for (const peer of this.#states) {
      if (
        peer === state ||
        !this.#live(peer) ||
        peer.participant.scopeId !== state.participant.scopeId
      ) {
        continue
      }
      const paths = state.paths.filter((path) => peer.paths.includes(path))
      if (paths.length === 0) continue
      let match = [...this.#matches.values()].find(
        (item) =>
          (item.left === state && item.right === peer) ||
          (item.left === peer && item.right === state),
      )
      if (!match) {
        match = {
          id: randomUUID(),
          left: state,
          right: peer,
          leftRevision: state.revision,
          rightRevision: peer.revision,
          paths,
        }
        this.#record('matched', state, {
          collisionId: match.id,
          peerRunId: peer.participant.runId,
          paths,
        })
        this.#matches.set(match.id, match)
      }
      collisions.push({
        id: match.id,
        peerThreadId: peer.participant.threadId,
        paths: [...paths],
        risk:
          state.participant.checkoutId === peer.participant.checkoutId
            ? 'shared-checkout'
            : 'merge-conflict',
      })
    }
    return collisions
  }

  #send(state: State, collisionId: string, text: string): string {
    this.#assertActive(state)
    const match = this.#matches.get(collisionId)
    if (!match || !this.#valid(match) || (match.left !== state && match.right !== state)) {
      throw new Error('No current overlapping work for this capability')
    }
    if (!text.trim() || text.length > LIMITS.noteLength) throw new Error('Invalid note length')
    if (state.notesSent >= LIMITS.notesPerRun) throw new Error('Run message budget reached')
    const recipient = match.left === state ? match.right : match.left
    if (recipient.inbox.length >= LIMITS.inbox) throw new Error('Recipient inbox full')
    const note: PeerNote = {
      id: randomUUID(),
      collisionId,
      fromThreadId: state.participant.threadId,
      fromRunId: state.participant.runId,
      toRunId: recipient.participant.runId,
      paths: [...match.paths],
      text,
      trust: 'untrusted-peer-context',
      authority: 'none',
      autoDispatch: false,
    }
    // Record before making the note deliverable; failures never send silently.
    this.#record('sent', state, note)
    recipient.inbox.push(note)
    state.notesSent++
    return note.id
  }

  #poll(state: State): PeerNote[] {
    this.#assertActive(state)
    // Do not partially consume an inbox if the journal cannot record the batch.
    if (this.#records.length + state.inbox.length > LIMITS.events) {
      throw new Error('Prototype journal full')
    }
    const delivered: PeerNote[] = []
    while (state.inbox.length > 0) {
      const note = state.inbox[0]
      if (!note) break
      const match = this.#matches.get(note.collisionId)
      if (match && this.#valid(match)) {
        this.#record('received', state, { noteId: note.id, fromRunId: note.fromRunId })
        delivered.push(structuredClone(note))
      } else {
        this.#record('dropped', state, { noteId: note.id, reason: 'stale-run-or-intent' })
      }
      state.inbox.shift()
    }
    return delivered
  }
}
