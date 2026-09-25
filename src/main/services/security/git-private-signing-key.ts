import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { workspaceSandboxOverlay } from '../../project-sandbox/config.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import { parseSshPublicKey } from '../../project-sandbox/git-commit-signing.ts'
import { requestApproval } from '../approval.ts'
import { runCommand } from '../exec/command-runner.ts'
import { resolveToolPermission } from './tool-permissions.ts'

const SIGNER = '/usr/bin/ssh-keygen'
const MAX_PRIVATE_KEY_BYTES = 64 * 1024

function sameFile(a: Stats, b: Stats): boolean {
  return (
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode
  )
}

function assertAuthorized(signal?: AbortSignal): void {
  if (
    signal?.aborted ||
    !isProjectSandboxEnabled() ||
    resolveToolPermission('git_commit')?.policy === 'block'
  )
    throw new Error('Git signing authorization changed; request authorization again.')
}

export interface PrivateSigningKey {
  publicKey: string
  privatePaths: string[]
  sign: (payload: Buffer, signal: AbortSignal) => Promise<string>
  release: () => Promise<void>
}

/** Only the isolated signer reads the approved private key, for this commit. */
export async function leaseGitPrivateSigningKey(
  configuredPath: string,
  project: string,
  command: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<PrivateSigningKey> {
  assertAuthorized(signal)
  const source = configuredPath.endsWith('.pub') ? configuredPath.slice(0, -4) : configuredPath
  if (!isAbsolute(source) || normalize(source) !== source)
    throw new Error('SSH signing requires an absolute configured key path.')
  const sourcePath = await realpath(source)
  const before = await lstat(sourcePath)
  if (!before.isFile() || before.size <= 0 || before.size > MAX_PRIVATE_KEY_BYTES)
    throw new Error('The configured SSH signing key is not a bounded regular file.')
  const executableHash = createHash('sha256')
    .update(await readFile(SIGNER))
    .digest('hex')
  const assertIdentity = async (): Promise<void> => {
    if (
      (await realpath(source)) !== sourcePath ||
      !sameFile(before, await lstat(sourcePath)) ||
      executableHash !==
        createHash('sha256')
          .update(await readFile(SIGNER))
          .digest('hex')
    )
      throw new Error(
        'Git signing key changed during approval or signing; request authorization again.',
      )
  }
  const answer = await requestApproval(
    {
      type: 'shell',
      title: 'Allow reading this Git signing key?',
      body: `Private key: ${sourcePath}\nSigner: ${SIGNER}\nProject: ${project}\n\n${command}`,
      bodyAdvice:
        'Allow the system SSH signer to read this private key and sign this commit? Key contents are never sent to the agent. Git hooks keep their existing sandbox access.',
      bodyFooter:
        'Applies to this commit only. Creating or pushing a pull request keeps its separate approval.',
      allowRemember: false,
      subject: command,
      scope: 'git-signing-key',
      cause: 'shell-read-outside-project',
      reasons: [sourcePath, 'one-commit private key consent'],
    },
    signal,
  )
  if (!answer.approved) throw new Error('User rejected reading the SSH signing key.')
  assertAuthorized(signal)
  await assertIdentity()

  const directory = await realpath(await mkdtemp(join(tmpdir(), 'copse-private-sign-')))
  const release = async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true })
  }
  try {
    const sandboxConfig = workspaceSandboxOverlay(directory)
    if (!sandboxConfig.filesystem) throw new Error('Missing private signer sandbox policy')
    sandboxConfig.filesystem.allowRead = [...(sandboxConfig.filesystem.allowRead ?? []), sourcePath]
    sandboxConfig.filesystem.allowWrite = []
    sandboxConfig.filesystem.denyWrite.push(directory, sourcePath)
    const signerEnv = { ...env, HOME: directory, SSH_AUTH_SOCK: undefined }
    const identity = await runCommand(SIGNER, ['-y', '-P', '', '-f', sourcePath], {
      cwd: directory,
      env: signerEnv,
      requireSandbox: true,
      sandboxConfig,
      ...(signal ? { signal } : {}),
      timeout_ms: 5000,
      stdoutMaxBytes: 16384,
    })
    await assertIdentity()
    const publicKey =
      identity.code === 0 && !identity.stdoutTruncated ? parseSshPublicKey(identity.stdout) : null
    if (!publicKey)
      throw new Error(
        'Cannot use this SSH private key. For a passphrase-protected key, load it into ssh-agent and enable scoped SSH signing approvals in Settings → Permissions.',
      )
    return {
      publicKey,
      privatePaths: [source, sourcePath],
      release,
      sign: async (payload, runSignal): Promise<string> => {
        assertAuthorized(runSignal)
        await assertIdentity()
        const result = await runCommand(SIGNER, ['-Y', 'sign', '-n', 'git', '-f', sourcePath], {
          cwd: directory,
          env: signerEnv,
          stdin: payload,
          requireSandbox: true,
          sandboxConfig,
          signal: runSignal,
          timeout_ms: 30000,
          stdoutMaxBytes: 16384,
        })
        await assertIdentity()
        if (
          result.code !== 0 ||
          result.stdoutTruncated ||
          !result.stdout.startsWith('-----BEGIN SSH SIGNATURE-----')
        )
          throw new Error('SSH commit signing failed. No unsigned retry was attempted.')
        return result.stdout
      },
    }
  } catch (error) {
    await release()
    throw error
  }
}
