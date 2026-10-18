import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import {
  electronRuntimeAllowReadPaths,
  workspaceSandboxOverlay,
} from '../../project-sandbox/config.ts'
import { isProjectSandboxEnabled } from '../../project-sandbox/enabled.ts'
import {
  gitCommitSigningSandboxOverlay,
  parseSshPublicKey,
  resolveInlineSshPublicSigningKey,
  resolveSshAgentSocketAllowList,
} from '../../project-sandbox/git-commit-signing.ts'
import { requestApproval } from '../approval.ts'
import { runCommand } from '../exec/command-runner.ts'
import { getAgentProjectRoot } from '../execution-root.ts'
import { nodeWorkerExecutable } from '../node-worker-runtime.ts'
import {
  isActiveSshWorkspace,
  resolveSshExecutionTargetForCwd,
} from '../ssh-workspace/execution-target.ts'
import { getSetting } from '../storage/settings.ts'
import { recordDecision } from './decision-log-store.ts'
import type { GitSigningBridge } from './git-invocation.ts'
import { posixQuote } from './safe-install.ts'
import { resolveToolPermission } from './tool-permissions.ts'
import { leaseGitPrivateSigningKey, type PrivateSigningKey } from './git-private-signing-key.ts'

const SIGNER = '/usr/bin/ssh-keygen'
const MAX_COMMIT_BYTES = 1024 * 1024
const grants = new Map<string, string>()

// Trusted probe, executed with a clean environment and no repository code.
// Only a failed connect(2) with EPERM/EACCES produces 73. Neither Git stderr,
// model hints nor traffic received from the target socket can produce it.
const SOCKET_PROBE = `
const net = require('node:net');
const socket = net.connect(process.argv[1]);
socket.on('connect', () => { socket.destroy(); process.exit(0); });
socket.on('error', e => process.exit(e.code === 'EPERM' || e.code === 'EACCES' ? 73 : 74));
setTimeout(() => process.exit(74), 2000).unref();
`

/** No inherited loader, askpass, agent, credential or provider variables. */
function helperEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(process.env).map((key) => [key, undefined]),
  )
  return { ...env, PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', ELECTRON_RUN_AS_NODE: '1' }
}

async function config(root: string, key: string, path = false): Promise<string | null> {
  const result = await runCommand('git', ['config', ...(path ? ['--path'] : []), '--get', key], {
    cwd: root,
    requireSandbox: true,
  })
  if (result.code === 1) return null
  if (result.code !== 0 || result.stdoutTruncated)
    throw new Error('Cannot inspect Git signing configuration safely.')
  return result.stdout.trim()
}

/** The bridge accepts commit objects, never arbitrary ssh-agent protocol messages. */
export function isGitCommitPayload(payload: Buffer): boolean {
  if (payload.length > MAX_COMMIT_BYTES || payload.includes(0)) return false
  const text = payload.toString('utf8')
  return /^tree [a-f0-9]{40}(?:[a-f0-9]{24})?\n(?:parent [a-f0-9]{40}(?:[a-f0-9]{24})?\n)*author [^\n]+\ncommitter [^\n]+\n(?:encoding [^\n]+\n)?\n/.test(
    text,
  )
}

/**
 * This fixed client runs under Git's original sandbox. It reads Git's signing
 * buffer there; the host never accepts a filesystem path from the client.
 */
function bridgeClient(socketPath: string, nonce: string): string {
  return `
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(1);
if (args.length !== 8 || args[0] !== '-Y' || args[1] !== 'sign' || args[2] !== '-n' || args[3] !== 'git' || args[4] !== '-f' || args[6] !== '-U') process.exit(1);
const input = args[7];
if (!fs.statSync(input).isFile() || fs.statSync(input).size > ${String(MAX_COMMIT_BYTES)}) process.exit(1);
const payload = fs.readFileSync(input);
if (payload.length > ${String(MAX_COMMIT_BYTES)}) process.exit(1);
const socket = net.connect(${JSON.stringify(socketPath)});
let result = Buffer.alloc(0);
socket.on('connect', () => socket.end(Buffer.concat([Buffer.from(${JSON.stringify(nonce + '\n')}), payload])));
socket.on('data', chunk => {
  result = Buffer.concat([result, chunk]);
  if (result.length > 32768) socket.destroy(new Error('Oversized signing response'));
});
socket.on('error', () => process.exit(1));
socket.on('end', () => {
  if (result[0] !== 0) { process.stderr.write(result.subarray(1)); process.exit(1); }
  fs.writeFileSync(input + '.sig', result.subarray(1));
});
socket.setTimeout(60000, () => socket.destroy(new Error('Signing timed out')));
`
}

export interface GitSigningLease {
  signing: GitSigningBridge
  sandboxConfig: Partial<SandboxRuntimeConfig>
  release: () => Promise<void>
}

/**
 * The only elevated helper currently supported is the system SSH signer. Other
 * configured programs still run in Git's ordinary sandbox, without new access.
 * Remembered approvals are in memory and bound to project, configuration,
 * public key, system executable contents and socket identity. No basename grant.
 */
export async function leaseGitSigningBroker(
  root: string,
  signal?: AbortSignal,
  command = 'git_commit',
): Promise<GitSigningLease | null> {
  if (
    process.platform !== 'darwin' ||
    !isProjectSandboxEnabled() ||
    isActiveSshWorkspace() ||
    resolveSshExecutionTargetForCwd(root)
  )
    return null
  const project = await realpath(getAgentProjectRoot() ?? root)
  const useAgent = getSetting<boolean>('gitCommitSshAgentSocketAccess', false)
  if (!useAgent) grants.delete(project)
  const enabled = await runCommand('git', ['config', '--bool', '--get', 'commit.gpgSign'], {
    cwd: root,
    requireSandbox: true,
  })
  const format = await config(root, 'gpg.format')
  const program = await config(root, 'gpg.ssh.program')
  if (
    enabled.stdout.trim() !== 'true' ||
    format !== 'ssh' ||
    (program !== null && program !== 'ssh-keygen' && program !== SIGNER)
  ) {
    grants.delete(project)
    return null
  }
  const keySetting = await config(root, 'user.signingKey')
  const pathKey = keySetting?.startsWith('key::')
    ? keySetting
    : await config(root, 'user.signingKey', true)
  const inline = !useAgent
    ? null
    : pathKey?.startsWith('key::')
      ? pathKey
      : pathKey
        ? await resolveInlineSshPublicSigningKey(pathKey)
        : null
  let publicKey = inline ? parseSshPublicKey(inline.slice(5)) : null
  const privatePath = !useAgent && pathKey && !pathKey.startsWith('key::') ? pathKey : null
  const [configuredSocket] = await resolveSshAgentSocketAllowList({
    enabled: useAgent,
    authSock: process.env['SSH_AUTH_SOCK'],
    platform: process.platform,
  })
  if (!privatePath && (!publicKey || !configuredSocket)) {
    grants.delete(project)
    return null
  }
  const socketPath = configuredSocket ? await realpath(configuredSocket) : ''
  const socketInfo = socketPath ? await stat(socketPath) : null
  const executableHash = createHash('sha256')
    .update(await readFile(SIGNER))
    .digest('hex')
  const identity = JSON.stringify([
    project,
    program,
    keySetting,
    publicKey,
    executableHash,
    socketPath,
    socketInfo?.dev,
    socketInfo?.ino,
  ])
  if (grants.get(project) !== identity) grants.delete(project)
  const keyBlob = publicKey?.split(' ')[1] ?? ''
  const fingerprint =
    'SHA256:' +
    createHash('sha256').update(Buffer.from(keyBlob, 'base64')).digest('base64').replace(/=+$/, '')
  const directory = await mkdtemp('/private/tmp/copse-sign-')
  const peers = new Set<Socket>()
  const controller = new AbortController()
  const runSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const server = createServer({ allowHalfOpen: true })
  let released = false
  let privateKey: PrivateSigningKey | undefined
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    controller.abort()
    for (const peer of peers) peer.destroy()
    if (server.listening)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    try {
      await rm(directory, { recursive: true, force: true })
    } finally {
      await privateKey?.release()
    }
  }
  try {
    if (privatePath) {
      privateKey = await leaseGitPrivateSigningKey(
        resolve(root, privatePath),
        project,
        command,
        helperEnv(directory),
        signal,
      )
      publicKey = privateKey.publicKey
    }
    if (!publicKey) throw new Error('Cannot resolve the configured SSH signing identity.')
    const base = workspaceSandboxOverlay(directory)
    if (!base.filesystem) throw new Error('Missing signer sandbox policy')
    const isolatedFilesystem = {
      ...base.filesystem,
      allowRead: [...(base.filesystem.allowRead ?? []), ...electronRuntimeAllowReadPaths()],
      allowWrite: [],
      denyWrite: [...base.filesystem.denyWrite, directory],
    }
    const isolated: Partial<SandboxRuntimeConfig> = {
      ...base,
      filesystem: isolatedFilesystem,
    }
    const rememberAllowed = resolveToolPermission('git_commit')?.policy !== 'ask'
    if (!privateKey && (!rememberAllowed || grants.get(project) !== identity)) {
      const probe = await runCommand(nodeWorkerExecutable(), ['-e', SOCKET_PROBE, socketPath], {
        cwd: directory,
        env: helperEnv(directory),
        requireSandbox: true,
        sandboxConfig: isolated,
        timeout_ms: 5000,
        signal: runSignal,
      })
      if (probe.code !== 73)
        throw new Error(
          `Cannot verify a sandbox denial for the SSH signing socket; no extra access was granted. Probe exited ${String(probe.code)}: ${probe.stderr.trim().slice(0, 2000)}`,
        )
      const answer = await requestApproval(
        {
          type: 'shell',
          title: 'Allow this Git signing helper?',
          body: `${SIGNER} -Y sign -n git -U\nKey: ${fingerprint}\nSocket: ${socketPath}\nProject: ${project}`,
          bodyAdvice:
            'A sandboxed connection probe was denied. Allow the system SSH signer to use this key for Git commits through this socket? Git hooks keep their existing sandbox access.',
          allowRemember: rememberAllowed,
          rememberLabel:
            'Remember this signer, key and socket for this project until Copse restarts',
          subject: 'git_commit SSH signing',
          scope: 'git-signing-helper',
          cause: 'shell-sandbox-retry',
          reasons: [fingerprint, 'sandboxed socket probe denied'],
        },
        signal,
      )
      if (!answer.approved) throw new Error('User rejected SSH commit signing.')
      if (answer.remember && rememberAllowed) {
        if (grants.size >= 64) grants.clear()
        grants.set(project, identity)
      }
    } else if (!privateKey) {
      recordDecision({
        kind: 'shell',
        actor: 'system',
        verdict: 'allowed',
        subject: 'git_commit SSH signing',
        scope: 'git-signing-helper',
        reasons: [fingerprint],
        source: 'git-signing-helper-grant',
      })
    }
    // Consent cannot revive a stopped sandbox or a changed helper/socket.
    const currentSocket = socketPath ? await stat(socketPath) : null
    if (
      signal?.aborted ||
      !isProjectSandboxEnabled() ||
      (!privateKey && !getSetting<boolean>('gitCommitSshAgentSocketAccess', false)) ||
      resolveToolPermission('git_commit')?.policy === 'block' ||
      currentSocket?.dev !== socketInfo?.dev ||
      currentSocket?.ino !== socketInfo?.ino ||
      executableHash !==
        createHash('sha256')
          .update(await readFile(SIGNER))
          .digest('hex')
    ) {
      grants.delete(project)
      throw new Error('Git signing authorization changed; request authorization again.')
    }
    const keyPath = join(directory, 'key.pub')
    await writeFile(keyPath, publicKey + '\n', { mode: 0o400 })
    const brokerPath = join(directory, 'sign.sock')
    const nonce = randomBytes(32).toString('hex')
    const wrapper = join(directory, 'signer')
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec /usr/bin/env -u NODE_OPTIONS -u NODE_PATH ELECTRON_RUN_AS_NODE=1 ${posixQuote(nodeWorkerExecutable())} -e ${posixQuote(bridgeClient(brokerPath, nonce))} -- "$@"\n`,
      { mode: 0o500 },
    )
    const signOverlay = gitCommitSigningSandboxOverlay(directory, socketPath ? [socketPath] : [])
    signOverlay.filesystem = isolatedFilesystem
    let used = false
    const inContext = AsyncLocalStorage.snapshot()
    server.on('connection', (peer) => {
      if (used || released || peers.size >= 4) {
        peer.destroy()
        return
      }
      peers.add(peer)
      peer.on('close', () => peers.delete(peer))
      peer.on('error', () => {})
      peer.setTimeout(10000, () => peer.destroy())
      let buffer = Buffer.alloc(0)
      peer.on('data', (data: Buffer) => {
        if (buffer.length + data.length > MAX_COMMIT_BYTES + 65) {
          peer.destroy()
          return
        }
        buffer = Buffer.concat([buffer, data])
      })
      peer.on('end', () => {
        const payload = buffer.subarray(65)
        if (
          used ||
          released ||
          buffer.subarray(0, 65).toString() !== nonce + '\n' ||
          !isGitCommitPayload(payload)
        ) {
          peer.destroy()
          return
        }
        used = true
        peer.setTimeout(60000, () => peer.destroy())
        void inContext(async () => {
          try {
            if (privateKey) {
              const signature = await privateKey.sign(payload, runSignal)
              peer.end(Buffer.concat([Buffer.from([0]), Buffer.from(signature)]))
              return
            }
            const current = await stat(socketPath)
            if (
              !getSetting<boolean>('gitCommitSshAgentSocketAccess', false) ||
              resolveToolPermission('git_commit')?.policy === 'block' ||
              current.dev !== socketInfo?.dev ||
              current.ino !== socketInfo.ino
            )
              throw new Error('Signing socket authorization changed.')
            const result = await runCommand(
              SIGNER,
              ['-Y', 'sign', '-n', 'git', '-f', keyPath, '-U'],
              {
                cwd: directory,
                env: { ...helperEnv(directory), SSH_AUTH_SOCK: socketPath },
                stdin: payload,
                requireSandbox: true,
                sandboxConfig: signOverlay,
                signal: runSignal,
                timeout_ms: 30000,
                stdoutMaxBytes: 16384,
              },
            )
            if (
              result.code !== 0 ||
              result.stdoutTruncated ||
              !result.stdout.startsWith('-----BEGIN SSH SIGNATURE-----')
            )
              throw new Error('SSH commit signing failed. No unsigned retry was attempted.')
            peer.end(Buffer.concat([Buffer.from([0]), Buffer.from(result.stdout)]))
          } catch {
            peer.end(
              Buffer.concat([
                Buffer.from([1]),
                Buffer.from('SSH commit signing failed. No unsigned retry was attempted.\n'),
              ]),
            )
          }
        })
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(brokerPath, resolve)
    })
    const gitOverlay = gitCommitSigningSandboxOverlay(root, [brokerPath])
    if (!gitOverlay.filesystem) throw new Error('Missing Git sandbox policy')
    gitOverlay.filesystem.denyRead.push(...(privateKey?.privatePaths ?? []))
    if (pathKey && isAbsolute(pathKey)) {
      const privatePath = pathKey.endsWith('.pub') ? pathKey.slice(0, -4) : pathKey
      gitOverlay.filesystem.denyRead.push(
        privatePath,
        await realpath(privatePath).catch(() => privatePath),
      )
    }
    gitOverlay.filesystem.allowRead = [
      ...(gitOverlay.filesystem.allowRead ?? []),
      directory,
      ...electronRuntimeAllowReadPaths(),
    ]
    gitOverlay.filesystem.denyWrite = [...gitOverlay.filesystem.denyWrite, directory]
    return { signing: { program: wrapper, publicKey }, sandboxConfig: gitOverlay, release }
  } catch (error) {
    await release()
    throw error
  }
}
