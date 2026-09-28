import type { AskUserQuestion } from '@copse/agent/ask-user-format.ts'

export interface MobilePrincipal {
  id: string
  label: string
}

export type MobileDecision =
  | { id: string; kind: 'approval'; title: string; body: string; advice?: string; footer?: string }
  | { id: string; kind: 'question'; questions: AskUserQuestion[] }

export type MobileAnswer =
  | { kind: 'approval'; approved: boolean }
  | { kind: 'question'; answers: string[] }

/** Only prompts actually presented by the desktop may be answered remotely. */
export class MobileDecisions {
  private readonly pending = new Map<
    string,
    {
      projectId: string
      threadId: string
      decision: MobileDecision
      answer: (answer: MobileAnswer, device: MobilePrincipal) => void
    }
  >()

  register(
    projectId: string,
    threadId: string,
    decision: MobileDecision,
    answer: (answer: MobileAnswer, device: MobilePrincipal) => void,
  ): () => void {
    const entry = { projectId, threadId, decision, answer }
    this.pending.set(decision.id, entry)
    return () => {
      if (this.pending.get(decision.id) === entry) this.pending.delete(decision.id)
    }
  }

  list(projectId: string, threadId: string): MobileDecision[] {
    return [...this.pending.values()]
      .filter((entry) => entry.projectId === projectId && entry.threadId === threadId)
      .map((entry) => entry.decision)
  }

  respond(
    projectId: string,
    threadId: string,
    id: string,
    answer: MobileAnswer,
    device: MobilePrincipal,
  ): boolean {
    const entry = this.pending.get(id)
    if (
      !entry ||
      entry.projectId !== projectId ||
      entry.threadId !== threadId ||
      entry.decision.kind !== answer.kind
    )
      return false
    if (
      entry.decision.kind === 'question' &&
      answer.kind === 'question' &&
      entry.decision.questions.length !== answer.answers.length
    )
      return false
    // Delete synchronously before the handler settles any promise: the other
    // client cannot answer the same prompt in that intervening microtask.
    this.pending.delete(id)
    entry.answer(answer, device)
    return true
  }
}

export const mobileDecisions = new MobileDecisions()

export function mobileDecisionSource(device: MobilePrincipal): string {
  return `mobile:${device.id} (${device.label})`
}
