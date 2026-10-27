import type { ClientActionOffer, ClientActionReference } from '@shared/client-actions.ts'

/** Only desktop-published offers can be invoked; a client never supplies executable content. */
export class ClientActions {
  private current: {
    owner: number
    offer: ClientActionOffer
    invoke: (reference: ClientActionReference, authorized: () => boolean) => Promise<boolean>
  } | null = null

  publish(
    owner: number,
    offer: ClientActionOffer | null,
    invoke: (reference: ClientActionReference, authorized: () => boolean) => Promise<boolean>,
  ): void {
    this.current = offer ? { owner, offer: structuredClone(offer), invoke } : null
  }

  clear(owner: number): void {
    if (this.current?.owner === owner) this.current = null
  }

  snapshot(): ClientActionOffer | null {
    return this.current ? structuredClone(this.current.offer) : null
  }

  async perform(reference: ClientActionReference, authorized: () => boolean): Promise<boolean> {
    const entry = this.current
    if (
      !entry ||
      !authorized() ||
      entry.offer.projectId !== reference.projectId ||
      entry.offer.threadId !== reference.threadId ||
      entry.offer.revision !== reference.revision ||
      !entry.offer.actions.some((action) => action.id === reference.actionId)
    )
      return false
    // Consume before dispatch: two devices or an unknown-response retry cannot run it twice.
    this.current = null
    return entry.invoke(reference, authorized)
  }
}

export const clientActions = new ClientActions()
