import { spawn } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
      const executable = realpathSync(candidate)
      paths.push(candidate, executable)
      if (basename(command) === 'go' && basename(dirname(executable)) === 'bin') {
        const toolchain = dirname(dirname(executable))
        // A PATH wrapper named `go` must not turn its grandparent (often HOME)
        // into a read grant. Recognise a real distribution by its compiler,
        // then grant only Go-owned subtrees rather than the whole toolchain root.
        const goArch =
          process.arch === 'x64' ? 'amd64' : process.arch === 'ia32' ? '386' : process.arch
        const compiler = join(toolchain, 'pkg', 'tool', `${process.platform}_${goArch}`, 'compile')
        const containedRuntimePath = (path: string): string | null => {
          if (!lstatSync(path, { throwIfNoEntry: false })) return null
          const canonical = realpathSync(path)
          const rel = relative(toolchain, canonical)
          return rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
            ? null
            : canonical
        }
        const version = containedRuntimePath(join(toolchain, 'VERSION'))
        if (version && containedRuntimePath(compiler)) {
          for (const path of ['bin', 'lib', 'pkg', 'src']) {
            const absolute = join(toolchain, path)
            const canonical = containedRuntimePath(absolute)
            if (canonical) paths.push(absolute, canonical)
          }
          paths.push(join(toolchain, 'VERSION'), version)
        }
      }
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
  /** Private automatic-adapter control; declarations cannot request this grant shape. */
  projectWritable?: boolean
  /** Give automatic Go commands disposable build bookkeeping, never shared writes. */
  goBookkeeping?: boolean
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
  // Some read-only manager checks need temporary bookkeeping. Give each probe
  // private, disposable scratch; never make the project or shared caches writable.
  // Linux read grants are mounted after write grants. A scratch nested under a
  // read-only project would therefore be shadowed by the later project bind.
  const disposableScratch = options.mode === 'preflight' || options.projectWritable === false
  let scratch: string
  if (disposableScratch) {
    const prefix = options.mode === 'preflight' ? 'copse-preflight-' : 'copse-prepare-'
    scratch = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  } else {
    const scratchParent = join(root, '.tmp')
    const candidate = join(scratchParent, 'worktree-preparation')
    for (const path of [scratchParent, candidate]) {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`Preparation scratch must not be a symlink: ${path}`)
      }
    }
    // Linux bwrap only binds write allow-list entries that already exist. Create
    // and canonicalize stable scratch before constructing the writable project's
    // exact bind, rejecting redirected `.tmp` paths before granting access.
    mkdirSync(candidate, { recursive: true })
    scratch = realpathSync(candidate)
    const rel = relative(root, scratch)
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Preparation scratch escaped the worktree: ${scratch}`)
    }
  }
  try {
    return await runContainedPreparationProcess(command, args, options, scratch)
  } finally {
    if (disposableScratch) rmSync(scratch, { recursive: true, force: true })
  }
}

async function runContainedPreparationProcess(
  command: string,
  args: readonly string[],
  options: PreparationProcessOptions,
  scratch: string,
): Promise<string> {
  const root = realpathSync(options.root)
  const caches = preparationCacheRoots(options.env, options.mode === 'prepare')
  const preparing = options.mode === 'prepare'
  const projectWritable = preparing && options.projectWritable !== false
  if (options.goBookkeeping) {
    options.env = {
      ...options.env,
      GOCACHE: join(scratch, 'go-build'),
      GOTMPDIR: scratch,
    }
  }
  const env = withSandboxShellPath(
    withSandboxTmpEnv(envForRendererChildProcess(options.env), scratch),
  )
  // The outer wrapper shell starts before kernel confinement. Never let its
  // startup files execute ambient code before sandbox-exec/bwrap takes over.
  delete env['BASH_ENV']
  delete env['ENV']
  const params = {
    // ASRT's proxy environment overrides spawn.env (including TMPDIR). Set
    // scratch after those assignments, inside the confined command.
    command: formatArgvForShell('/usr/bin/env', [
      `TMPDIR=${scratch}`,
      `TMP=${scratch}`,
      `TEMP=${scratch}`,
      `TMPPREFIX=${join(scratch, 'zsh')}`,
      command,
      ...args,
    ]),
    binShell: '/bin/bash',
    needsNetworkRestriction: options.offline || !preparing,
    allowAllUnixSockets: false,
    allowGitConfig: false,
    readConfig: {
      denyOnly: [homedir(), tmpdir(), '/private/tmp', '/private/var/folders'],
      allowWithinDeny: [
        root,
        scratch,
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
      allowOnly: preparing
        ? ['/dev/null', scratch, ...caches, ...(projectWritable ? [root] : [])]
        : ['/dev/null', scratch],
      denyWithinAllow: [],
      // Package tarballs contain inert .idea/.vscode metadata. Protect the
      // checkout's configuration rather than denying those names in every
      // dependency directory. This override is private to this approved runner.
      // The whole .git path also covers hooks. Emitting both .git/hooks and an
      // absent .git makes bwrap create a directory and then try to mask it as a
      // file, aborting before execution on a fresh Linux project.
      mandatoryDenyPaths: projectWritable
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
      allowLocalBinding: preparing && !options.offline,
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
      const timeout = setTimeout(abort, preparing ? 10 * 60_000 : 5_000)
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
