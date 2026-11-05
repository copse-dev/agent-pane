import { stripVTControlCharacters } from 'node:util'
import { parseSshPublicKey } from '../../project-sandbox/git-commit-signing.ts'
import type { CommandResult } from '../exec/command-runner.ts'

const MAX_DIAGNOSTIC_LENGTH = 2048

function diagnostic(text: string): string {
  return stripVTControlCharacters(text).replaceAll('\0', '').trim().slice(0, MAX_DIAGNOSTIC_LENGTH)
}

/** A missing key can offer consent; a failed identity query cannot. */
export function sshAgentHasSigningKey(result: CommandResult, publicKey: string): boolean {
  if (
    !result.stdoutTruncated &&
    result.code === 1 &&
    [result.stdout.trim(), result.stderr.trim()].includes('The agent has no identities.')
  )
    return false
  if (result.code !== 0 || result.stdoutTruncated)
    throw new Error(
      `Cannot inspect SSH signing identities (ssh-add exited ${String(result.code)}${result.stdoutTruncated ? ', output truncated' : ''}). ${diagnostic(result.stderr)}`,
    )
  const keys = result.stdout.trim().split('\n').map(parseSshPublicKey)
  if (keys.some((key) => key === null))
    throw new Error('Cannot inspect SSH signing identities: invalid public-key response.')
  return keys.includes(publicKey)
}

/** Keep signer diagnostics, never its stdout (which may contain key or signature material). */
export function sshCommitSignature(result: CommandResult): string {
  if (
    result.code === 0 &&
    !result.stdoutTruncated &&
    result.stdout.startsWith('-----BEGIN SSH SIGNATURE-----')
  )
    return result.stdout

  const reason =
    result.code !== 0
      ? `ssh-keygen exited with code ${String(result.code)}.`
      : result.stdoutTruncated
        ? 'ssh-keygen returned a truncated signature.'
        : 'ssh-keygen did not return an SSH signature.'
  const stderr = diagnostic(result.stderr)
  const advice = stderr.includes("Couldn't find key in agent")
    ? ' Load the matching signing key into the SSH agent used by Copse, then retry the signed commit.'
    : ''
  throw new Error(`${reason}${stderr ? `\n${stderr}` : ''}${advice}`)
}

/** The broker response is bounded well below the client's 32 KiB limit. */
export function gitSigningFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? diagnostic(error.message) : ''
  return `SSH commit signing failed. No unsigned retry was attempted.${detail ? `\n${detail}` : ''}\n`
}
