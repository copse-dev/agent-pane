/**
 * Checks on the SSH destination (host and user) that Copse places on the ssh
 * command line. OpenSSH reads an argument that starts with `-` as an option,
 * so a host or user of that shape would change how ssh runs rather than where
 * it connects. Whitespace and control characters never belong in a host name.
 *
 * Shared by the transport (which refuses at connect) and by the host form and
 * ssh config import (which refuse at entry).
 */

// ASCII C0 controls and DEL.
const ASCII_CONTROL_RE = /[\u0000-\u001f\u007f]/

export function hasAsciiControlCharacter(value: string): boolean {
  return ASCII_CONTROL_RE.test(value)
}

/** Whether ssh would read this value as an option if it began an argument. */
export function readsAsSshOption(value: string): boolean {
  return value.startsWith('-')
}

export interface SshDestinationProblem {
  field: 'host' | 'user'
  message: string
}

/**
 * The first reason `host` and `user` cannot form an ssh destination, or null.
 * `host` is checked trimmed, as the transport uses it, and may carry its own
 * `user@` prefix; the name after the last `@` is checked as well.
 */
export function sshDestinationProblem(
  host: string,
  user: string | undefined,
): SshDestinationProblem | null {
  const target = host.trim()
  const hostname = target.slice(target.lastIndexOf('@') + 1)
  if (!hostname) return { field: 'host', message: 'Host is required.' }
  if (/\s/.test(target) || hasAsciiControlCharacter(target)) {
    return { field: 'host', message: 'Host cannot contain spaces or control characters.' }
  }
  if (readsAsSshOption(target) || readsAsSshOption(hostname)) {
    return { field: 'host', message: 'Host cannot start with “-”; ssh would read it as an option.' }
  }
  if (user) {
    if (readsAsSshOption(user)) {
      return {
        field: 'user',
        message: 'User cannot start with “-”; ssh would read it as an option.',
      }
    }
    if (hasAsciiControlCharacter(user)) {
      return { field: 'user', message: 'User cannot contain control characters.' }
    }
  }
  return null
}
