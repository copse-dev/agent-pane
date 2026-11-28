import { errorMessage } from './errors.ts'

/**
 * Name of the error main throws when an SSH thread's prompt cannot go to its
 * host: a turn still holds the thread there, or the copies here and there went
 * apart. Electron carries only an invoke rejection's text over IPC, so the
 * renderer finds the refusal by this name, as it does a busy thread's.
 */
export const SSH_THREAD_REFUSED_ERROR_NAME = 'SshThreadRefused'

export class SshThreadRefused extends Error {
  override readonly name = SSH_THREAD_REFUSED_ERROR_NAME
}

/** The refusal's own words when `reason` is one, in-process or across IPC; else null. */
export function sshThreadRefusal(reason: unknown): string | null {
  if (reason instanceof Error && reason.name === SSH_THREAD_REFUSED_ERROR_NAME)
    return reason.message
  const text = errorMessage(reason)
  const at = text.indexOf(`${SSH_THREAD_REFUSED_ERROR_NAME}: `)
  return at < 0 ? null : text.slice(at + SSH_THREAD_REFUSED_ERROR_NAME.length + 2)
}
