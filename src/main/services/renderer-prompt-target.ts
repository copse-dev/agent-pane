/**
 * Which renderer a main-process prompt should appear on.
 *
 * Copse can detach a right-panel pane into its own window, and a prompt raised
 * by work the user started *there* used to open on the main window — the
 * approval for a pop-out's terminal, and the SSH passphrase that terminal then
 * needs, both landed behind a window the user was not looking at (#2507). The
 * SSH case is the sharper one: a host-key confirmation shown away from the
 * connection that asked for it gives the user nothing to judge it against.
 *
 * So the rule is: whoever handles a request from a renderer scopes this to that
 * renderer, and every prompt raised underneath follows. The main window stays
 * the fallback, which is what an agent run gets — chat lives there, and an
 * approval for a tool call belongs over the transcript that asked for it.
 *
 * A leaf module on purpose. Both prompt channels (`approval.ts` and
 * `ssh-workspace/ssh-prompt.ts`) resolve against the same store, so a handler
 * scopes once and does not have to know which kind of prompt its callees raise.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Structurally an Electron `WebContents`, so a `BrowserWindow`'s contents and an
 * IPC event's `sender` both satisfy it and tests can pass a plain object.
 */
export interface RendererPromptTarget {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

const promptTarget = new AsyncLocalStorage<RendererPromptTarget>()

/**
 * Show prompts raised inside `fn` on `sender` rather than the main window.
 *
 * Scope the *whole* handler, not just its permission check: opening an SSH
 * terminal asks twice — once for the unsandboxed/remote approval, then again
 * for a passphrase or host key — and splitting the scope sends the halves to
 * different windows.
 */
export function runWithRendererPromptTarget<T>(sender: RendererPromptTarget, fn: () => T): T {
  return promptTarget.run(sender, fn)
}

/** The target scoped for this context, or `fallback` (normally the main window). */
export function resolveRendererPromptTarget(fallback: RendererPromptTarget): RendererPromptTarget {
  const target = promptTarget.getStore()
  // A pop-out closed while its own prompt was being prepared: fall back rather
  // than send into a destroyed renderer and leave the caller waiting forever.
  if (target && !target.isDestroyed()) return target
  return fallback
}

/**
 * The target scoped right now, or null.
 *
 * For work that leaves this async context before it prompts. The SSH askpass
 * helper is the case that needs it: OpenSSH asks over a unix socket, in a fresh
 * context with no store, so the lease captures the target here and restores it
 * when the question actually arrives.
 */
export function currentRendererPromptTarget(): RendererPromptTarget | null {
  const target = promptTarget.getStore()
  return target && !target.isDestroyed() ? target : null
}
