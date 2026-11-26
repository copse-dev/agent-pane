import { randomUUID } from 'node:crypto'
import type { RendererPromptTarget } from '../renderer-prompt-target.ts'
import type { SshPromptRequest, SshPromptResponse } from './ssh-prompt.ts'

/** Main owns expiry; renderer dismissal follows the exact request and owner. */
export class SshPromptLifecycle {
  private readonly pending = new Map<string, (result: SshPromptResponse) => void>()

  request(req: SshPromptRequest, dest: RendererPromptTarget): Promise<SshPromptResponse> {
    if (dest.isDestroyed()) return Promise.resolve({ value: '' })
    return new Promise((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        this.settle(id, { value: '' })
      }, 60_000)
      timer.unref()
      this.pending.set(id, (result) => {
        clearTimeout(timer)
        try {
          if (!dest.isDestroyed()) dest.send('ssh-prompt:dismissed', id)
        } finally {
          resolve(result)
        }
      })
      try {
        dest.send('ssh:prompt-request', { ...req, id })
      } catch {
        this.settle(id, { value: '' })
      }
    })
  }

  settle(id: string, result: SshPromptResponse): void {
    const resolve = this.pending.get(id)
    if (!resolve) return
    this.pending.delete(id)
    // A renderer can disappear between the isDestroyed check and send.
    try {
      resolve(result)
    } catch {
      // The promise was settled in the callback's finally block.
    }
  }

  cancelAll(): void {
    for (const id of this.pending.keys()) this.settle(id, { value: '' })
  }
}
