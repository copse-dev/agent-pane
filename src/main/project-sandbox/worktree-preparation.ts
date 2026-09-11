import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js'
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js'
import { copseCacheDir, copseManagedPreparationCacheDirs } from '../services/storage/copse-paths.ts'
import { envForRendererChildProcess } from '../services/exec/child-process-env.ts'
import { terminateProcessTree } from '../services/exec/subprocess-kill.ts'
import {
  resolveNodeToolchainAllowRead,
  electronRuntimeAllowReadPaths,
  sandboxRuntimeHelperAllowReadPaths,
  workspaceMandatoryWriteDenyPaths,
} from './config.ts'
import { isProjectSandboxEnabled } from './enabled.ts'
import { formatArgvForShell, withSandboxShellPath } from './sandbox-argv.ts'
import { withSandboxTmpEnv } from './tmp-env.ts'

export function requirePreparationSandbox(): void {
  if (!isProjectSandboxEnabled() || !['darwin', 'linux'].includes(process.platform)) {
    throw new Error(
      'Worktree preparation requires an active OS sandbox; no unsandboxed fallback is allowed.',
    )
  }
}

/** Reject redirected cache grants before ASRT can resolve a symlink into a broader write root. */
export function preparationCacheRoots(env: NodeJS.ProcessEnv, create: boolean): string[] {
  const cache = resolve(copseCacheDir(env))
  const paths = [cache, ...copseManagedPreparationCacheDirs(env).map((path) => resolve(path))]
  for (const path of paths) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Preparation cache must not be a symlink: ${path}`)
    }
  }
  // The profile root is host-configured; canonicalize that root, but never a
  // branch-replaceable cache leaf. Its parent is not granted to subprocesses.
  if (create) mkdirSync(dirname(cache), { recursive: true })
  let ancestor = dirname(cache)
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor)
  const parent = resolve(
    realpathSync(ancestor),
    dirname(cache).slice(ancestor.length).replace(/^\//, ''),
  )
  const canonical = paths.map((path) => join(parent, 'cache', path.slice(cache.length)))
  if (create) for (const path of canonical) mkdirSync(path, { recursive: true })
  return canonical.slice(1)
}

/** Executable files and known runtime installations, never the entire user profile. */
function preparationExecutableReadPaths(command: string, env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = []
  for (const candidate of command.includes('/')
    ? [resolve(command)]
    : (env['PATH'] ?? '')
        .split(':')
        .filter(Boolean)
        .map((directory) => join(directory, command))) {
    try {
      paths.push(candidate, realpathSync(candidate))
    } catch {
      /* Not an installed executable. */
    }
  }
  for (const path of [
    '.bun/bin',
    '.cargo/bin',
    '.rustup/toolchains',
    '.pyenv/versions',
    '.local/share/uv/python',
  ]) {
    const absolute = join(homedir(), path)
    if (lstatSync(absolute, { throwIfNoEntry: false })) paths.push(absolute)
  }
  return paths
}

interface PreparationProcessOptions {
  root: string
  env: NodeJS.ProcessEnv
  mode: 'preflight' | 'prepare'
  offline: boolean
  signal?: AbortSignal
  output?: (text: string) => void
  additionalExecutables?: string[]
}

/**
 * Deliberately use ASRT's platform wrappers, not its shared network proxy or
 * optional-sandbox spawn helper. Offline children get no proxy socket/port at
 * all, even while another agent has widened the global network scope. Explicit
 * online preparation gets network access and the SAME narrow filesystem grants.
 * Avoid the manager's implicit writable temp roots as well: scratch is in root.
 */
export async function runWorktreePreparationProcess(
  command: string,
  args: readonly string[],
  options: PreparationProcessOptions,
): Promise<string> {
  requirePreparationSandbox()
  options.signal?.throwIfAborted()
  const root = realpathSync(options.root)
  const caches = preparationCacheRoots(options.env, options.mode === 'prepare')
  const writable = options.mode === 'prepare'
  const env = withSandboxShellPath(
    withSandboxTmpEnv(
      envForRendererChildProcess(options.env),
      join(root, '.tmp', 'worktree-preparation'),
    ),
  )
  // The outer wrapper shell starts before kernel confinement. Never let its
  // startup files execute ambient code before sandbox-exec/bwrap takes over.
  delete env['BASH_ENV']
  delete env['ENV']
  const params = {
    // ASRT's proxy environment overrides spawn.env (including TMPDIR). Set
    // scratch after those assignments, inside the confined command.
    command: formatArgvForShell('/usr/bin/env', [
      `TMPDIR=${join(root, '.tmp', 'worktree-preparation')}`,
      `TMP=${join(root, '.tmp', 'worktree-preparation')}`,
      `TEMP=${join(root, '.tmp', 'worktree-preparation')}`,
      `TMPPREFIX=${join(root, '.tmp', 'worktree-preparation', 'zsh')}`,
      command,
      ...args,
    ]),
    binShell: '/bin/bash',
    needsNetworkRestriction: options.offline || !writable,
    allowAllUnixSockets: false,
    allowGitConfig: false,
    readConfig: {
      denyOnly: [homedir(), tmpdir(), '/private/tmp', '/private/var/folders'],
      allowWithinDeny: [
        root,
        ...caches,
        // Do not let a ~/bin/node layout turn the whole home into a read grant.
        ...resolveNodeToolchainAllowRead(env).filter(
          (path) => path !== homedir() && path !== `${homedir()}/**`,
        ),
        ...electronRuntimeAllowReadPaths(),
        ...preparationExecutableReadPaths(command, env),
        ...(options.additionalExecutables ?? []).flatMap((executable) =>
          preparationExecutableReadPaths(executable, env),
        ),
        ...sandboxRuntimeHelperAllowReadPaths(),
      ],
    },
    writeConfig: {
      allowOnly: writable ? ['/dev/null', root, ...caches] : ['/dev/null'],
      denyWithinAllow: [],
      // Package tarballs contain inert .idea/.vscode metadata. Protect the
      // checkout's configuration rather than denying those names in every
      // dependency directory. This override is private to this approved runner.
      // The whole .git path also covers hooks. Emitting both .git/hooks and an
      // absent .git makes bwrap create a directory and then try to mask it as a
      // file, aborting before execution on a fresh Linux project.
      mandatoryDenyPaths: writable
        ? [
            ...workspaceMandatoryWriteDenyPaths(root).filter(
              (path) => !path.includes('*') && !path.startsWith(`${join(root, '.git')}/`),
            ),
            join(root, '.git'),
          ]
        : [],
    },
  }
  let wrapped: string
  if (process.platform === 'darwin') {
    wrapped = wrapCommandWithSandboxMacOS({
      ...params,
      allowLocalBinding: writable && !options.offline,
    })
  } else {
    wrapped = await wrapCommandWithSandboxLinux({
      ...params,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    })
  }
  try {
    // Recheck after an asynchronous wrap: a disabled sandbox never earns fallback.
    requirePreparationSandbox()
    options.signal?.throwIfAborted()
    const child = spawn('/bin/bash', ['-c', wrapped], {
      cwd: root,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return await new Promise<string>((resolvePromise, reject) => {
      let stdout = ''
      let stderr = ''
      let stopKill: (() => void) | undefined
      const abort = (): void => {
        stopKill ??= terminateProcessTree(child)
      }
      const timeout = setTimeout(abort, writable ? 10 * 60_000 : 5_000)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      child.stdout.on('data', (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-50_000)
        options.output?.(data.toString())
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-50_000)
        options.output?.(data.toString())
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        clearTimeout(timeout)
        stopKill?.()
        options.signal?.removeEventListener('abort', abort)
        if (code === 0 && !options.signal?.aborted && !stopKill) resolvePromise(stdout.trim())
        else
          reject(
            new Error(`${command} failed (${signal ?? String(code)}): ${(stdout + stderr).trim()}`),
          )
      })
    })
  } finally {
    if (process.platform === 'linux') cleanupBwrapMountPoints()
  }
}
