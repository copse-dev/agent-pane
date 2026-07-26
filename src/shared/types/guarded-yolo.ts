export type GuardedYoloPhase = 'off' | 'armed' | 'active'
export type GuardedYoloContainment = 'project-sandbox' | 'unsandboxed'

export interface GuardedYoloState {
  threadId: string
  phase: GuardedYoloPhase
  containment: GuardedYoloContainment
  expiresAt: number | null
}
