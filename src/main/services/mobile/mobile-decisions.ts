import {
  humanDecisions,
  type HumanDecisions,
  type HumanDecision as MobileDecision,
  type HumanDecisionAnswer as MobileAnswer,
  type HumanDecisionPrincipal as MobilePrincipal,
} from '../human-decisions.ts'

export type { MobileDecision, MobileAnswer, MobilePrincipal }

/** Only prompts actually presented by the desktop may be answered remotely. */
export class MobileDecisions {
  private readonly decisions: HumanDecisions

  constructor(decisions: HumanDecisions) {
    this.decisions = decisions
  }

  list(projectId: string, threadId: string): MobileDecision[] {
    return this.decisions
      .snapshot()
      .requests.filter((entry) => entry.projectId === projectId && entry.threadId === threadId)
      .map((entry) => entry.decision)
  }

  respond(
    projectId: string,
    threadId: string,
    id: string,
    answer: MobileAnswer,
    device: MobilePrincipal,
  ): boolean {
    // Mobile's existing wire contract uses fresh UUIDs for prompts. Resolve its current
    // revision synchronously; new transports must round-trip the full displayed reference.
    const snapshot = this.decisions.snapshot()
    const entry = snapshot.requests.find((request) => request.decision.id === id)
    if (!entry) return false
    return this.decisions.respond(
      {
        sessionId: snapshot.sessionId,
        projectId,
        threadId,
        requestId: id,
        revision: entry.revision,
      },
      answer,
      device,
    )
  }
}

export const mobileDecisions = new MobileDecisions(humanDecisions)

export function mobileDecisionSource(device: MobilePrincipal): string {
  return `mobile:${device.id} (${device.label})`
}
